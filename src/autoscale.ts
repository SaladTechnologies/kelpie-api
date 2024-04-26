import { Env, DBScalingRule } from './types';
import { listScalingRules } from './db/scaling-rules';
import { countActiveAndRecentlyActiveJobsInContainerGroup } from './db/jobs';
import { getContainerGroupByName, setContainerGroupReplicas, startContainerGroup, stopContainerGroup } from './utils/salad';

export async function evaluateAllScalingRules(env: Env) {
	const rules = await listScalingRules(env);
	console.log(`Found ${rules.length} scaling rules`);

	// Evaluate the rules batches of 5
	for (let i = 0; i < rules.length; i += 5) {
		await Promise.all(rules.slice(i, i + 5).map((rule) => evaluateScalingRule(env, rule)));
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

	await setReplicasForContainerGroup(env, constrainedNumJobs, rule.org_name, rule.project_name, rule.container_group_name);
}

export async function setReplicasForContainerGroup(
	env: Env,
	numReplicas: number,
	orgName: string,
	projectName: string,
	containerGroupName: string
) {
	const group = await getContainerGroupByName(env, orgName, projectName, containerGroupName);
	if (!group) {
		console.log('Container group not found');
		return;
	}

	console.log(`Setting replicas for container group ${containerGroupName} to ${numReplicas}`);

	if (numReplicas === 0 && group.current_state.status === 'running') {
		console.log(`Stopping container group ${containerGroupName}`);
		await stopContainerGroup(env, orgName, projectName, containerGroupName);
		return;
	} else if (numReplicas > 0 && group.current_state.status === 'stopped') {
		console.log(`Starting container group ${containerGroupName}`);
		await startContainerGroup(env, orgName, projectName, containerGroupName);
	}

	await setContainerGroupReplicas(env, orgName, projectName, containerGroupName, numReplicas);
}
