DROP TABLE IF EXISTS Jobs;

CREATE TABLE IF NOT EXISTS Jobs (
  id UNIQUEIDENTIFIER PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started TIMESTAMP,
  completed TIMESTAMP,
  canceled TIMESTAMP,
  failed TIMESTAMP,
  script TEXT NOT NULL DEFAULT '/app/run.sh',
  launch_arguments TEXT NOT NULL DEFAULT '[]',
  input_prefix TEXT NOT NULL,
  checkpoint_prefix TEXT NOT NULL,
  output_prefix TEXT NOT NULL,
  webhook TEXT,
  heartbeat TIMESTAMP,
  num_failures INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_running_jobs ON Jobs (status, heartbeat, created)
WHERE
  status = 'running';

CREATE INDEX idx_pending_jobs ON Jobs (status, created)
WHERE
  status = 'pending';