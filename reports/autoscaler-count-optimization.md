# Autoscaler count optimization

## Scope and status

Implemented locally on MaksimGorkiiGPU, Ubuntu-22.04 WSL, in `/home/mgorkii/projects/kelpie-api`, branch `fix/autoscaler-query-and-safeguards`, based on local `main` / `origin/main` at `434339092f2b1a0ffaf150ec3ff6bdfe71fa5614`.

No production deployment, remote D1 command, production write, retention deletion, or object-storage change was performed during implementation and isolation. Later commit/push status is recorded separately in the branch history. All 29 original modified/untracked files were backed up and hash-verified. The 16 deferred auth/cache, scaling-rule idempotency and user-migration files are preserved byte-for-byte in stash `284e96c197222f983884ec50b580cbfcf4bc80d0`. The original `fix/customer-reliability-hardening` branch remains at `fd34e89`. No unrelated authentication commit is inherited by this focused branch.

The motivating production observation supplied for this task was `SCAN Jobs` and roughly 1.2 million rows read per count. This task did not re-query production. All measurements below are synthetic local results.

## Change

The old count combines active status and three recent timestamps in one OR. Live active-only partial indexes cannot cover the whole OR. The earlier group/status-index approach narrows a scan to a container group, but still walks a quiet group's historical rows.

The focused branch also includes the small autoscaler safeguards: per-rule failure isolation, non-destructive handling of ambiguous 404s, group-identity checks before counting/scaling, lookup reuse, and visible Cron-level failures.

The new query performs four independent, capped indexed lookups:

1. Running or pending jobs in the requested group.
2. Jobs with a recent completed timestamp.
3. Jobs with a recent failed timestamp.
4. Jobs with a recent canceled timestamp.

Each lookup is limited to the requested replica cap. UNION deduplicates job IDs before applying the final cap and count. Timestamp predicates remain independent of current status, preserving jobs that have both an active state and a historical terminal timestamp, or several terminal timestamps.

For a nonnegative integer cap K, at most 4K candidate IDs enter deduplication. If any branch contains K jobs, it alone supplies enough distinct IDs; otherwise every branch is complete. This preserves min(K, original matching jobs). Zero returns zero. Legacy negative limits still mean unlimited, so the work bound does not apply to negative input.

Three additive partial covering indexes support group/timestamp range lookups:
- `(container_group_id, completed, id) WHERE completed IS NOT NULL`
- `(container_group_id, failed, id) WHERE failed IS NOT NULL`
- `(container_group_id, canceled, id) WHERE canceled IS NOT NULL`

The active branch works with the live partial index. Migration 0003 has no dependency on migrations 0001 or 0002. The earlier broad group/status index is intentionally excluded from this branch's schema; the benchmark constructs it only as an in-memory comparison. The IDs are unique and non-null in the schema. The same SQLite datetime expression, inclusive cutoff, and one-statement clock semantics are retained.

## Validation

Passed:
- `npm run test:autoscale`: all 18 focused tests passed (11 isolated D1 query/index tests and 7 autoscaler safeguards tests).
- Earlier combined-tree validation passed 11 D1 tests plus 28 older unit tests. Auth/cache/provisioning tests belong to the deferred stash and are not part of this focused branch.
- `./node_modules/.bin/tsc --noEmit`.
- Reproducible synthetic benchmark with identical counts across all variants.

Coverage includes:
- Active/null/old timestamps, inclusive cutoff and future timestamps.
- Each terminal timestamp regardless of current status.
- Cross-branch duplicates and capped overlapping branches.
- Empty and different groups, K/K+1/zero/negative caps.
- A status/timestamp/group/threshold/cap equivalence matrix against the original SQL.
- Idempotent migration on the live partial-index layout, retaining all fixture rows.
- Covering-index plans for each timestamp range and no `SCAN Jobs`.
- Completed, failed and canceled history cases, each with 2,000 historical target rows, 1,000 active other-group rows and 5 recent target rows. Each query stayed below 200 local D1 `rows_read`.

