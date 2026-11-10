import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getHighestPriorityJob } from './jobs';
import type { Env } from '../types';

const local = env as unknown as { DB: D1Database; JOBS_SCHEMA: string };
const testEnv = { DB: local.DB } as Env;

beforeEach(async () => {
 await local.DB.batch(local.JOBS_SCHEMA.split(';').filter(s => s.trim()).map(s => local.DB.prepare(s)));
});

async function insert(id: string, status: string, created: string, heartbeat: string | null,
 user = 'u1', group = 'g1', interval = 30) {
 await local.DB.prepare(`INSERT INTO Jobs
  (id, user_id, container_group_id, status, created, heartbeat, heartbeat_interval,
   command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'fixture', '', '', '', '', '', '')`)
  .bind(id, user, group, status, created, heartbeat, interval).run();
}

function recordingEnv() {
 const calls: { sql: string; bindings: unknown[]; result: D1Result }[] = [];
 const db = { prepare(sql: string) {
  return { bind(...bindings: unknown[]) {
   const statement = local.DB.prepare(sql).bind(...bindings);
   return { async all() {
    const result = await statement.all();
    calls.push({ sql, bindings, result });
    return result;
   } };
  } };
 } };
 return { calls, env: { DB: db } as unknown as Env };
}

describe('running-job selection with the chronological listing index', () => {
 it('reclaims the oldest stale running job before pending work, keeping scope and offset', async () => {
  await insert('stale-old', 'running', '2020-01-02 00:00:00', '2020-01-02 00:00:00');
  await insert('stale-new', 'running', '2020-01-03 00:00:00', '2020-01-03 00:00:00');
  await insert('pending-older', 'pending', '2020-01-01 00:00:00', null);
  await insert('other-user', 'running', '2019-01-01 00:00:00', '2019-01-01 00:00:00', 'u2');
  await insert('other-group', 'running', '2019-01-01 00:00:00', '2019-01-01 00:00:00', 'u1', 'g2');
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1'))?.id).toBe('stale-old');
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1', 1))?.id).toBe('stale-new');
  expect((await getHighestPriorityJob(testEnv, 'u2', 'g1'))?.id).toBe('other-user');
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g2'))?.id).toBe('other-group');
 });

 it('retains null-heartbeat and per-job heartbeat-interval eligibility', async () => {
  await insert('no-heartbeat', 'running', '2020-01-02 00:00:00', null);
  await insert('fresh', 'running', '2020-01-01 00:00:00', '2099-01-01 00:00:00');
  await insert('new-no-heartbeat', 'running', '2099-01-01 00:00:00', null);
  await insert('long-interval', 'running', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'u1', 'g1', 2147483647);
  await insert('pending', 'pending', '2020-01-01 00:00:00', null);
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1'))?.id).toBe('no-heartbeat');
  await local.DB.prepare("DELETE FROM Jobs WHERE id = 'no-heartbeat'").run();
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1'))?.id).toBe('pending');
 });

 it('preserves pending selection, offset, and empty results without claiming or changing jobs', async () => {
  await insert('first', 'pending', '2020-01-01 00:00:00', null);
  await insert('second', 'pending', '2020-01-02 00:00:00', null);
  await insert('done', 'completed', '2019-01-01 00:00:00', null);
  const before = (await local.DB.prepare('SELECT * FROM Jobs ORDER BY id').all()).results;
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1'))?.id).toBe('first');
  expect((await getHighestPriorityJob(testEnv, 'u1', 'g1', 1))?.id).toBe('second');
  expect(await getHighestPriorityJob(testEnv, 'u1', 'g1', 2)).toBeNull();
  expect(await getHighestPriorityJob(testEnv, 'u2', 'g1')).toBeNull();
  expect((await local.DB.prepare('SELECT * FROM Jobs ORDER BY id').all()).results).toEqual(before);
 });

 it('retains tied eligible jobs without introducing a new tie-order contract', async () => {
  await insert('tie-a', 'running', '2020-01-01 00:00:00', '2020-01-01 00:00:00');
  await insert('tie-b', 'running', '2020-01-01 00:00:00', '2020-01-01 00:00:00');
  const ids = [(await getHighestPriorityJob(testEnv, 'u1', 'g1', 0))?.id,
   (await getHighestPriorityJob(testEnv, 'u1', 'g1', 1))?.id];
  expect(ids.sort()).toEqual(['tie-a', 'tie-b']);
 });

 it('avoids scanning completed history when no running job is eligible', async () => {
  for (let chunk = 0; chunk < 50; chunk++) {
   await local.DB.batch(Array.from({ length: 100 }, (_, n) => local.DB.prepare(`INSERT INTO Jobs
    (id, user_id, container_group_id, status, created, command, input_bucket, input_prefix,
     checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
    VALUES (?, 'u1', 'g1', 'completed', '2020-01-01 00:00:00', 'fixture', '', '', '', '', '', '')`)
    .bind('history-' + (chunk * 100 + n))));
  }
  await insert('fresh-running', 'running', '2020-01-02 00:00:00', '2099-01-01 00:00:00');
  await insert('pending', 'pending', '2020-01-03 00:00:00', null);
  const recorded = recordingEnv();
  expect((await getHighestPriorityJob(recorded.env, 'u1', 'g1'))?.id).toBe('pending');
  const running = recorded.calls[0];
  const previousSql = running.sql.replace(' INDEXED BY idx_running_jobs', '');
  expect(previousSql).not.toBe(running.sql);
  const previous = await local.DB.prepare(previousSql).bind(...running.bindings).all();
  const beforePlan = await local.DB.prepare('EXPLAIN QUERY PLAN ' + previousSql).bind(...running.bindings).all<{ detail: string }>();
  const afterPlan = await local.DB.prepare('EXPLAIN QUERY PLAN ' + running.sql).bind(...running.bindings).all<{ detail: string }>();
  const afterDetails = afterPlan.results.map(r => r.detail).join('\n');
  expect(previous.results).toEqual(running.result.results);
  expect(afterDetails).toContain('idx_running_jobs');
  expect(afterDetails).not.toContain('idx_jobs_user_created');
  expect(running.result.meta.rows_read).toBeLessThan(20);
  // A future SQLite optimizer may also improve the unhinted baseline. Keep the
  // fixed-query budget mandatory without requiring the old plan to stay bad.
  expect(running.result.meta.rows_read).toBeLessThanOrEqual(previous.meta.rows_read);
  console.log(JSON.stringify({ event: 'local_claim_index_comparison', synthetic_history_rows: 5000,
   before_plan: beforePlan.results.map(r => r.detail), after_plan: afterPlan.results.map(r => r.detail),
   before_rows_read: previous.meta.rows_read, after_rows_read: running.result.meta.rows_read }));
 });
});
