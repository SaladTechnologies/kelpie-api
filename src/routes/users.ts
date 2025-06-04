import { OpenAPIRoute, Path } from '@cloudflare/itty-router-openapi';
import { error } from '../utils/error';
import { AuthedRequest, Env, UserResponseSchema } from '../types';
import { createUser, getUserById, getUserByUsername, clearAllNonAdminUsers } from '../db/users';

export class CreateUser extends OpenAPIRoute {
	static schema = {
		summary: '(ADMIN) Create a new user',
		description: 'Create a new user',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		requestBody: {
			username: String,
		},
		responses: {
			'201': {
				description: 'User created',
				schema: {
					id: String,
					username: String,
					created: Date,
				},
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { body: { username: string } }) {
		const { username } = data.body;
		try {
			let user = await getUserByUsername(env, username);
			if (user) {
				return error(400, { error: 'User exists', message: 'User exists' });
			}
			const userId = await createUser(env, username);
			user = await getUserById(env, userId);
			return new Response(JSON.stringify(user), { status: 201, headers: { 'Content-Type': 'application/json' } });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class CreateToken extends OpenAPIRoute {
	static schema = {
		summary: '(ADMIN) Create a new token',
		description: 'Create a new token',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		parameters: {
			id: Path(String, { description: 'User ID', required: true }),
		},
		requestBody: {
			org_name: String,
			project_name: String,
		},
		responses: {
			'201': {
				description: 'Token created',
				schema: {
					token: String,
				},
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
			'404': {
				description: 'Not found',
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

	async handle(
		request: AuthedRequest,
		env: Env,
		ctx: any,
		data: { params: { id: string }; body: { org_name: string; project_name: string } }
	) {
		const { id } = data.params;
		const { org_name, project_name } = data.body;
		try {
			const user = await getUserById(env, id);
			if (!user) {
				return error(404, { error: 'User not found', message: 'User not found' });
			}
			// Create token
			const token = crypto.randomUUID();
			const val = `${id}|${org_name}|${project_name}`;
			await env.user_tokens.put(token, val);
			return new Response(JSON.stringify({ token }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ClearUsers extends OpenAPIRoute {
	static schema = {
		summary: '(ADMIN) Clear all users',
		description: 'Clear all users',
		security: [{ apiKey: [] }],
		responses: {
			'204': {
				description: 'Users cleared',
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
		try {
			await clearAllNonAdminUsers(env);
			return new Response(null, { status: 204 });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class GetUser extends OpenAPIRoute {
	static schema = {
		summary: 'Get the logged in user',
		description: 'Get the logged in user',
		security: [{ apiKey: [], jwt: [], saladApiKey: [] }],
		responses: {
			'200': {
				description: 'User found',
				schema: UserResponseSchema,
			},
			'403': {
				description: 'Forbidden',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'User not found',
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
		if (!request.userId) {
			// Theoretically, this should never happen because the middleware should always set userId
			// but just in case, we return a 403 error.
			console.log('User ID not found in request');
			return error(403, { error: 'Forbidden', message: 'User not authenticated' });
		}
		try {
			const user = await getUserById(env, request.userId);
			if (!user) {
				return error(404, { error: 'User not found', message: 'User not found' });
			}
			return user;
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}