The default `npm test` command runs the dedicated query-and-autoscaler suite first. Default Vitest discovery excludes those two files to avoid duplicate execution; D1 schema bindings are supplied only by the dedicated, credential-free config.

Not run:
- The full HTTP integration suite, which expects a separately running service at localhost:8787 and real authentication fixtures in some tests.
- Production D1 performance, remote migration, end-to-end live scaling, deployment or CI.

## Synthetic performance

Command: `npm run benchmark:autoscale -- --output reports/autoscaler-count-benchmark.json`

SQLite 3.37.2, in-memory database, 1,206,007 rows, cap 64, idle threshold 300 seconds, median of five warm runs. Quiet group contains 900,000 historical rows and 7 recent jobs.

| Workload | Original, live partial indexes | Original, comparison group/status index | Focused query and timestamp indexes only |
| --- | ---: | ---: | ---: |
| Missing group | 69.3017 ms | 0.0014 ms | 0.0055 ms |
| Quiet historical group | 131.8604 ms | 223.3823 ms | 0.0072 ms |
| Busy active group | 69.4161 ms | 0.0070 ms | 0.0200 ms |
| Busy recently completed group | 68.6794 ms | 0.0130 ms | 0.0180 ms |
| Overlapping active/terminal matches | 69.3330 ms | 0.0048 ms | 0.0523 ms |

All result counts matched (0, 7 or 64 as appropriate). The quiet workload dropped from about 15.3 million SQLite VM operations to about 300 with only the timestamp indexes. VM operations are not D1 billed rows. The benchmark separately verifies the optimized query without the comparison group/status index; all workload plans still use the intended indexes.

Busy/missing groups already served efficiently by the comparison group/status index have some extra bounded UNION overhead. This is an intentional tradeoff for avoiding unbounded historical scans. Local microsecond timings are not production latency or a promised speedup.

Synthetic timestamp index sizes:
- completed: 28,975,104 bytes, 404,007 entries.
- failed: 28,864,512 bytes, 402,000 entries.
- canceled: 28,864,512 bytes, 402,000 entries.
- Combined: 86,704,128 bytes, about 82.7 MiB.

Index entries depend on actual non-null timestamp counts and field sizes. A job can occupy several timestamp indexes. Real database size and storage headroom must be checked before applying them. New inserts/transitions also incur index write cost.

## Rollout plan, not executed

1. Review and commit only this focused branch after final approval. Deferred work remains in the named stash on its original base; apply it on the original branch when that work resumes. No commit was made during isolation.
2. Inspect actual production schema, database/index size, non-null timestamp counts and D1 capacity/headroom through an approved read-only check. Choose a low-traffic change window.
3. Obtain explicit approval to apply `migrations/0003_add_autoscale_timestamp_indexes.sql`. Index construction scans Jobs, writes index pages and may delay database work. It does not delete application rows.
4. Apply the additive migration before deploying the query. Do not run `setup-db.sh` or `schemas/jobs.sql` against production: they drop tables.
5. Verify all four branch plans, especially the group/timestamp ranges.
6. After separate deployment approval, deploy the query and verify production `rows_read`, p95 query latency, errors, and replica decisions for quiet, busy and overlapping-state groups.
7. If a worker rollback is needed, restore the prior query through the normal release process; the additive indexes can remain. Any later index removal is a separate change.

## Retention assessment, separate work

No retention implementation or deletion is included. This fix makes counting recent/active jobs independent of old-history volume, so retention is not required to solve this query's scan.

The repository has explicit clear/purge operations but no discovered age-based terminal-job retention policy. The current container-group purge removes pending jobs and cancels running jobs; it is not a terminal-history cleanup mechanism and must not be reused for retention.

A future retention design needs user/customer agreement on API-visible job history, audits, retries, support and recovery requirements. It should exclude active jobs, account for every terminal timestamp and the actual maximum persisted idle window, and define archive/export and restore behavior before deletion. Current API validation caps new idle thresholds at 3,600 seconds, but persisted/legacy values must still be checked. Prefer a bounded, separately reviewed cleanup/archive process after an approved policy. Worker object-storage inputs, outputs and checkpoints are a distinct lifecycle and are out of scope.
