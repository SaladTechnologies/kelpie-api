import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { countActiveAndRecentlyActiveJobsInContainerGroup as countJobs } from './jobs';
import type { Env } from '../types';

const local = env as unknown as { DB: D1Database; JOBS_SCHEMA: string; AUTOSCALE_MIGRATION: string };
const now = '2026-11-06 12:00:00';
const recent = '2026-11-06 11:59:00';
const old = '2020-01-01 00:00:00';
let lastQuery = '';
const countEnv = {
	DB: {
		prepare(query: string) {
			// Freeze SQLite's clock, not just JavaScript's, so boundary tests are exact.
			lastQuery = query.replaceAll("'now'", "'" + now + "'");
			return local.DB.prepare(lastQuery);
		},
	},
} as Env;

const originalQuery = `
SELECT COUNT(*) AS num_jobs FROM (
 SELECT 1 FROM Jobs
 WHERE container_group_id = ?1 AND (
  status = 'running' OR status = 'pending'
  OR completed >= datetime(?2, '-' || ?3 || ' seconds')
  OR failed >= datetime(?2, '-' || ?3 || ' seconds')
  OR canceled >= datetime(?2, '-' || ?3 || ' seconds')
 )
 LIMIT ?4
)`;

type Job = {
	id: string;
	group?: string;
	status?: string;
	completed?: string | null;
	failed?: string | null;
	canceled?: string | null;
};

async function executeSql(sql: string) {
	const statements = sql.split(';').filter((part) => part.trim());
	await local.DB.batch(statements.map((statement) => local.DB.prepare(statement)));
}

async function insert(jobs: Job[]) {
	for (let offset = 0; offset < jobs.length; offset += 100) {
		await local.DB.batch(jobs.slice(offset, offset + 100).map((job) =>
			local.DB.prepare(`
INSERT INTO Jobs (id, user_id, container_group_id, status, completed, failed, canceled,
 command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
VALUES (?, 'test-user', ?, ?, ?, ?, ?, 'test', '', '', '', '', '', '')
			`).bind(job.id, job.group ?? 'target', job.status ?? 'completed', job.completed ?? null, job.failed ?? null, job.canceled ?? null)
		));
	}
}

async function original(group: string, cap: number, threshold = 300) {
	const result = await local.DB.prepare(originalQuery).bind(group, now, threshold, cap).first<number>('num_jobs');
	return result!;
}

beforeEach(async () => {
	await executeSql(local.JOBS_SCHEMA);
});

