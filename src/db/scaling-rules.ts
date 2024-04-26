import { Env, DBScalingRule, APIScalingRule, APIScalingRuleUpdate } from '../types';

export type ScalingRuleInsert = {
	user_id: string;
	container_group_id: string;
	org_name: string;
	project_name: string;
	container_group_name: string;
	min_replicas: number;
	max_replicas: number;
	idle_threshold_seconds: number;
};

export async function createScalingRule(env: Env, rule: ScalingRuleInsert): Promise<DBScalingRule | null> {
	const keys = Object.keys(rule);
	const columns = keys.join(', ');
	const placeholders = keys.map((k) => '?').join(', ');
	const values = Object.values(rule);
	let insertStatement = `INSERT INTO ScalingRules ( ${columns}) VALUES (${placeholders})`;
	await env.DB.prepare(insertStatement)
		.bind(...values)
		.run();
	return getScalingRuleByContainerGroupID(rule.container_group_id, env);
}

export async function getScalingRuleByContainerGroupID(containerGroupId: string, env: Env): Promise<DBScalingRule | null> {
	const { results } = await env.DB.prepare('SELECT * FROM ScalingRules WHERE container_group_id = ?').bind(containerGroupId).all();
	if (!results.length) {
		return null;
	}
	const scalingRule = results[0] as unknown as DBScalingRule;
	return scalingRule;
}

export async function getScalingRuleByUserAndContainerGroupID(
	userId: string,
	containerGroupId: string,
	env: Env
): Promise<DBScalingRule | null> {
	const { results } = await env.DB.prepare('SELECT * FROM ScalingRules WHERE container_group_id = ? AND user_id = ?')
		.bind(containerGroupId, userId)
		.all();
	if (!results.length) {
		return null;
	}
	const scalingRule = results[0] as unknown as DBScalingRule;
	return scalingRule;
}

export async function deleteScalingRuleByContainerGroupID(env: Env, containerGroupId: string): Promise<void> {
	await env.DB.prepare('DELETE FROM ScalingRules WHERE container_group_id = ?').bind(containerGroupId).run();
}

export async function deleteScalingRuleByUserAndContainerGroupID(env: Env, userId: string, container_group_id: string): Promise<void> {
	await env.DB.prepare('DELETE FROM ScalingRules WHERE container_group_id = ? AND user_id = ?').bind(container_group_id, userId).run();
}

export async function clearAllScalingRules(env: Env): Promise<void> {
	await env.DB.prepare('DELETE FROM ScalingRules').run();
}

export async function updateScalingRuleByContainerGroupID(env: Env, rule: APIScalingRuleUpdate): Promise<DBScalingRule | null> {
	const { container_group_id, ...rest } = rule;
	if (!container_group_id) {
		throw new Error('Container Group ID Required');
	}
	const keys = Object.keys(rest);
	if (keys.length === 0) {
		throw new Error('No fields to update');
	}
	const values = Object.values(rest);
	const placeholders = keys.map((k) => `${k} = ?`).join(', ');
	await env.DB.prepare(`UPDATE ScalingRules SET ${placeholders}, updated = datetime("now") WHERE container_group_id = ?`)
		.bind(...values, container_group_id)
		.run();
	return getScalingRuleByContainerGroupID(container_group_id, env);
}

export async function updateScalingRuleByUserAndContainerGroupID(
	env: Env,
	rule: APIScalingRuleUpdate,
	userId: string
): Promise<DBScalingRule | null> {
	const { container_group_id, ...rest } = rule;
	if (!container_group_id) {
		throw new Error('Container Group ID Required');
	}
	const keys = Object.keys(rest);
	if (keys.length === 0) {
		throw new Error('No fields to update');
	}
	const values = Object.values(rest);
	const placeholders = keys.map((k) => `${k} = ?`).join(', ');
	await env.DB.prepare(`UPDATE ScalingRules SET ${placeholders}, updated = datetime("now") WHERE container_group_id = ? AND user_id = ?`)
		.bind(...values, container_group_id, userId)
		.run();
	return getScalingRuleByUserAndContainerGroupID(userId, container_group_id, env);
}

export async function listScalingRules(env: Env): Promise<DBScalingRule[]> {
	const { results } = await env.DB.prepare('SELECT * FROM ScalingRules').all<DBScalingRule>();
	return results;
}

export async function listScalingRulesByUserId(env: Env, userId: string): Promise<DBScalingRule[]> {
	const { results } = await env.DB.prepare('SELECT * FROM ScalingRules WHERE user_id = ?').bind(userId).all<DBScalingRule>();
	return results;
}
