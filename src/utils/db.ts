import { Env, SaladData, StatusWebhook } from '../types';

function generateJobInsertStatement(job: any): string {
	const keys = Object.keys(job);

	const columns = keys.join(', ');
	const placeholders = keys.map((k) => '?').join(', ');

	const sql = `INSERT INTO Jobs (${columns}) VALUES (${placeholders})`;

	return sql;
}

export async function createNewJob(job: any, env: Env): Promise<any | null> {
	job.id = crypto.randomUUID();
	await Promise.all([
		env.DB.prepare(generateJobInsertStatement(job))
			.bind(...Object.values(job))
			.all(),
		logTrainingEvent(job.id, 'created', {}, env),
	]);
	return getJobByID(job.id!, env);
}

export async function getJobByID(id: string, env: Env): Promise<any | null> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	const job = results[0];
	return job;
}

export async function getHighestPriorityJob(env: Env, num: number = 0): Promise<any | null> {
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
		const job = runningResults[0];
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
		const job = pendingResults[0];
		return job;
	}
	return null;
}

export async function updateJobStatus(id: string, status: string, env: Env, saladData: SaladData): Promise<void> {
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
	const promises: Promise<any>[] = [
		env.DB.prepare(`UPDATE Jobs SET status = ?${timeStatement}, heartbeat = datetime("now") WHERE id = ?`).bind(status, id).run(),
		logTrainingEvent(id, eventName, getSaladDataFromWebhookData(saladData), env),
	];
	await Promise.all(promises);
}

const getSaladDataFromWebhookData = (webhookData: SaladData): SaladData => {
	const saladData: SaladData = {};
	if (webhookData.organization_name) {
		saladData.organization_name = webhookData.organization_name;
	}
	if (webhookData.project_name) {
		saladData.project_name = webhookData.project_name;
	}
	if (webhookData.container_group_name) {
		saladData.container_group_name = webhookData.container_group_name;
	}
	if (webhookData.machine_id) {
		saladData.machine_id = webhookData.machine_id;
	}
	if (webhookData.container_group_id) {
		saladData.container_group_id = webhookData.container_group_id;
	}
	return saladData;
};

export async function logTrainingEvent(jobId: string, eventType: string, eventData: SaladData, env: Env): Promise<void> {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO Events (id, job_id, type, data, timestamp) VALUES (?, ?, ?, ?, datetime("now"))')
		.bind(id, jobId, eventType, JSON.stringify(eventData))
		.run();
}

export async function getJobStatus(id: string, env: Env): Promise<string | null> {
	const { results } = await env.DB.prepare('SELECT status FROM Jobs WHERE id = ?').bind(id).all();
	if (!results.length) {
		return null;
	}
	return results[0].status as string;
}

export async function updateJobHeartbeat(id: string, saladData: SaladData, env: Env): Promise<void> {
	const currentStatus = await getJobStatus(id, env);
	if (currentStatus !== 'running') {
		const err = new Error('Job not running');
		(err as any).status = 400;
		throw err;
	}

	await Promise.all([
		env.DB.prepare("UPDATE Jobs SET heartbeat = datetime('now') WHERE id = ? AND status = 'running'").bind(id).run(),
		logTrainingEvent(id, 'heartbeat', saladData, env),
	]);
}

export async function listJobsWithStatus(status: string, env: Env): Promise<any[]> {
	const { results } = await env.DB.prepare('SELECT * FROM Jobs WHERE status = ? ORDER BY created ASC').bind(status).all();
	return results;
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
