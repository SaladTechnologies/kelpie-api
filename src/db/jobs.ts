import { Env, DBJob } from '../types';

function generateJobInsertStatement(job: DBJob): string {
	const keys = Object.keys(job);

	const columns = keys.join(', ');
	const placeholders = keys.map((k) => '?').join(', ');

	const sql = `INSERT INTO Jobs (${columns}) VALUES (${placeholders})`;

	return sql;
}

export async function createNewJob(job: DBJob, env: Env): Promise<DBJob | null> {
	await env.DB.prepare(generateJobInsertStatement(job))
		.bind(...Object.values(job).map((v) => (typeof v === 'undefined' ? null : v)))
		.all();
	return getJobByID(job.id!, env);
}

export async function batchCreateNewJobs(jobs: DBJob[], env: Env): Promise<Array<DBJob | null>> {
	// prepared sql statements must be on only one statement for this db
	const jobIds = await Promise.all(
		jobs.map(async (job) => {
			await env.DB.prepare(generateJobInsertStatement(job))
				.bind(...Object.values(job).map((v) => (typeof v === 'undefined' ? null : v)))
				.all();
			return job.id;
		})
	);

	return batchGetJobsById(jobIds, env);
}

export async function getJobByID(id: string, env: Env): Promise<DBJob | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	const job = results[0] as unknown as DBJob;
	return job;
}

export async function batchGetJobsById(ids: string[], env: Env): Promise<DBJob[]> {
	// Chunk this 100 at a time, per D1 limits
	const chunks = [];
	for (let i = 0; i < ids.length; i += 100) {
		chunks.push(ids.slice(i, i + 100));
	}
	const allResults: DBJob[] = [];
	for (const chunk of chunks) {
		const { results } = await env.DB.prepare(`SELECT * FROM Jobs WHERE id IN (${chunk.map(() => '?').join(', ')})`)
			.bind(...chunk)
			.all();
		allResults.push(...(results as unknown as DBJob[]));
	}
	return allResults;
}

export async function getJobByUserAndId(userId: string, jobId: string, env: Env): Promise<DBJob | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE id = ? AND user_id = ?').bind(jobId, userId).all();
	if (!results.length) {
		return null;
	}
	const job = results[0] as unknown as DBJob;
	return job;
}

export async function getHighestPriorityJob(env: Env, userId: string, containerGroup: string, num: number = 0): Promise<DBJob | null> {
	const { results: runningResults } = await env.DB.prepare(
		`
SELECT *
FROM Jobs
WHERE status = 'running' AND user_id = ? AND container_group_id = ? AND (
		heartbeat <= datetime('now', '-' || (2 * heartbeat_interval) || ' seconds')
		OR
		(heartbeat IS NULL AND created <= datetime('now', '-' || (2 * heartbeat_interval) || ' seconds'))
)
ORDER BY created ASC
LIMIT 1 OFFSET ?;`
	)
		.bind(userId, containerGroup, num)
		.all();
	if (runningResults.length > 0) {
		const job = runningResults[0] as unknown as DBJob;
		return job;
	}
	console.log('No running jobs found');
	const { results: pendingResults } = await env.DB.prepare(
		`
SELECT *
FROM Jobs
WHERE status = 'pending' AND user_id = ? AND container_group_id = ?
ORDER BY created ASC
LIMIT 1 OFFSET ?;`
	)
		.bind(userId, containerGroup, num)
		.all();
	if (pendingResults.length > 0) {
		const job = pendingResults[0] as unknown as DBJob;
		return job;
	}
	return null;
}

export async function updateJobStatus(jobId: string, userId: string, machineId: string, status: string, env: Env): Promise<void> {
	let timeStatement = '';
	switch (status) {
		case 'running':
			timeStatement = ', started = datetime("now")';
			break;
		case 'failed':
			timeStatement = ', failed = datetime("now")';
			break;
		case 'canceled':
			timeStatement = ', canceled = datetime("now")';
			break;
		case 'completed':
			timeStatement = ', completed = datetime("now")';
			break;
		default:
			throw new Error(`Invalid status: ${status}`);
	}

	await env.DB.prepare(
		`UPDATE Jobs SET status = ?${timeStatement}, heartbeat = datetime("now"), machine_id = ? WHERE id = ? AND user_id = ?`
	)
		.bind(status, machineId, jobId, userId)
		.run();
}

