import { Env, DBScalingRule, SaladContainerGroup } from './types';
import { listScalingRules as listScalingRulesFromDB } from './db/scaling-rules';
import { countActiveAndRecentlyActiveJobsInContainerGroup as countJobsFromDB } from './db/jobs';
import {
	getContainerGroupByName as getContainerGroupFromSalad,
	setContainerGroupReplicas as setReplicasInSalad,
	startContainerGroup as startContainerGroupInSalad,
	stopContainerGroup as stopContainerGroupInSalad,
} from './utils/salad';

export type AutoscaleDependencies = {
	listScalingRules: typeof listScalingRulesFromDB;
	countActiveAndRecentlyActiveJobsInContainerGroup: typeof countJobsFromDB;
	getContainerGroupByName: typeof getContainerGroupFromSalad;
	setContainerGroupReplicas: typeof setReplicasInSalad;
	startContainerGroup: typeof startContainerGroupInSalad;
	stopContainerGroup: typeof stopContainerGroupInSalad;
};

const defaultDependencies: AutoscaleDependencies = {
	listScalingRules: listScalingRulesFromDB,
	countActiveAndRecentlyActiveJobsInContainerGroup: countJobsFromDB,
	getContainerGroupByName: getContainerGroupFromSalad,
	setContainerGroupReplicas: setReplicasInSalad,
	startContainerGroup: startContainerGroupInSalad,
	stopContainerGroup: stopContainerGroupInSalad,
};

export async function evaluateAllScalingRules(env: Env, dependencies: AutoscaleDependencies = defaultDependencies) {
	const rules = await dependencies.listScalingRules(env);
	console.log(`Found ${rules.length} scaling rules`);

	const maxConcurrentScalingRules = parseInt(env.MAX_CONCURRENT_SCALING_RULES) || 5;
	// Evaluate the rules batches of maxConcurrentScalingRules
	for (let i = 0; i < rules.length; i += maxConcurrentScalingRules) {
		const batch = rules.slice(i, i + maxConcurrentScalingRules);
		// allSettled, not all: one rule failing (e.g. a D1 hiccup) must not abort
		// evaluation of every other rule in the batch, or every rule behind it.
		const results = await Promise.allSettled(batch.map((rule) => evaluateScalingRule(env, rule, dependencies)));
		results.forEach((result, idx) => {
			if (result.status === 'rejected') {
				// evaluateScalingRule catches its own errors, so this is a defense-in-depth
				// backstop for anything that slips past it (e.g. a throw before the try).
				console.error(`Unhandled error evaluating scaling rule ${batch[idx].container_group_id}: ${result.reason}`);
			}
		});
	}
}

export async function evaluateScalingRule(env: Env, rule: DBScalingRule, dependencies: AutoscaleDependencies = defaultDependencies) {
	try {
		// Check that the service account can still see the group before paying for
		// the D1 count. A genuine deletion and a permissions-related 404 are
		// indistinguishable, so either result must remain non-destructive.
		const group = await dependencies.getContainerGroupByName(
			env,
			rule.org_name,
			rule.project_name,
			rule.container_group_name
		);
		if (!group) {
			logMissingContainerGroup(rule.org_name, rule.project_name, rule.container_group_name, rule.container_group_id);
			return;
		}
		if (group.id !== rule.container_group_id) {
			logMismatchedContainerGroup(rule.org_name, rule.project_name, rule.container_group_name, rule.container_group_id);
			return;
		}

		const numJobs = await dependencies.countActiveAndRecentlyActiveJobsInContainerGroup(
			rule.container_group_id,
			rule.max_replicas,
			rule.idle_threshold_seconds,
			env
		);
		const constrainedNumJobs = Math.min(rule.max_replicas, Math.max(rule.min_replicas, numJobs));
		console.log(
			`Evaluating scaling rule ${rule.container_group_id} for container group ${rule.org_name}/${rule.project_name}/${rule.container_group_name}: ${numJobs} jobs, constrained to ${constrainedNumJobs} replicas`
		);
		await setReplicasForKnownContainerGroup(
			env,
			constrainedNumJobs,
			rule.org_name,
			rule.project_name,
			rule.container_group_name,
			group,
			dependencies
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
	containerGroupID: string,
	dependencies: AutoscaleDependencies = defaultDependencies
) {
	/**
	 * This function returns without scaling if it gets a 404 from the API. That 404 is ambiguous:
	 * it fires both when the container group has genuinely been deleted, and when the
	 * Kelpie service account (env.SALAD_API_KEY, not the caller's own key) simply isn't
	 * a member of this org, which the Salad API cannot distinguish from "does not exist"
	 * for security reasons. Deleting the user's scaling rule on a single such response
	 * destroys their configuration on what may be an access problem, not an actual
	 * deletion, and there's no retry backing this up (fetchWithRetries treats 404 as
	 * terminal). So we no longer auto-delete here: we log loudly and skip this cycle,
	 * leaving the rule intact. A container group that really was deleted just stops
	 * being evaluated usefully, at the cost of a wasted lookup every 5 minutes, and
	 * requires the rule to be removed via DELETE /scaling-rules/:id.
	 */
	const group = await dependencies.getContainerGroupByName(env, orgName, projectName, containerGroupName);
	if (!group) {
		logMissingContainerGroup(orgName, projectName, containerGroupName, containerGroupID);
		return;
	}
	if (group.id !== containerGroupID) {
		logMismatchedContainerGroup(orgName, projectName, containerGroupName, containerGroupID);
		return;
	}

	await setReplicasForKnownContainerGroup(env, numReplicas, orgName, projectName, containerGroupName, group, dependencies);
}

function logMissingContainerGroup(orgName: string, projectName: string, containerGroupName: string, containerGroupID: string) {
	console.error(
		`Container group lookup returned 404 for ${orgName}/${projectName}/${containerGroupName} (rule ${containerGroupID}). ` +
			`This may mean the container group was deleted, or that the Kelpie service account is not a member of this org. ` +
			`Skipping this evaluation cycle without deleting the scaling rule.`
	);
}

function logMismatchedContainerGroup(
	orgName: string,
	projectName: string,
	containerGroupName: string,
	containerGroupID: string
) {
	console.error(
		`Container group identity did not match scaling rule ${containerGroupID} for ${orgName}/${projectName}/${containerGroupName}. ` +
			`Skipping this evaluation cycle without changing the replacement container group.`
	);
}

async function setReplicasForKnownContainerGroup(
	env: Env,
	numReplicas: number,
	orgName: string,
	projectName: string,
	containerGroupName: string,
	group: SaladContainerGroup,
	dependencies: AutoscaleDependencies
) {
	console.log(`Setting replicas for container group ${orgName}/${projectName}/${containerGroupName} to ${numReplicas}`);

	if (numReplicas === 0 && group.current_state.status === 'running') {
		console.log(`Stopping container group ${orgName}/${projectName}/${containerGroupName}`);
		await dependencies.stopContainerGroup(env, orgName, projectName, containerGroupName);
		return;
	} else if (numReplicas === 0) {
		return;
	} else if (numReplicas > 0 && group.current_state.status === 'stopped') {
		console.log(`Starting container group ${orgName}/${projectName}/${containerGroupName}`);
		await dependencies.startContainerGroup(env, orgName, projectName, containerGroupName);
	}

	await dependencies.setContainerGroupReplicas(env, orgName, projectName, containerGroupName, numReplicas);
}
