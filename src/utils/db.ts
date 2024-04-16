import { Env, SaladData, StatusWebhook } from '../types';

function generateJobInsertStatement(job: any): string {
	const keys = Object.keys(job);

	const columns = keys.join(', ');
	const placeholders = keys.map((k) => '?').join(', ');

	const sql = `INSERT INTO Jobs (${columns}) VALUES (${placeholders})`;

	return sql;
}
