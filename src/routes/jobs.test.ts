import { expect, it, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { adminToken, clearJobs, clearUsers } from '../utils/test';

let user: any;
let token: string;
beforeAll(async () => {
	await clearJobs();
	await clearUsers();
	const userResp = await fetch('http://localhost:8787/users', {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': adminToken,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			username: 'testuser-jobs',
		}),
	});
	user = (await userResp.json()) as any;

	const tokenResp = await fetch(`http://localhost:8787/users/${user.id}/token`, {
		method: 'POST',
		headers: {
			'X-Kelpie-Key': adminToken,
		},
		body: JSON.stringify({
			org_name: 'testorg',
			project_name: 'testproject',
		}),
	});
	token = ((await tokenResp.json()) as any).token;
});

afterAll(async () => {
	await clearJobs();
	await clearUsers();
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
		const { id } = (await jobResp.json()) as any;

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
});