export async function getJobStatus(id: string, userId: string, env: Env): Promise<{ status: string; machine_id?: string } | null> {
	const { results } = await env.DB.prepare('SELECT status, machine_id FROM Jobs WHERE id = ? AND user_id = ?').bind(id, userId).all();
	if (!results.length) {
		return null;
	}
	return results[0] as { status: string; machine_id?: string };
}

export async function updateJobHeartbeat(id: string, userId: string, machineId: string, env: Env): Promise<string> {
	const jobStatus = await getJobStatus(id, userId, env);
	if (!jobStatus) {
		throw new Error('Job not found');
	}
	const { status, machine_id } = jobStatus;
	if (status !== 'running') {
		return status;
	}
	if (machine_id && machine_id !== machineId) {
		/**
		 * This means a different machine has most recently grabbed the job.
		 * If we tell the worker it was canceled, the worker will drop the job and
		 * request a new one.
		 */
		return 'canceled';
	}

	await env.DB.prepare(
		"UPDATE Jobs SET heartbeat = datetime('now'), num_heartbeats = num_heartbeats + 1, machine_id = ? WHERE id = ? AND status = 'running' AND user_id = ?"
	)
		.bind(machineId, id, userId)
		.run();

	return status;
}

export async function listJobsWithArbitraryFilter(
	filter: any,
	asc: boolean,
	pageSize: number = 100,
	page: number = 1,
	env: Env
): Promise<DBJob[]> {
	let query = 'SELECT * FROM Jobs';
	const keys = Object.keys(filter);
	if (keys.length) {
		query += ' WHERE ';
		query += keys.map((k) => `${k} = ?`).join(' AND ');
	}
	query += ' ORDER BY created';
	query += asc ? ' ASC' : ' DESC';
	query += ' LIMIT ? OFFSET ?';
	const { results } = await env.DB.prepare(query)
		.bind(...Object.values(filter), pageSize, (page - 1) * pageSize)
		.all();
	return results as unknown[] as DBJob[];
}

export async function incrementFailedAttempts(jobId: string, userId: String, env: Env): Promise<void> {
	const resp = await env.DB.prepare('UPDATE Jobs SET num_failures = num_failures + 1 WHERE id = ? AND user_id = ?')
		.bind(jobId, userId)
		.run();
	console.log(JSON.stringify(resp, null, 2));
}

export async function getFailedAttempts(jobId: string, userId: string, env: Env): Promise<number | null> {
	const { results } = await env.DB.prepare('SELECT num_failures FROM Jobs WHERE id = ? AND user_id = ?').bind(jobId, userId).all();
	if (!results.length) {
		return null;
	}
	return results[0]['num_failures'] as number;
}

export async function clearJobs(env: Env): Promise<void> {
	await env.DB.prepare('DELETE FROM Jobs').run();
}

export async function countActiveAndRecentlyActiveJobsInContainerGroup(
	containerGroupId: string,
	maxCount: number,
	idleThreshold: number,
	env: Env
): Promise<number> {
	const query = `
SELECT COUNT(*)
FROM (
	SELECT 1 FROM Jobs
	WHERE container_group_id = ? AND (
		status = "running" OR
		status = "pending" OR
		completed >= datetime('now', '-' || ? || ' seconds') OR
		failed >= datetime('now', '-' || ? || ' seconds') OR
		canceled >= datetime('now', '-' || ? || ' seconds')
	)
LIMIT ?
)
	`;
	const { results } = await env.DB.prepare(query).bind(containerGroupId, idleThreshold, idleThreshold, idleThreshold, maxCount).all();
	return results[0]['COUNT(*)'] as number;
}
