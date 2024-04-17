import { OpenAPIRouter, OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { Env } from './types';
import { createCors } from 'itty-router';
import { error } from './utils/error';
import { validateAuth } from './middleware';

const router = OpenAPIRouter({
	schema: {
		info: {
			title: 'Sisyphus Job Runner API',
			description: 'API for running long jobs on Salad',
			version: '0.0.1',
		},
	},
});
const { preflight, corsify } = createCors({
	methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

router.all('*', preflight);
router.all('*', validateAuth);

class CatchAll extends OpenAPIRoute {
	static schema = {
		summary: 'Catch All',
		description: 'Catch all for unmatched routes',
		responses: {
			'404': {
				description: 'Not Found',
				schema: {
					error: String,
				},
			},
		},
	};

	async handle(request: Request, env: Env) {
		return error(404, { error: 'Route Not Found' });
	}
}

router.all('*', CatchAll);

export default {
	fetch: async (request: Request, env: Env, ctx: any) => {
		return router.handle(request, env, ctx).then(corsify);
	},
};
