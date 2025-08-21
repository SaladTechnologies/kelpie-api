import { Env, DBScalingRule } from './types';
import { listScalingRules, deleteScalingRuleByContainerGroupID } from './db/scaling-rules';
import { countActiveAndRecentlyActiveJobsInContainerGroup } from './db/jobs';
import { getContainerGroupByName, setContainerGroupReplicas, startContainerGroup, stopContainerGroup } from './utils/salad';

export async function evaluateAllScalingRules(env: Env) {
	const rules = await listScalingRules(env);
	console.log(`Found ${rules.length} scaling rules`);

	const maxConcurrentScalingRules = parseInt(env.MAX_CONCURRENT_SCALING_RULES) || 5;
	// Evaluate the rules batches of maxConcurrentScalingRules
	for (let i = 0; i < rules.length; i += maxConcurrentScalingRules) {
		await Promise.all(rules.slice(i, i + maxConcurrentScalingRules).map((rule) => evaluateScalingRule(env, rule)));
	}
}

export async function evaluateScalingRule(env: Env, rule: DBScalingRule) {
	const numJobs = await countActiveAndRecentlyActiveJobsInContainerGroup(
		rule.container_group_id,
		rule.max_replicas,
		rule.idle_threshold_seconds,
		env
	);
	const constrainedNumJobs = Math.min(rule.max_replicas, Math.max(rule.min_replicas, numJobs));
	try {
		console.log(
			`Evaluating scaling rule ${rule.container_group_id} for container group ${rule.org_name}/${rule.project_name}/${rule.container_group_name}: ${numJobs} jobs, constrained to ${constrainedNumJobs} replicas`
		);
		await setReplicasForContainerGroup(
			env,
			constrainedNumJobs,
			rule.org_name,
			rule.project_name,
			rule.container_group_name,
			rule.container_group_id
		);
	} catch (error) {
		console.error(`Error evaluating scaling rule ${rule.container_group_id}: ${error}`);
	}
}

export async function setReplicasForContainerGroup(
	env: Env,
	numReplicas: number,
	orgName: string,
	projectName: string,
	containerGroupName: string,
	containerGroupID: string
) {
	const group = await getContainerGroupByName(env, orgName, projectName, containerGroupName);
	if (!group) {
		console.log(`Container group not found: ${orgName}/${projectName}/${containerGroupName}. Cleaning up scaling rule.`);
		await deleteScalingRuleByContainerGroupID(env, containerGroupID);
		return;
	}

	console.log(`Setting replicas for container group ${orgName}/${projectName}/${containerGroupName} to ${numReplicas}`);

	if (numReplicas === 0 && group.current_state.status === 'running') {
		console.log(`Stopping container group ${orgName}/${projectName}/${containerGroupName}`);
		await stopContainerGroup(env, orgName, projectName, containerGroupName);
		return;
	} else if (numReplicas === 0) {
		return;
	} else if (numReplicas > 0 && group.current_state.status === 'stopped') {
		console.log(`Starting container group ${orgName}/${projectName}/${containerGroupName}`);
		await startContainerGroup(env, orgName, projectName, containerGroupName);
	}

	await setContainerGroupReplicas(env, orgName, projectName, containerGroupName, numReplicas);
}
