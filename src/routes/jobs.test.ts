import { expect, it, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { adminToken, clearJobs, clearUsers, createUser } from '../utils/test';
import { env } from 'cloudflare:test';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let user: any;
let token: string;
beforeAll(async () => {
	await clearJobs();
	await clearUsers();
	const { user: u, token: t } = await createUser('testuser-jobs');
	user = u;
	token = t;
});

async function queueJob(overrides: any = {}) {
	return fetch('http://localhost:8787/jobs', {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': token,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			command: 'python',
			arguments: ['/app/main.py'],
			input_bucket: 'testbucket',
			input_prefix: 'inputs/',
			output_bucket: 'testbucket',
			output_prefix: 'outputs/',
			checkpoint_bucket: 'testbucket',
			checkpoint_prefix: 'checkpoints/',
			container_group_id: 'testgroup',
			...overrides,
		}),
	});
}

describe('POST /jobs', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Queues a new job', async () => {
		const response = await fetch('http://localhost:8787/jobs', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				command: 'python',
				arguments: ['/app/main.py'],
				input_bucket: 'testbucket',
				input_prefix: 'inputs/',
				output_bucket: 'testbucket',
				output_prefix: 'outputs/',
				checkpoint_bucket: 'testbucket',
				checkpoint_prefix: 'checkpoints/',
				container_group_id: 'testgroup',
			}),
		});

		expect(response.status).toEqual(202);

		const { id, status } = (await response.json()) as any;
		expect(id).toBeDefined();
		expect(status).toEqual('pending');
	});

	it('Supports the sync object', async () => {
		const response = await fetch('http://localhost:8787/jobs', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				command: 'python',
				arguments: ['/app/main.py'],
				container_group_id: 'testgroup',
				sync: {
					before: [
						{
							bucket: 'testbucket',
							prefix: 'before/',
							local_path: '/app/before',
							direction: 'download',
						},
					],
				},
			}),
		});

		expect(response.status).toEqual(202);

		const { id, status, sync, input_bucket } = (await response.json()) as any;
		expect(id).toBeDefined();
		expect(status).toEqual('pending');
		expect(sync).toMatchObject({
			before: [
				{
					bucket: 'testbucket',
					prefix: 'before/',
					local_path: '/app/before',
					direction: 'download',
				},
			],
		});
		expect(input_bucket).toBeUndefined();
	});

	it('Jobs submitted with an API key are picked up by workers with a JWT', async () => {
		const response = await fetch('http://localhost:8787/jobs', {
			method: 'POST',
			headers: {
				'Salad-Api-Key': env.TEST_API_KEY!,
				'Content-Type': 'application/json',
				'Salad-Organization': env.TEST_ORG!,
				'Salad-Project': 'default',
			},
			body: JSON.stringify({
				command: 'python',
				arguments: ['/app/main.py'],
				sync: {
					before: [
						{
							bucket: 'testbucket',
							prefix: 'before/',
							local_path: '/app/before',
							direction: 'download',
						},
					],
				},
				container_group_id: 'testgroup123',
			}),
		});

		let body = await response.text();

		expect(response.status).toEqual(202);

		const job = JSON.parse(body) as any;
		expect(job.id).toBeDefined();

		const workResp = await fetch(`http://localhost:8787/work?machine_id=123&container_group_id=testgroup123`, {
			headers: {
				Authorization: `Bearer ${env.TEST_JWT}`,
				'Salad-Project': 'default',
			},
		});

		expect(workResp.status).toEqual(200);
		const work = (await workResp.json()) as any[];
		expect(work).toHaveLength(1);
		expect(work[0].id).toEqual(job.id);
	});
});

