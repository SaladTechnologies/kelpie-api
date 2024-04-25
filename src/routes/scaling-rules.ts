import { OpenAPIRoute, DataOf } from '@cloudflare/itty-router-openapi';
import { error } from '../utils/error';
import { AuthedRequest, Env, APIScalingRuleSchema, APIScalingRuleResponseSchema } from '../types';
import {
	createScalingRule,
	getScalingRuleByContainerGroupID,
	getScalingRuleByUserAndContainerGroupID,
	clearAllScalingRules,
	updateScalingRuleByContainerGroupID,
	updateScalingRuleByUserAndContainerGroupID,
	listScalingRules,
	listScalingRulesByUserId,
} from '../db/scaling-rules';

export class CreateScalingRule extends OpenAPIRoute {
	static schema = {
		summary: 'Create a new scaling rule',
		description: 'Create a new scaling rule',
		security: [{ apiKey: [] }],
		requestBody: APIScalingRuleSchema,
		responses: {
			'201': {
				description: 'Scaling rule created',
				schema: APIScalingRuleResponseSchema,
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'403': {
				description: 'Forbidden',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: Env, ctx: any, data: DataOf<typeof CreateScalingRule.schema>) {
		const { body } = data;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		try {
			const rule = await createScalingRule(env, body, userId);
			if (!rule) {
				return error(500, { error: 'Internal server error', message: 'Failed to create scaling rule' });
			}
			return new Response(JSON.stringify(rule), { status: 201, headers: { 'Content-Type': 'application/json' } });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class UpdateScalingRule extends OpenAPIRoute {
	static schema = {
		summary: 'Update an existing scaling rule',
		description: 'Update an existing scaling rule',
		security: [{ apiKey: [] }],
		requestBody: APIScalingRuleSchema.partial(),
		responses: {
			'200': {
				description: 'Scaling rule updated',
				schema: APIScalingRuleResponseSchema,
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'403': {
				description: 'Forbidden',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: Env, ctx: any, data: DataOf<typeof UpdateScalingRule.schema>) {
		const { body } = data;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		if (!body.container_group_id) {
			return error(400, { error: 'Container Group ID Required', message: 'No container group ID found' });
		}

		let rule;
		if (userId === env.ADMIN_ID) {
			rule = await updateScalingRuleByContainerGroupID(env, body);
		} else {
			rule = await updateScalingRuleByUserAndContainerGroupID(env, body, userId);
		}

		if (!rule) {
			return error(404, { error: 'Scaling Rule Not Found', message: 'No scaling rule found for container group ID' });
		}

		return rule;
	}
}

export class ClearScalingRules extends OpenAPIRoute {
	static schema = {
		summary: '(ADMIN) Clear all scaling rules',
		description: 'Clear all scaling rules',
		security: [{ apiKey: [] }],
		responses: {
			'204': {
				description: 'Scaling rules cleared',
			},
			'403': {
				description: 'Forbidden',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: Env, ctx: any) {
		if (request.userId !== env.ADMIN_ID) {
			return error(403, { error: 'Forbidden', message: 'Only admins can clear all scaling rules' });
		}

		try {
			await clearAllScalingRules(env);
			return new Response(null, { status: 204 });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ListScalingRules extends OpenAPIRoute {
	static schema = {
		summary: 'List all scaling rules',
		description: 'List all scaling rules',
		security: [{ apiKey: [] }],
		responses: {
			'200': {
				description: 'Scaling rules listed',
				schema: {
					_count: Number,
					rules: [APIScalingRuleResponseSchema],
				},
			},
			'403': {
				description: 'Forbidden',
				schema: {
					error: String,
					message: String,
				},
			},
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: Env, ctx: any) {
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		if (userId === env.ADMIN_ID) {
			const rules = await listScalingRules(env);
			return { _count: rules.length, rules };
		} else {
			const rules = await listScalingRulesByUserId(env, userId);
			return { _count: rules.length, rules };
		}
	}
}
