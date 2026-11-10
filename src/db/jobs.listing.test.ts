import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { listJobsWithArbitraryFilter as listJobs } from './jobs';
import { ListJobs } from '../routes/jobs';
import type { Env } from '../types';

const local = env as unknown as { DB: D1Database; JOBS_SCHEMA: string; LISTING_MIGRATION: string };
const testEnv = { DB: local.DB } as Env;
async function executeSql(sql: string) {
 await local.DB.batch(sql.split(';').filter((s) => s.trim()).map((s) => local.DB.prepare(s)));
}
async function insert(id: string, user: string, group: string, status: string, created: string) {
 await local.DB.prepare(`INSERT INTO Jobs (id, user_id, container_group_id, status, created,
 command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
 VALUES (?, ?, ?, ?, ?, 'keep-command', 'input', 'prefix', 'checkpoint', 'cp', 'output', 'op')`)
 .bind(id, user, group, status, created).run();
}
beforeEach(async () => {
 await executeSql(local.JOBS_SCHEMA);
 await insert('a', 'u1', 'g1', 'completed', '2026-01-01 00:00:00');
 await insert('b', 'u1', 'g1', 'pending', '2026-01-02 00:00:00');
 await insert('c', 'u1', 'g2', 'running', '2026-01-03 00:00:00');
 await insert('d', 'u2', 'g1', 'failed', '2026-01-04 00:00:00');
 await insert('e', 'u1', 'g1', 'canceled', '2026-01-05 00:00:00');
});

describe('job listing indexed pagination', () => {
 it('preserves tenant isolation, full fields and chronological pages', async () => {
  const first = await listJobs({ user_id: 'u1' }, false, 2, 1, testEnv);
  const second = await listJobs({ user_id: 'u1' }, false, 2, 2, testEnv);
  expect(first.map((j) => j.id)).toEqual(['e', 'c']);
  expect(second.map((j) => j.id)).toEqual(['b', 'a']);
  expect(first[0]).toMatchObject({ command: 'keep-command', input_bucket: 'input', checkpoint_prefix: 'cp', user_id: 'u1' });
  expect(await listJobs({ user_id: 'u1' }, false, 2, 3, testEnv)).toEqual([]);
  expect((await listJobs({ user_id: 'u1' }, true, 2, 1, testEnv)).map((j) => j.id)).toEqual(['a', 'b']);
 });
 it('preserves all supported filter combinations, including admin-wide queries', async () => {
  for (const [filter, ids] of [
   [{ user_id: 'u1', status: 'pending' }, ['b']],
   [{ user_id: 'u1', container_group_id: 'g1' }, ['e', 'b', 'a']],
   [{ user_id: 'u1', status: 'completed', container_group_id: 'g1' }, ['a']],
   [{}, ['e', 'd', 'c', 'b', 'a']],
   [{ status: 'failed' }, ['d']],
   [{ container_group_id: 'g1' }, ['e', 'd', 'b', 'a']],
   [{ status: 'running', container_group_id: 'g1' }, []],
  ] as const) {
   expect((await listJobs(filter, false, 100, 1, testEnv)).map((j) => j.id)).toEqual(ids);
  }
 });
 it('retains equal-timestamp rows without promising a new tie-break contract', async () => {
  await insert('tie', 'u1', 'g2', 'completed', '2026-01-03 00:00:00');
  for (const asc of [true, false]) {
   const all = await listJobs({ user_id: 'u1' }, asc, 100, 1, testEnv);
   expect(all.map((j) => j.id).sort()).toEqual(['a', 'b', 'c', 'e', 'tie']);
   const times = all.map((j) => j.created);
   expect(times).toEqual([...times].sort((a, b) => asc ? String(a).localeCompare(String(b)) : String(b).localeCompare(String(a))));
  }
 });
 it('rejects invalid pagination without issuing a database query and returns HTTP 400', async () => {
  for (const [pageSize, page] of [[0, 1], [-1, 1], [1.5, 1], [1, 0], [1, -2], [1, 2.5], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER, 3]]) {
   await expect(listJobs({}, false, pageSize, page, testEnv)).rejects.toThrow(RangeError);
   const response = await new ListJobs({ raiseUnknownParameters: false, skipValidation: false }).handle({ userId: 'u1' } as any, testEnv, {}, { query: { page_size: pageSize, page, asc: false } });
   expect((response as Response).status).toBe(400);
  }
 });
 it('keeps response count as returned-page length and valid large page sizes accepted', async () => {
  const route = new ListJobs({ raiseUnknownParameters: false, skipValidation: false });
  const response = await route.handle({ userId: 'u1' } as any, testEnv, {}, { query: { page_size: 2, page: 2, asc: false } });
  expect(response).toMatchObject({ _count: 2 });
  expect((response as any).jobs).toHaveLength(2);
  expect(await listJobs({ user_id: 'u1' }, false, 10000, 1, testEnv)).toHaveLength(4);
 });
 it('applies the additive migration twice without altering rows or other indexes', async () => {
  await local.DB.prepare('DROP INDEX idx_jobs_user_created').run();
  const rows = (await local.DB.prepare('SELECT * FROM Jobs ORDER BY id').all()).results;
  const indexes = (await local.DB.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='Jobs' ORDER BY name").all()).results;
  await executeSql(local.LISTING_MIGRATION);
  await executeSql(local.LISTING_MIGRATION);
  expect((await local.DB.prepare('SELECT * FROM Jobs ORDER BY id').all()).results).toEqual(rows);
  const after = (await local.DB.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='Jobs' ORDER BY name").all()).results;
  expect(after).toEqual([...indexes, { name: 'idx_jobs_user_created' }].sort((a, b) => String(a.name).localeCompare(String(b.name))));
 });
 it('seeks by user without a temporary sort and reduces local D1 rows read', async () => {
  for (let chunk = 0; chunk < 20; chunk++) {
   await local.DB.batch(Array.from({ length: 100 }, (_, n) => local.DB.prepare(`INSERT INTO Jobs
    (id, user_id, container_group_id, created, command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
    VALUES (?, 'other', 'g1', '2026-01-06 00:00:00', 'x', '', '', '', '', '', '')`).bind('other-' + (chunk * 100 + n))));
  }
  const query = 'SELECT * FROM Jobs WHERE user_id = ? ORDER BY created DESC LIMIT ? OFFSET ?';
  await local.DB.prepare('DROP INDEX idx_jobs_user_created').run();
  const before = await local.DB.prepare(query).bind('u1', 2, 0).all();
  await executeSql(local.LISTING_MIGRATION);
  const after = await local.DB.prepare(query).bind('u1', 2, 0).all();
  expect(after.results).toEqual(before.results);
  const plan = await local.DB.prepare('EXPLAIN QUERY PLAN ' + query).bind('u1', 2, 0).all<{ detail: string }>();
  const details = plan.results.map((r) => r.detail).join('\n');
  expect(details).toContain('idx_jobs_user_created');
  expect(details).not.toContain('TEMP B-TREE');
  expect(after.meta.rows_read).toBeLessThan(before.meta.rows_read);
  expect(after.meta.rows_read).toBeLessThan(20);
 });
});