describe('POST /jobs/batch', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Queues multiple jobs', async () => {
		const response = await fetch('http://localhost:8787/jobs/batch', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify([
				{
					command: 'python',
					arguments: ['/app/main.py'],
					container_group_id: 'testgroup',
					sync: {
						before: [
							{
								bucket: 'testbucket',
								prefix: 'before/',
								local_path: '/app/before',
								direction: 'download',
							},
						],
					},
				},
				{
					command: 'python',
					arguments: ['/app/main.py'],
					container_group_id: 'testgroup',
					sync: {
						before: [
							{
								bucket: 'testbucket',
								prefix: 'before/',
								local_path: '/app/before',
								direction: 'download',
							},
						],
					},
				},
			]),
		});

		expect(response.status).toEqual(202);

		const jobs = (await response.json()) as any[];
		expect(jobs).toHaveLength(2);
		jobs.forEach((job) => {
			expect(job.id).toBeDefined();
			expect(job.status).toEqual('pending');
		});
	});

	it('Queues up to 1000 jobs at once', async () => {
		const jobs = Array.from({ length: 1000 }, () => ({
			command: 'python',
			arguments: ['/app/main.py'],
			container_group_id: 'testgroup',
			sync: {
				before: [
					{
						bucket: 'testbucket',
						prefix: 'before/',
						local_path: '/app/before',
						direction: 'download',
					},
				],
			},
		}));

		const response = await fetch('http://localhost:8787/jobs/batch', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(jobs),
		});

		const body = (await response.json()) as any;
		expect(response.status).toEqual(202);

		const createdJobs = body as any[];
		expect(createdJobs).toHaveLength(1000);
		createdJobs.forEach((job) => {
			expect(job.id).toBeDefined();
			expect(job.status).toEqual('pending');
		});
	});

	it('Rejects more than 1000 jobs at once', async () => {
		const jobs = Array.from({ length: 1001 }, () => ({
			command: 'python',
			arguments: ['/app/main.py'],
			container_group_id: 'testgroup',
		}));

		const response = await fetch('http://localhost:8787/jobs/batch', {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(jobs),
		});

		expect(response.status).toEqual(400);
	});
});

describe('GET /jobs', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Lists all jobs', async () => {
		await Promise.all([queueJob(), queueJob(), queueJob()]);
		const jobResp = await fetch('http://localhost:8787/jobs', {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		const jobs = (await jobResp.json()) as any;

		expect(jobs._count).toEqual(3);
		expect(jobs.jobs).toHaveLength(3);
	});
});

describe('GET /jobs/:id', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Gets a job by id', async () => {
		const jobResp = await queueJob();
		const { id } = (await jobResp.json()) as any;

		const response = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(200);

		const job = (await response.json()) as any;
		expect(job.id).toEqual(id);
	});
});

describe('DELETE /jobs/:id', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Cancels a job', async () => {
		const jobResp = await queueJob();
		const { id } = (await jobResp.json()) as any;

		const response = await fetch(`http://localhost:8787/jobs/${id}`, {
			method: 'DELETE',
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		expect(response.status).toEqual(202);

		const jobResp2 = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		const job = (await jobResp2.json()) as any;
		expect(job.status).toEqual('canceled');
	});
});

describe('POST /jobs/:id/completed', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Reports a job as completed', async () => {
		const jobResp = await queueJob();
		const { id } = (await jobResp.json()) as any;

		const response = await fetch(`http://localhost:8787/jobs/${id}/completed`, {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
			},
			body: JSON.stringify({
				machine_id: 'testmachine',
				container_group_id: 'testgroup',
			}),
		});

		expect(response.status).toEqual(200);

		const jobResp2 = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		const job = (await jobResp2.json()) as any;
		expect(job.status).toEqual('completed');
	});
});