describe('autoscaler indexed count semantics', () => {
	it('returns zero for an empty or different container group', async () => {
		await insert([{ id: 'other', group: 'other', status: 'running', completed: recent }]);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(0);
	});

	it('counts active rows even with null or old timestamps', async () => {
		await insert([
			{ id: 'running', status: 'running' },
			{ id: 'pending', status: 'pending', failed: old },
			{ id: 'old', completed: old, failed: old, canceled: old },
			{ id: 'nulls' },
		]);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(2);
	});

	it('preserves timestamp OR semantics regardless of current status and deduplicates overlaps', async () => {
		await insert([
			{ id: 'all', status: 'running', completed: recent, failed: recent, canceled: recent },
			{ id: 'completed', completed: recent },
			{ id: 'failed', status: 'completed', completed: old, failed: recent },
			{ id: 'canceled', status: 'failed', failed: old, canceled: recent },
			{ id: 'other', group: 'other', completed: recent },
		]);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(4);
	});

	it('includes the exact cutoff and future timestamps but excludes one second before it', async () => {
		await insert([
			{ id: 'boundary', completed: '2026-11-06 11:55:00' },
			{ id: 'before', failed: '2026-11-06 11:54:59' },
			{ id: 'future', canceled: '2026-11-06 12:00:01' },
		]);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(2);
		expect(await countJobs('target', 64, 0, countEnv)).toBe(1);
	});

	it('preserves the cap for exactly K, K+1, zero and legacy negative LIMIT values', async () => {
		await insert(Array.from({ length: 6 }, (_, i) => ({
			id: String(i), status: 'running', completed: recent, failed: recent, canceled: recent,
		})));
		for (const cap of [0, 1, 5, 6, 7, -1]) {
			expect(await countJobs('target', cap, 300, countEnv)).toBe(await original('target', cap));
		}
	});

	it('does not undercount when individually capped branches overlap', async () => {
		await insert([
			...Array.from({ length: 8 }, (_, i) => ({ id: 'shared-' + i, status: 'running', completed: recent, failed: recent, canceled: recent })),
			{ id: 'completed-only', completed: recent },
			{ id: 'failed-only', failed: recent },
		]);
		for (const cap of [1, 5, 8, 9, 10, 11]) {
			expect(await countJobs('target', cap, 300, countEnv)).toBe(await original('target', cap));
		}
	});

	it('matches the original across statuses, timestamp combinations, groups, thresholds and caps', async () => {
		const jobs: Job[] = [];
		for (const status of ['running', 'pending', 'completed', 'failed', 'canceled']) {
			for (let mask = 0; mask < 8; mask++) {
				for (const group of ['target', 'other']) {
					jobs.push({
						id: status + '-' + mask + '-' + group, group, status,
						completed: mask & 1 ? recent : old,
						failed: mask & 2 ? recent : null,
						canceled: mask & 4 ? recent : old,
					});
				}
			}
		}
		await insert(jobs);
		for (const threshold of [0, 60, 300, 1000000000]) {
			for (const cap of [0, 1, 5, 40, 64, -1]) {
				expect(await countJobs('target', cap, threshold, countEnv)).toBe(await original('target', cap, threshold));
			}
		}
	});
});

describe('autoscaler migration and access paths', () => {
	it('migrates the live partial-index layout idempotently without changing jobs', async () => {
		await insert([{ id: 'keep', completed: recent, failed: recent }]);
		for (const name of ['idx_container_group_id_status', 'idx_jobs_autoscale_completed', 'idx_jobs_autoscale_failed', 'idx_jobs_autoscale_canceled']) {
			await local.DB.prepare('DROP INDEX IF EXISTS ' + name).run();
		}
		const before = await local.DB.prepare('SELECT * FROM Jobs').all();
		await executeSql(local.AUTOSCALE_MIGRATION);
		await executeSql(local.AUTOSCALE_MIGRATION);
		expect((await local.DB.prepare('SELECT * FROM Jobs').all()).results).toEqual(before.results);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(1);

		const plan = await local.DB.prepare('EXPLAIN QUERY PLAN ' + lastQuery).bind('target', 300, 64).all<{ detail: string }>();
		const details = plan.results.map((row) => row.detail).join('\n');
		expect(details).not.toMatch(/SCAN Jobs\b/);
		expect(details).toContain('idx_container_group_id');
		for (const column of ['completed', 'failed', 'canceled']) {
			expect(details).toContain('COVERING INDEX idx_jobs_autoscale_' + column);
		}
	});

	it.each(['completed', 'failed', 'canceled'] as const)('keeps %s reads small with the live partial-index layout', async (column) => {
		await local.DB.prepare('DROP INDEX IF EXISTS idx_container_group_id_status').run();
		await insert([
			...Array.from({ length: 2000 }, (_, i) => ({ id: 'history-' + i, [column]: old })),
			...Array.from({ length: 1000 }, (_, i) => ({ id: 'other-' + i, group: 'other', status: 'running' })),
			...Array.from({ length: 5 }, (_, i) => ({ id: 'recent-' + i, [column]: recent })),
		]);
		expect(await countJobs('target', 64, 300, countEnv)).toBe(5);
		const result = await local.DB.prepare(lastQuery).bind('target', 300, 64).all();
		// D1 emulator rows_read is a regression signal, not a production estimate.
		expect(result.meta.rows_read).toBeLessThan(200);
	});
});
