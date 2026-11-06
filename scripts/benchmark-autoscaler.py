#!/usr/bin/env python3
"""Local-only reproducible autoscaler benchmark; no credentials or network."""
import argparse
import datetime
import json
import pathlib
import re
import sqlite3
import statistics
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGINAL = """
SELECT COUNT(*) FROM (
 SELECT 1 FROM Jobs WHERE container_group_id = ? AND (
  status = 'running' OR status = 'pending'
  OR completed >= datetime('now', '-' || ? || ' seconds')
  OR failed >= datetime('now', '-' || ? || ' seconds')
  OR canceled >= datetime('now', '-' || ? || ' seconds')
 ) LIMIT ?
)
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1_200_000)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    if args.rows < 4 or args.repeats < 1:
        parser.error("--rows must be >= 4 and --repeats >= 1")

    source = (ROOT / "src/db/jobs.ts").read_text()
    function = source.split("export async function countActiveAndRecentlyActiveJobsInContainerGroup(", 1)[1]
    optimized = re.search(r"const query = `([\s\S]*?)`;", function).group(1)
    schema = (ROOT / "schemas/jobs.sql").read_text()
    schema = re.sub(r"CREATE INDEX(?: IF NOT EXISTS)? idx_container_group_id_status[^;]*;", "", schema)
    schema = re.sub(r"CREATE INDEX IF NOT EXISTS idx_jobs_autoscale_[^;]*;", "", schema)

    db = sqlite3.connect(":memory:")
    db.executescript(schema)
    now = db.execute("SELECT datetime('now')").fetchone()[0]
    old = "2020-01-01 00:00:00"
    sql = """
INSERT INTO Jobs (id, user_id, container_group_id, status, completed, failed, canceled,
 command, input_bucket, input_prefix, checkpoint_bucket, checkpoint_prefix, output_bucket, output_prefix)
VALUES (?, 'synthetic-user', ?, ?, ?, ?, ?, 'test', '', '', '', '', '', '')
"""
    started = time.perf_counter()
    def historical():
        for i in range(args.rows):
            group = "quiet" if i < args.rows * 3 // 4 else "other"
            column = i % 3
            hex_id = f"{i:032x}"
            identifier = f"{hex_id[:8]}-{hex_id[8:12]}-{hex_id[12:16]}-{hex_id[16:20]}-{hex_id[20:]}"
            yield (identifier, group, ("completed", "failed", "canceled")[column],
                   old if column == 0 else None,
                   old if column == 1 else None,
                   old if column == 2 else None)
    db.executemany(sql, historical())
    for group, count in [("quiet", 7), ("busy_active", 2000), ("busy_recent", 2000), ("overlap", 2000)]:
        db.executemany(sql, (
            (group + str(i), group,
             "running" if group in ("busy_active", "overlap") else "completed",
             now if group != "busy_active" else None,
             now if group == "overlap" else None,
             now if group == "overlap" else None)
            for i in range(count)
        ))
    db.commit()
    report = {
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sqlite_version": sqlite3.sqlite_version,
        "synthetic_rows": db.execute("SELECT count(*) FROM Jobs").fetchone()[0],
        "historical_rows": args.rows,
        "quiet_group_historical_rows": args.rows * 3 // 4,
        "cap": 64,
        "idle_threshold_seconds": 300,
        "load_seconds": round(time.perf_counter() - started, 3),
        "notes": [
            "Synthetic local in-memory SQLite, not production D1 latency or billed rows.",
            "VM steps are interpreter operations, not rows_read; rounded down to multiples of 100.",
            "Timing is median of warm runs without VM instrumentation.",
            "All stages use the same dataset and assert identical bounded counts.",
        ],
        "stages": [],
    }

    def measure(label, query, new=False, build_ms=None):
        stage = {"name": label, "index_build_ms": build_ms, "workloads": []}
        for group, expected in [("missing", 0), ("quiet", 7), ("busy_active", 64), ("busy_recent", 64), ("overlap", 64)]:
            bindings = (group, 300, 64) if new else (group, 300, 300, 300, 64)
            assert db.execute(query, bindings).fetchone()[0] == expected
            durations = []
            for _ in range(args.repeats):
                start = time.perf_counter()
                result = db.execute(query, bindings).fetchone()[0]
                durations.append((time.perf_counter() - start) * 1000)
                assert result == expected
            steps = [0]
            def progress():
                steps[0] += 100
                return 0
            db.set_progress_handler(progress, 100)
            db.execute(query, bindings).fetchone()
            db.set_progress_handler(None, 0)
            plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + query, bindings)]
            if new:
                assert not any(re.search(r"SCAN Jobs\b", item) for item in plan), plan
                for column in ("completed", "failed", "canceled"):
                    assert any("COVERING INDEX idx_jobs_autoscale_" + column in item for item in plan), plan
            stage["workloads"].append({
                "group": group, "result": result,
                "median_ms": round(statistics.median(durations), 4),
                "vm_steps_approx": steps[0], "plan": plan,
            })
        report["stages"].append(stage)

    measure("live partial indexes / original query", ORIGINAL)
    start = time.perf_counter()
    # Compare with the older proposed group-only approach without requiring
    # its separate migration in this narrowly scoped branch.
    db.execute("CREATE INDEX idx_container_group_id_status ON Jobs (container_group_id, status)")
    measure("comparison group-status index / original query", ORIGINAL, build_ms=round((time.perf_counter() - start) * 1000, 3))
    start = time.perf_counter()
    migration = (ROOT / "migrations/0003_add_autoscale_timestamp_indexes.sql").read_text()
    db.executescript(migration)
    build_ms = round((time.perf_counter() - start) * 1000, 3)
    db.executescript(migration)  # Idempotency on the same dataset.
    measure("timestamp indexes / bounded deduplicated query", optimized, True, build_ms)
    db.execute("DROP INDEX idx_container_group_id_status")
    measure("timestamp indexes without comparison group-status index / bounded query", optimized, True)
    try:
        report["index_sizes"] = [
            {"name": name, "bytes": size, "entries": entries}
            for name, size, entries in db.execute(
                "SELECT name, SUM(pgsize), SUM(ncell) FROM dbstat "
                "WHERE name LIKE 'idx_jobs_autoscale_%' GROUP BY name"
            )
        ]
    except sqlite3.OperationalError:
        report["index_sizes"] = None
    output = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
        print("Saved " + str(args.output))
        for stage in report["stages"]:
            print(stage["name"])
            for item in stage["workloads"]:
                print("  {group}: {result} jobs, {median_ms} ms median, ~{vm_steps_approx} VM steps".format(**item))
        print("Timestamp index sizes:", report["index_sizes"])
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
