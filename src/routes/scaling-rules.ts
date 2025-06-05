import { OpenAPIRoute, DataOf, Path } from '@cloudflare/itty-router-openapi';
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
	deleteScalingRuleByContainerGroupID,
	deleteScalingRuleByUserAndContainerGroupID,
	ScalingRuleInsert,
} from '../db/scaling-rules';
import { getContainerGroupByID } from '../utils/salad';

export class CreateScalingRule extends OpenAPIRoute {
	static schema = {
		summary: 'Create a new scaling rule',
		description: 'Create a new scaling rule',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
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
		const { userId, saladOrg, saladProject } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		if (!saladOrg || !saladProject) {
			return error(400, { error: 'Org and Project Required', message: 'No org or project found' });
		}

		const containerGroup = await getContainerGroupByID(env, body.container_group_id, saladOrg, saladProject);
		if (!containerGroup) {
			return error(400, { error: 'Container Group Not Found', message: 'No container group found for ID' });
		}

		try {
			const ruleToInsert: ScalingRuleInsert = {
				...body,
				user_id: userId,
				org_name: saladOrg,
				project_name: saladProject,
				container_group_name: containerGroup.name,
			};
			const rule = await createScalingRule(env, ruleToInsert);
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
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		parameters: {
			id: Path(String, { description: 'Container Group ID', required: true }),
		},
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

		body.container_group_id = data.params.id;

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
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
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
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
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

export class GetScalingRule extends OpenAPIRoute {
	static schema = {
		summary: 'Get a scaling rule',
		description: 'Get a scaling rule',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		parameters: {
			id: Path(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Scaling rule found',
				schema: APIScalingRuleResponseSchema,
			},
			'404': {
				description: 'Scaling rule not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: DataOf<typeof GetScalingRule.schema>) {
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		const { id } = data.params;

		let rule;
		if (userId === env.ADMIN_ID) {
			rule = await getScalingRuleByContainerGroupID(id, env);
		} else {
			rule = await getScalingRuleByUserAndContainerGroupID(userId, id, env);
		}

		if (!rule) {
			return error(404, { error: 'Scaling Rule Not Found', message: 'No scaling rule found for container group ID' });
		}

		return rule;
	}
}

export class DeleteScalingRule extends OpenAPIRoute {
	static schema = {
		summary: 'Delete a scaling rule',
		description: 'Delete a scaling rule',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		parameters: {
			id: Path(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'204': {
				description: 'Scaling rule deleted',
			},
			'400': {
				description: 'Invalid request',
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
	async handle(request: AuthedRequest, env: Env, ctx: any, data: DataOf<typeof DeleteScalingRule.schema>) {
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		const { id } = data.params;

		try {
			if (userId === env.ADMIN_ID) {
				await deleteScalingRuleByContainerGroupID(env, id);
			} else {
				await deleteScalingRuleByUserAndContainerGroupID(env, userId, id);
			}
			return new Response(null, { status: 204 });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}
