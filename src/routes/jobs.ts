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
	batchCreateNewJobs,
	getJobByUserAndId,
	getJobByID,
	getHighestPriorityJob,
	updateJobStatus,
	updateJobHeartbeat,
	incrementFailedAttempts,
	listJobsWithArbitraryFilter,
	clearJobs,
} from '../db/jobs';
import { reallocateInstance, getContainerGroupByID } from '../utils/salad';

const queueJobDocs = `
Queue a new job to be executed by the specified container group. [Get your Container Group ID](https://docs.salad.com/reference/get_container_group)

Note that although we use the term "AWS S3 bucket" in the documentation, you can use any S3-compatible storage provider.
In particular, we recommend choosing a provider with no egress fees, such as [Cloudflare R2.](https://www.cloudflare.com/developer-platform/r2/)

You must use either the \`sync\` object or the \`input_bucket\`, \`input_prefix\`, \`checkpoint_bucket\`, \`checkpoint_prefix\`, \`output_bucket\`, and \`output_prefix\` fields.
You may not use both.

**Body**

| Key                 | Type     | Description        | Default |
|---------------------|----------|--------------------|---------|
| \`command\`           | string   | The command to execute. | **required** |
| \`arguments\`         | array    | List of arguments for the command. | [] |
| \`environment\`       | object   | Key-value pairs defining the environment variables. | {} |
| \`input_bucket\`      | string   | Name of the AWS S3 bucket for input files. | *optional* |
| \`input_prefix\`      | string   | Prefix for input files in the S3 bucket. | *optional* |
| \`checkpoint_bucket\` | string   | Name of the AWS S3 bucket for checkpoint files. | *optional* |
| \`checkpoint_prefix\` | string   | Prefix for checkpoint files in the S3 bucket. | *optional* |
| \`output_bucket\`     | string   | Name of the AWS S3 bucket for output files. | *optional* |
| \`output_prefix\`     | string   | Prefix for output files in the S3 bucket. | *optional* |
| \`max_failures\`      | integer  | Maximum number of allowed failures before the job is marked failed. | 3 |
| \`heartbeat_interval\`| integer | Time interval (in seconds) for sending heartbeat signals. | 30 |
| \`webhook\`           | string   | URL for the webhook to notify upon completion or failure. | *optional* |
| \`container_group_id\`| string  | ID of the container group where the command will be executed. | **required** |
| \`compression\` | boolean | If true, will gzip files it uploads to the bucket, appending the filename with .gz | false |
| \`sync\` | object | Sync configuration for the job. | *optional* |

**body.sync**

| Key      | Type   | Description | Default |
|----------|--------|-------------|---------|
| \`before\` | SyncConfig[] | List of sync configurations to run before the job. | *optional* |
| \`during\` | SyncConfig[] | List of sync configurations to run during the job. | *optional* |
| \`after\`  | SyncConfig[] | List of sync configurations to run after the job, but before marking the job complete. | *optional* |

**SyncConfig**

| Key          | Type   | Description | Default |
|--------------|--------|-------------|---------|
| \`bucket\`     | string | Name of the AWS S3 bucket. | **required** |
| \`prefix\`     | string | Prefix for files in the S3 bucket. | **required** |
| \`local_path\` | string | Local path to sync files to/from. | **required** |
| \`direction\`  | string | Direction of the sync. Must be "download" for \`before\`, and "upload" for \`during\` and \`after\` | **required** |
| \`pattern\`    | string | An ECMAScript(javascript) Regular Expression. Filepaths/keys that match will be included in the sync. Default is to include all files. | *optional* |
`;

function dbJobToAPIJob(job: DBJob | null): APIJobResponse {
	if (!job) {
		throw new Error('Job not found');
	}
	const apiJob: any = { ...job };
	apiJob.created = job.created ? new Date(job.created) : undefined;
	apiJob.started = job.started ? new Date(job.started) : undefined;
	apiJob.completed = job.completed ? new Date(job.completed) : undefined;
	apiJob.failed = job.failed ? new Date(job.failed) : undefined;
	apiJob.canceled = job.canceled ? new Date(job.canceled) : undefined;
	apiJob.heartbeat = job.heartbeat ? new Date(job.heartbeat) : undefined;
	apiJob.arguments = job.arguments ? JSON.parse(job.arguments) : [];
	apiJob.environment = job.environment ? JSON.parse(job.environment) : {};
	apiJob.compression = !!job.compression;
	if (job.sync) {
		apiJob.sync = JSON.parse(job.sync);
		delete apiJob.input_bucket;
		delete apiJob.input_prefix;
		delete apiJob.checkpoint_bucket;
		delete apiJob.checkpoint_prefix;
		delete apiJob.output_bucket;
		delete apiJob.output_prefix;
	}
	return apiJob as APIJobResponse;
}