describe('POST /jobs/:id/failed', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Reports a job as failed', async () => {
		const jobResp = await queueJob();
		const { id } = (await jobResp.json()) as any;

		const response = await fetch(`http://localhost:8787/jobs/${id}/failed`, {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
			},
			body: JSON.stringify({
				machine_id: 'testmachine',
				container_group_id: 'testgroup',
			}),
		});

		expect(response.status).toEqual(202);

		const jobResp2 = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		const job = (await jobResp2.json()) as any;
		expect(job.status).toEqual('pending');
		expect(job.num_failures).toEqual(1);
	});

	it('Sets a job to failed if it has failed too many times', async () => {
		const jobResp = await queueJob({ max_failures: 1 });
		const { id } = (await jobResp.json()) as any;

		const response = await fetch(`http://localhost:8787/jobs/${id}/failed`, {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
			},
			body: JSON.stringify({
				machine_id: 'testmachine',
				container_group_id: 'testgroup',
			}),
		});

		expect(response.status).toEqual(202);

		const jobResp2 = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		const job = (await jobResp2.json()) as any;
		expect(job.status).toEqual('failed');
	});
});

describe('POST /jobs/:id/heartbeat', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Updates a job heartbeat', async () => {
		const jobResp = await queueJob();
		const { id, container_group_id } = (await jobResp.json()) as any;
		await fetch(`http://localhost:8787/work?machine_id=testmachine&container_group_id=${container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		const response = await fetch(`http://localhost:8787/jobs/${id}/heartbeat`, {
			method: 'POST',
			headers: {
				'X-Kelpie-Key': token,
			},
			body: JSON.stringify({
				machine_id: 'testmachine',
				container_group_id: 'testgroup',
			}),
		});

		expect(response.status).toEqual(200);

		const jobResp2 = await fetch(`http://localhost:8787/jobs/${id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		const job = (await jobResp2.json()) as any;
		expect(job.heartbeat).toBeDefined();
	});
});

describe('GET /work', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Gets the next job to work on', async () => {
		const resp = await queueJob();
		const queuedJob = (await resp.json()) as any;
		const workResp = await fetch(`http://localhost:8787/work?machine_id=testmachine&container_group_id=${queuedJob.container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		expect(workResp.status).toEqual(200);
		const jobs = (await workResp.json()) as any[];
		expect(jobs).toHaveLength(1);
		const job = jobs[0];

		expect(job.status).toEqual('running');
		expect(job.id).toEqual(queuedJob.id);
	});

	it('Gets a stalled running job first', async () => {
		const resp = await queueJob({ heartbeat_interval: 1 });
		const queuedJob = (await resp.json()) as any;
		await fetch(`http://localhost:8787/work?machine_id=testmachine&container_group_id=${queuedJob.container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});

		await sleep(2000);

		const workResp = await fetch(`http://localhost:8787/work?machine_id=testmachine&container_group_id=${queuedJob.container_group_id}`, {
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		expect(workResp.status).toEqual(200);
		const jobs = (await workResp.json()) as any[];
		expect(jobs).toHaveLength(1);
		const job = jobs[0];

		expect(job.status).toEqual('running');
		expect(job.id).toEqual(queuedJob.id);
	});
});

describe('DELETE /jobs/container-groups/:container_group_id', () => {
	beforeEach(clearJobs);
	afterEach(clearJobs);

	it('Purges all jobs for a container group', async () => {
		const jobsToQueue = 3;
		const queuedJobs = [];
		for (let i = 0; i < jobsToQueue; i++) {
			const resp = await queueJob({ container_group_id: 'purge-group' });
			const queuedJob = (await resp.json()) as any;
			queuedJobs.push(queuedJob);
		}

		const purgeResp = await fetch(`http://localhost:8787/jobs/container-groups/purge-group`, {
			method: 'DELETE',
			headers: {
				'X-Kelpie-Key': token,
			},
		});
		expect(purgeResp.status).toEqual(200);
		const purgeBody = (await purgeResp.json()) as any;
		expect(purgeBody.count).toEqual(jobsToQueue);

		for (const job of queuedJobs) {
			const jobResp = await fetch(`http://localhost:8787/jobs/${job.id}`, {
				headers: {
					'X-Kelpie-Key': token,
				},
			});
			expect(jobResp.status).toEqual(404);
		}
	});
});
