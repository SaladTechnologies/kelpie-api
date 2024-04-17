import { Env, DBJob, DBUser } from '../types';

function generateJobInsertStatement(job: DBJob): string {
	const keys = Object.keys(job);

	const columns = keys.join(', ');
	const placeholders = keys.map((k) => '?').join(', ');

	const sql = `INSERT INTO Jobs (${columns}) VALUES (${placeholders})`;

	return sql;
}

export async function createNewJob(job: DBJob, env: Env): Promise<DBJob | null> {
	job.id = crypto.randomUUID();
	await env.DB.prepare(generateJobInsertStatement(job))
		.bind(...Object.values(job))
		.all();
	return getJobByID(job.id!, env);
}

export async function getJobByID(id: string, env: Env): Promise<DBJob | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	const job = results[0] as unknown as DBJob;
	return job;
}

export async function getJobByUserAndId(userId: string, jobId: string, env: Env): Promise<DBJob | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE id = ? AND user_id = ?').bind(jobId, userId).all();
	if (!results.length) {
		return null;
	}
	const job = results[0] as unknown as DBJob;
	return job;
}

export async function getHighestPriorityJob(env: Env, num: number = 0): Promise<DBJob | null> {
	const { results: runningResults } = await env.DB.prepare(
		`
	SELECT *
	FROM Jobs
	WHERE status = 'running' AND (
		  heartbeat < datetime('now', '-' || ? || ' seconds')
		  OR
		  (heartbeat IS NULL AND created < datetime('now', '-' || ? || ' seconds'))
	)
	ORDER BY heartbeat
	LIMIT 1 OFFSET ?;`
	)
		.bind(env.MAX_HEARTBEAT_AGE, env.MAX_HEARTBEAT_AGE, num)
		.all();
	if (runningResults.length > 0) {
		const job = runningResults[0] as unknown as DBJob;
		return job;
	}
	const { results: pendingResults } = await env.DB.prepare(
		`
	SELECT *
    FROM Jobs
    WHERE status = 'pending'
    ORDER BY heartbeat
    LIMIT 1 OFFSET ?;`
	)
		.bind(num)
		.all();
	if (pendingResults.length > 0) {
		const job = pendingResults[0] as unknown as DBJob;
		return job;
	}
	return null;
}

export async function updateJobStatus(id: string, status: string, env: Env): Promise<void> {
	let timeStatement = '';
	let eventName;
	switch (status) {
		case 'running':
			timeStatement = ', started = datetime("now")';
			eventName = 'started';
			break;
		case 'failed':
			timeStatement = ', failed = datetime("now")';
			eventName = status;
			break;
		case 'canceled':
			timeStatement = ', canceled = datetime("now")';
			eventName = status;
			break;
		default:
			throw new Error(`Invalid status: ${status}`);
	}

	await env.DB.prepare(`UPDATE Jobs SET status = ?${timeStatement}, heartbeat = datetime("now") WHERE id = ?`).bind(status, id).run();
}

export async function getJobStatus(id: string, env: Env): Promise<string | null> {
	const { results } = await env.DB.prepare('SELECT status FROM Jobs WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	return results[0].status as string;
}

export async function updateJobHeartbeat(id: string, env: Env): Promise<void> {
	const currentStatus = await getJobStatus(id, env);
	if (currentStatus !== 'running') {
		const err = new Error('Job not running');
		(err as any).status = 400;
		throw err;
	}

	await env.DB.prepare("UPDATE Jobs SET heartbeat = datetime('now') WHERE id = ? AND status = 'running'").bind(id).run();
}

export async function listJobsWithStatus(status: string, env: Env): Promise<DBJob[]> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE status = ? ORDER BY created ASC').bind(status).all();
	return results as unknown[] as DBJob[];
}

export async function incrementFailedAttempts(jobId: string, env: Env): Promise<void> {
	await env.DB.prepare('UPDATE Jobs SET num_failures = num_failures + 1 WHERE id = ?').bind(jobId).run();
}

export async function getFailedAttempts(jobId: string, env: Env): Promise<number> {
	const { results } = await env.DB.prepare('SELECT num_failures FROM Jobs WHERE id = ?').bind(jobId).all();
	if (!results.length) {
		return 0;
	}
	return results[0]['num_failures'] as number;
}

export async function createUser(env: Env, username: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO Users (id, username) VALUES (?, ?)').bind(id, username).run();
	return id;
}

export async function getUserById(env: Env, id: string): Promise<DBUser | null> {
	const { results } = await env.DB.prepare('SELECT username FROM Users WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	return results[0] as unknown as DBUser;
}

export async function getUserByUsername(env: Env, username: string): Promise<DBUser | null> {
	const { results } = await env.DB.prepare('SELECT id FROM Users WHERE username = ?').bind(username).all();
	if (!results.length) {
		return null;
	}
	return results[0] as unknown as DBUser;
}
