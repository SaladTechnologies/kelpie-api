import { OpenAPIRoute, Path, Query, Enumeration } from '@cloudflare/itty-router-openapi';
import { error } from '../utils/error';
import {
	APIJobSubmissionSchema,
	APIJobResponseSchema,
	APIJobSubmission,
	AuthedRequest,
	SaladData,
	Env,
	DBJob,
	APIJobResponse,
	SaladDataSchema,
} from '../types';
import {
	createNewJob,
	getJobByUserAndId,
	getJobByID,
	getHighestPriorityJob,
	updateJobStatus,
	updateJobHeartbeat,
	getFailedAttempts,
	incrementFailedAttempts,
	listJobsWithArbitraryFilter,
} from '../utils/db';
import { reallocateInstance, getContainerGroupByID } from '../utils/salad';

export class CreateJob extends OpenAPIRoute {
	static schema = {
		summary: 'Queue a new job',
		description: 'Queue a new job',
		requestBody: APIJobSubmissionSchema,
		responses: {
			'202': {
				description: 'Job created',
				schema: APIJobResponseSchema,
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { body: APIJobSubmission }) {
		const { body } = data;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			const jobToInsert: DBJob = {
				id: crypto.randomUUID(),
				user_id: userId,
				status: 'pending',
				num_failures: 0,
				...body,
				arguments: JSON.stringify(body.arguments),
			};
			if (!jobToInsert.input_prefix.endsWith('/')) {
				jobToInsert.input_prefix += '/';
			}
			if (!jobToInsert.checkpoint_prefix.endsWith('/')) {
				jobToInsert.checkpoint_prefix += '/';
			}
			if (!jobToInsert.output_prefix.endsWith('/')) {
				jobToInsert.output_prefix += '/';
			}

			const job = await createNewJob(jobToInsert, env);
			if (!job || !job.created) {
				return error(500, { error: 'Internal server error', message: 'Failed to create job' });
			}

			const jobToReturn: APIJobResponse = {
				...job,
				created: new Date(job.created),
				arguments: JSON.parse(job.arguments),
			};

			return new Response(JSON.stringify(jobToReturn), {
				status: 202,
				headers: {
					'Content-Type': 'application/json',
				},
			});
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class GetJob extends OpenAPIRoute {
	static schema = {
		summary: 'Get a job',
		description: 'Get a job by ID',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Job found',
				schema: APIJobResponseSchema,
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { params: { id: string } }) {
		const { id } = data.params;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			let job;
			if (userId == env.ADMIN_ID) {
				job = await getJobByID(id, env);
			} else {
				job = await getJobByUserAndId(userId, id, env);
			}
			if (!job || !job.created) {
				return error(404, { error: 'Not Found', message: 'Job not found' });
			}

			const jobToReturn: APIJobResponse = {
				...job,
				created: new Date(job.created),
				arguments: JSON.parse(job.arguments),
			};

			return jobToReturn;
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class GetWork extends OpenAPIRoute {
	static schema = {
		summary: 'Get work',
		description: 'Get a job to work on',
		parameters: {
			machine_id: Query(String, { description: 'Machine ID', required: true }),
			container_group_id: Query(String, { description: 'Container Group ID', required: true }),
		},
		responses: {
			'200': {
				description: 'Job found',
				schema: APIJobResponseSchema.array(),
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { query: SaladData }) {
		const { machine_id, container_group_id } = data.query;
		const { userId, saladOrg, saladProject } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			let num_tries = 0;
			while (num_tries < parseInt(env.MAX_FAILURES_PER_WORKER)) {
				const job = await getHighestPriorityJob(env, userId, container_group_id, num_tries);
				if (!job || !job.created) {
					return [];
				}
				const isBanned = await env.banned_workers.get(`${machine_id}:${job.id}`);
				if (isBanned) {
					num_tries++;
					continue;
				}
				await updateJobStatus(job.id, userId, machine_id, 'running', env);
				fireWebhook(env, request.headers.get(env.API_HEADER) || '', job.id, userId, machine_id, container_group_id, 'running');
				return [
					{
						...job,
						created: new Date(job.created),
						arguments: JSON.parse(job.arguments),
					},
				];
			}

			// If we get here, we've tried too many times
			// Reallocate the instance, asynchronously
			getContainerGroupByID(env, container_group_id, saladOrg!, saladProject!).then((containerGroup) => {
				if (containerGroup) {
					reallocateInstance(env, saladOrg!, saladProject!, containerGroup.name, machine_id);
				}
			});

			return [];
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class JobHeartbeat extends OpenAPIRoute {
	static schema = {
		summary: 'Job heartbeat',
		description: 'Update the heartbeat for a job',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		requestBody: SaladDataSchema,
		responses: {
			'200': {
				description: 'Job heartbeat updated',
				schema: {
					status: new Enumeration({
						values: ['pending', 'running', 'completed', 'canceled', 'failed'],
						description: 'Job status',
					}),
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { params: { id: string }; body: SaladData }) {
		const { id } = data.params;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			const currentStatus = await updateJobHeartbeat(id, userId, env);
			return { status: currentStatus };
		} catch (e: any) {
			if (e.message === 'Job not found') {
				return error(404, { error: 'Not Found', message: 'Job not found' });
			}
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ReportJobFailure extends OpenAPIRoute {
	static schema = {
		summary: 'Report job failure',
		description: 'Report a job failure',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		requestBody: SaladDataSchema,
		responses: {
			'202': {
				description: 'Job failure reported',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { params: { id: string }; body: SaladData }) {
		const { id } = data.params;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			const currentFailureCount = await getFailedAttempts(id, userId, env);
			if (currentFailureCount === null) {
				return error(404, { error: 'Not Found', message: 'Job not found' });
			}
			await env.banned_workers.put(`${data.body.machine_id}:${id}`, 'true');
			if (currentFailureCount + 1 >= parseInt(env.MAX_FAILED_ATTEMPTS)) {
				await Promise.all([updateJobStatus(id, userId, data.body.machine_id, 'failed', env), incrementFailedAttempts(id, userId, env)]);
				fireWebhook(
					env,
					request.headers.get(env.API_HEADER) || '',
					id,
					userId,
					data.body.machine_id,
					data.body.container_group_id,
					'failed'
				);
			} else {
				await incrementFailedAttempts(id, userId, env);
			}
			return new Response(JSON.stringify({ message: 'Failure reported' }), {
				status: 202,
				headers: {
					'Content-Type': 'application/json',
				},
			});
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

async function fireWebhook(
	env: Env,
	apiToken: string,
	jobId: string,
	userId: string,
	machineId: string,
	containerGroupId: string,
	status: string
) {
	const job = await getJobByUserAndId(userId, jobId, env);
	if (job && job.webhook) {
		try {
			const resp = await fetch(job.webhook, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					[env.API_HEADER]: apiToken,
				},
				body: JSON.stringify({
					status,
					job_id: jobId,
					machine_id: machineId,
					container_group_id: containerGroupId,
				}),
			});
			if (!resp.ok) {
				console.log('Failed to send webhook', resp.status, await resp.text());
			}
		} catch (e: any) {
			console.log('Failed to send webhook', e);
		}
	}
}

export class ReportJobCompleted extends OpenAPIRoute {
	static schema = {
		summary: 'Report job completed',
		description: 'Report a job completed',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		requestBody: SaladDataSchema,
		responses: {
			'200': {
				description: 'Job completed reported',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { params: { id: string }; body: SaladData }) {
		const { id } = data.params;
		const { userId } = request;
		const { machine_id, container_group_id } = data.body;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			await updateJobStatus(id, userId, machine_id, 'completed', env);
			fireWebhook(env, request.headers.get(env.API_HEADER) || '', id, userId, machine_id, container_group_id, 'completed');
			return { message: 'Completed reported' };
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class CancelJob extends OpenAPIRoute {
	static schema = {
		summary: 'Cancel job',
		description: 'Cancel a job',
		parameters: {
			id: Path(String, { description: 'Job ID', required: true }),
		},
		responses: {
			'202': {
				description: 'Job canceled',
				schema: {
					message: String,
				},
			},
			'400': {
				description: 'Invalid request',
				schema: {
					error: String,
					message: String,
				},
			},
			'404': {
				description: 'Job not found',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { params: { id: string }; body: SaladData }) {
		const { id } = data.params;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			await updateJobStatus(id, userId, 'user', 'canceled', env);
			return { message: 'Job canceled' };
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ListJobs extends OpenAPIRoute {
	static schema = {
		summary: 'List jobs',
		description: 'List your jobs',
		parameters: {
			status: Query(
				new Enumeration({ description: 'Job status', values: ['pending', 'running', 'completed', 'canceled', 'failed'], required: false })
			),
			container_group_id: Query(String, { description: 'Container Group ID', required: false }),
			page_size: Query(Number, { description: 'Page size', default: 100, required: false }),
			page: Query(Number, { description: 'Page number', default: 1, required: false }),
			asc: Query(Boolean, { description: 'Sort ascending', default: false, required: false }),
		},
		responses: {
			'200': {
				description: 'Jobs found',
				schema: {
					_count: Number,
					jobs: APIJobResponseSchema.array(),
				},
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

	async handle(
		request: AuthedRequest,
		env: Env,
		ctx: any,
		data: {
			query: {
				status?: string;
				container_group_id?: string;
				page_size: number;
				page: number;
				asc: boolean;
			};
		}
	) {
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		const filter: any = {};
		if (userId !== env.ADMIN_ID) {
			filter.user_id = userId;
		}
		if (data.query.status) {
			filter.status = data.query.status;
		}
		if (data.query.container_group_id) {
			filter.container_group_id = data.query.container_group_id;
		}

		try {
			console.log(filter);
			const jobs = await listJobsWithArbitraryFilter(filter, data.query.asc, data.query.page_size, data.query.page, env);
			return {
				_count: jobs.length,
				jobs: jobs.map((job) => ({
					...job,
					created: new Date(job.created!),
					arguments: JSON.parse(job.arguments),
				})),
			};
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}