function apiJobToDBJob(job: APIJobSubmission, userId: string): DBJob {
	return {
		id: crypto.randomUUID(),
		user_id: userId,
		status: 'pending',
		num_failures: 0,
		...job,
		arguments: JSON.stringify(job.arguments),
		environment: JSON.stringify(job.environment),
		compression: job.compression ? 1 : 0,
		sync: job.sync ? JSON.stringify(job.sync) : undefined,
		input_bucket: job.input_bucket || '',
		input_prefix: job.input_prefix || '',
		checkpoint_bucket: job.checkpoint_bucket || '',
		checkpoint_prefix: job.checkpoint_prefix || '',
		output_bucket: job.output_bucket || '',
		output_prefix: job.output_prefix || '',
	};
}

function validateAndNormalizeStorageInfo(job: APIJobSubmission): APIJobSubmission {
	// Only use sync OR legacy bucket/prefix
	if (
		job.sync &&
		(job.input_bucket || job.checkpoint_bucket || job.output_bucket || job.input_prefix || job.checkpoint_prefix || job.output_prefix)
	) {
		throw new Error('Cannot use both sync and bucket/prefix');
	}

	// Must use sync OR legacy bucket/prefix
	if (
		!job.sync &&
		(!job.input_bucket || !job.checkpoint_bucket || !job.output_bucket || !job.input_prefix || !job.checkpoint_prefix || !job.output_prefix)
	) {
		throw new Error('Must use either sync or bucket/prefix');
	}

	if (job.sync) {
		if (job.sync.before && job.sync.before.length > 0) {
			for (const sync of job.sync.before) {
				if (!sync.prefix.endsWith('/')) {
					sync.prefix += '/';
				}
				if (sync.direction !== 'download') {
					throw new Error('sync.before.direction must be "download"');
				}
			}
		}
		if (job.sync.during && job.sync.during.length > 0) {
			for (const sync of job.sync.during) {
				if (!sync.prefix.endsWith('/')) {
					sync.prefix += '/';
				}
				if (sync.direction !== 'upload') {
					throw new Error('sync.during.direction must be "upload"');
				}
			}
		}
		if (job.sync.after && job.sync.after.length > 0) {
			for (const sync of job.sync.after) {
				if (!sync.prefix.endsWith('/')) {
					sync.prefix += '/';
				}
				if (sync.direction !== 'upload') {
					throw new Error('sync.after.direction must be "upload"');
				}
			}
		}
	} else {
		if (job.input_prefix && !job.input_prefix.endsWith('/')) {
			job.input_prefix += '/';
		}
		if (job.checkpoint_prefix && !job.checkpoint_prefix.endsWith('/')) {
			job.checkpoint_prefix += '/';
		}
		if (job.output_prefix && !job.output_prefix.endsWith('/')) {
			job.output_prefix += '/';
		}
	}

	return job;
}

export class CreateJob extends OpenAPIRoute {
	static schema = {
		summary: 'Queue a new job',
		description: queueJobDocs,
		security: [{ apiKey: [] }],
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
		let { body } = data;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}
		try {
			body = validateAndNormalizeStorageInfo(body);
		} catch (e: any) {
			return error(400, { error: 'Invalid request', message: e.message });
		}

