import { OpenAPIRouter, OpenAPIRoute } from '@cloudflare/itty-router-openapi';
import { Env } from './types';
import { createCors } from 'itty-router';
import { error } from './utils/error';
import { validateAuth, adminOnly } from './middleware';
import {
	CreateJob,
	GetJob,
	GetWork,
	CancelJob,
	ReportJobCompleted,
	ReportJobFailure,
	JobHeartbeat,
	ListJobs,
	ClearJobs,
} from './routes/jobs';
import { CreateUser, CreateToken, ClearUsers } from './routes/users';
import {
	CreateScalingRule,
	UpdateScalingRule,
	ClearScalingRules,
	ListScalingRules,
	GetScalingRule,
	DeleteScalingRule,
} from './routes/scaling-rules';
import { evaluateAllScalingRules } from './autoscale';

const router = OpenAPIRouter({
	schema: {
		info: {
			title: '🐶 Kelpie Job Runner API',
			description: 'API for running long jobs on Salad',
			version: '0.2.0',
		},
	},
});

const { preflight, corsify } = createCors({
	methods: ['GET', 'POST', 'DELETE'],
});

router.all('*', preflight);
router.all('*', validateAuth);
router.registry.registerComponent('securitySchemes', 'apiKey', {
	type: 'apiKey',
	in: 'header',
	name: 'X-Kelpie-Key',
});

router.post('/jobs', CreateJob);
router.get('/jobs', ListJobs);
router.get('/jobs/:id', GetJob);
router.delete('/jobs/:id', CancelJob);
router.get('/work', GetWork);
router.post('/jobs/:id/completed', ReportJobCompleted);
router.post('/jobs/:id/failed', ReportJobFailure);
router.post('/jobs/:id/heartbeat', JobHeartbeat);

router.post('/scaling-rules', CreateScalingRule);
router.patch('/scaling-rules/:id', UpdateScalingRule);
router.get('/scaling-rules', ListScalingRules);
router.get('/scaling-rules/:id', GetScalingRule);
router.delete('/scaling-rules/:id', DeleteScalingRule);

router.delete('/jobs', adminOnly, ClearJobs);
router.post('/users', adminOnly, CreateUser);
router.post('/users/:id/token', adminOnly, CreateToken);
router.delete('/users', adminOnly, ClearUsers);
router.delete('/scaling-rules', adminOnly, ClearScalingRules);

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

	scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
		return evaluateAllScalingRules(env);
	},
};
