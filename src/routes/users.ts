import { OpenAPIRoute, Path, Query, Enumeration } from '@cloudflare/itty-router-openapi';
import { error } from '../utils/error';
import { AuthedRequest } from '../types';

export class CreateUser extends OpenAPIRoute {
	static schema = {
		summary: 'Create a new user',
		description: 'Create a new user',
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

	async handle(request: AuthedRequest, env: any, ctx: any, data: { body: { username: string } }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}

export class CreateToken extends OpenAPIRoute {
	static schema = {
		summary: 'Create a new token',
		description: 'Create a new token',
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
			'500': {
				description: 'Internal server error',
				schema: {
					error: String,
					message: String,
				},
			},
		},
	};

	async handle(request: AuthedRequest, env: any, ctx: any, data: { params: { id: string } }) {
		return error(500, { error: 'Not Implemented', message: 'Not Implemented' });
	}
}
