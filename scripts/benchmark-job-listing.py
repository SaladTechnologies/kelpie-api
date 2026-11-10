#!/usr/bin/env python3
"""Offline SQLite comparison only; no credentials, production data or network.

Reads the current bootstrap schema, removes only the proposed index for baseline,
then applies the exact additive migration. Timings and VM steps are local signals,
not D1 billing counters or production savings estimates.
"""
import argparse
import datetime
import json
import pathlib
import random
import sqlite3
import statistics
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--rows', type=int, default=100000)
args = parser.parse_args()
if args.rows < 10000:
    parser.error('--rows must be at least 10000')
db = sqlite3.connect(':memory:')
db.executescript((ROOT / 'schemas/jobs.sql').read_text())
db.execute('DROP INDEX idx_jobs_user_created')
rng = random.Random(7)
base = datetime.datetime(2025, 1, 1)
statuses = ['completed', 'completed', 'completed', 'failed', 'canceled', 'pending', 'running']
rows = []
for i in range(args.rows):
    user = rng.randrange(20)
    group = rng.randrange(4)
    # Several rows deliberately share a timestamp; the API does not define tie order.
    created = (base + datetime.timedelta(seconds=i // 3)).isoformat(' ')
    rows.append((f'job-{i:08}', f'user-{user}', f'group-{group}', rng.choice(statuses), created))
db.executemany("""INSERT INTO Jobs (id, user_id, container_group_id, status, created,
 command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
 VALUES (?, ?, ?, ?, ?, 'synthetic', '', '', '', '', '', '')""", rows)
db.commit()
cases = [
    ('user_first', 'user_id = ?', ['user-1'], 0),
    ('user_deep', 'user_id = ?', ['user-1'], 4000),
    ('user_status', 'user_id = ? AND status = ?', ['user-1', 'completed'], 0),
    ('user_group', 'user_id = ? AND container_group_id = ?', ['user-1', 'group-1'], 0),
    ('user_status_group', 'user_id = ? AND status = ? AND container_group_id = ?', ['user-1', 'completed', 'group-1'], 0),
    ('user_pending', 'user_id = ? AND status = ?', ['user-1', 'pending'], 0),
    ('admin_all', '', [], 0),
    ('admin_status', 'status = ?', ['completed'], 0),
    ('admin_group', 'container_group_id = ?', ['group-1'], 0),
]
def size():
    return db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]
def measure():
    output = {}
    for name, predicate, values, offset in cases:
        query = 'SELECT * FROM Jobs' + (' WHERE ' + predicate if predicate else '') + ' ORDER BY created DESC LIMIT ? OFFSET ?'
        params = values + [100, offset]
        plans = [r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + query, params)]
        durations = []
        for _ in range(5):
            start = time.perf_counter()
            result = db.execute(query, params).fetchall()
            durations.append((time.perf_counter() - start) * 1000)
        steps = [0]
        def progress():
            steps[0] += 100
            return 0
        db.set_progress_handler(progress, 100)
        result = db.execute(query, params).fetchall()
        db.set_progress_handler(None, 0)
        output[name] = {'plan': plans, 'median_ms': round(statistics.median(durations), 3), 'approx_vm_steps': steps[0], 'returned': len(result)}
    return output
before = measure()
baseline_bytes = size()
start = time.perf_counter()
db.executescript((ROOT / 'migrations/0004_add_job_listing_index.sql').read_text())
build_ms = (time.perf_counter() - start) * 1000
after = measure()
print(json.dumps({'sqlite_version': sqlite3.sqlite_version, 'rows': args.rows,
 'notes': 'Synthetic local SQLite, warm cache median of 5; VM instructions are NOT rows read. Equal-timestamp ordering is unspecified. Admin queries unchanged. No ANALYZE forcing or production data.',
 'database_bytes_before': baseline_bytes, 'database_bytes_after': size(),
 'index_added_bytes': size() - baseline_bytes, 'index_build_ms': round(build_ms, 3),
 'before': before, 'after': after}, indent=2))