		try {
			const jobToInsert = apiJobToDBJob(body, userId);

			const job = await createNewJob(jobToInsert, env);
			if (!job || !job.created) {
				return error(500, { error: 'Internal server error', message: 'Failed to create job' });
			}

			const jobToReturn = dbJobToAPIJob(job);

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

export class BatchCreateJobs extends OpenAPIRoute {
	static schema = {
		summary: 'Queue multiple jobs',
		description: `Queue multiple jobs in one request. Limit 1000 jobs per request.\n\n${queueJobDocs}`,
		security: [{ apiKey: [] }],
		requestBody: APIJobSubmissionSchema.array().min(1).max(1000),
		responses: {
			'202': {
				description: 'Jobs created',
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

	async handle(request: AuthedRequest, env: Env, ctx: any, data: { body: APIJobSubmission[] }) {
		const { body } = data;
		const { userId } = request;
		if (!userId) {
			return error(400, { error: 'User Required', message: 'No user ID found' });
		}

		const jobsToInsert: DBJob[] = [];
		for (let i = 0; i < body.length; i++) {
			let job;
			try {
				job = validateAndNormalizeStorageInfo(body[i]);
			} catch (e: any) {
				return error(400, { error: 'Invalid request', message: e.message, index: i });
			}

			jobsToInsert.push(apiJobToDBJob(job, userId));
		}

		try {
			const jobs = await batchCreateNewJobs(jobsToInsert, env);
			if (!jobs || jobs.length === 0) {
				return error(500, { error: 'Internal server error', message: 'Failed to create jobs' });
			}

			const jobsToReturn = jobs.map(dbJobToAPIJob);

			return new Response(JSON.stringify(jobsToReturn), {
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
		security: [{ apiKey: [] }],
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

			const jobToReturn = dbJobToAPIJob(job);

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
		security: [{ apiKey: [] }],
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
				const updatedJob = await getJobByUserAndId(userId, job.id, env);
				ctx.waitUntil(
					fireWebhook(env, request.headers.get(env.API_HEADER) || '', job.id, userId, machine_id, container_group_id, 'running')
				);
				return [dbJobToAPIJob(updatedJob!)];
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
		security: [{ apiKey: [] }],
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
			const currentStatus = await updateJobHeartbeat(id, userId, data.body.machine_id, env);
			return { status: currentStatus };
		} catch (e: any) {
			if (e.message === 'Job not found') {
				return error(404, { error: 'Not Found', message: 'Job not found' });
			}
			console.error('Something went wrong with heartbeats:', e.message);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ReportJobFailure extends OpenAPIRoute {
	static schema = {
		summary: 'Report job failure',
		description: 'Report a job failure',
		security: [{ apiKey: [] }],
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
			const job = await getJobByUserAndId(userId, id, env);
			if (!job || !job.created) {
				return error(404, { error: 'Not Found', message: 'Job not found' });
			}
			const { num_failures, max_failures = 3 } = job;

			await env.banned_workers.put(`${data.body.machine_id}:${id}`, 'true');
			if (num_failures + 1 >= max_failures) {
				await Promise.all([updateJobStatus(id, userId, data.body.machine_id, 'failed', env), incrementFailedAttempts(id, userId, env)]);
				ctx.waitUntil(
					fireWebhook(
						env,
						request.headers.get(env.API_HEADER) || '',
						id,
						userId,
						data.body.machine_id,
						data.body.container_group_id,
						'failed'
					)
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
	} else {
		console.log('No webhook found for job', jobId);
	}
}

export class ReportJobCompleted extends OpenAPIRoute {
	static schema = {
		summary: 'Report job completed',
		description: 'Report a job completed',
		security: [{ apiKey: [] }],
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
			ctx.waitUntil(fireWebhook(env, request.headers.get(env.API_HEADER) || '', id, userId, machine_id, container_group_id, 'completed'));
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
		security: [{ apiKey: [] }],
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
			return new Response(JSON.stringify({ message: 'Job canceled' }), {
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

export class ListJobs extends OpenAPIRoute {
	static schema = {
		summary: 'List jobs',
		description: 'List your jobs',
		security: [{ apiKey: [] }],
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
			const jobs = await listJobsWithArbitraryFilter(filter, data.query.asc, data.query.page_size, data.query.page, env);
			return {
				_count: jobs.length,
				jobs: jobs.map(dbJobToAPIJob),
			};
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}

export class ClearJobs extends OpenAPIRoute {
	static schema = {
		summary: '(ADMIN) Clear all jobs',
		description: 'Clear all jobs',
		security: [{ apiKey: [] }],
		responses: {
			'204': {
				description: 'Jobs cleared',
				schema: {
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

	async handle(request: AuthedRequest, env: Env, ctx: any) {
		try {
			await clearJobs(env);
			return new Response(null, { status: 204 });
		} catch (e: any) {
			console.log(e);
			return error(500, { error: 'Internal server error', message: e.message });
		}
	}
}
