DROP TABLE IF EXISTS Jobs;

CREATE TABLE IF NOT EXISTS Jobs (
  -- System Managed Columns
  id UNIQUEIDENTIFIER PRIMARY KEY NOT NULL,
  user_id UNIQUEIDENTIFIER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started TIMESTAMP,
  completed TIMESTAMP,
  canceled TIMESTAMP,
  failed TIMESTAMP,
  heartbeat TIMESTAMP,
  num_failures INT NOT NULL DEFAULT 0,
  machine_id TEXT,

  -- User Provided Columns
  command TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '[]',
  environment TEXT NOT NULL DEFAULT '{}',
  input_bucket TEXT NOT NULL,
  input_prefix TEXT NOT NULL,
  checkpoint_bucket TEXT NOT NULL,
  checkpoint_prefix TEXT NOT NULL,
  output_bucket TEXT NOT NULL,
  output_prefix TEXT NOT NULL,
  max_failures INT NOT NULL DEFAULT 3,
  heartbeat_interval INT NOT NULL DEFAULT 30,
  container_group_id TEXT NOT NULL,
  webhook TEXT
);

CREATE INDEX idx_running_jobs ON Jobs (status, user_id, container_group_id, heartbeat, created)
WHERE
  status = 'running';

CREATE INDEX idx_pending_jobs ON Jobs (status, user_id, container_group_id, created)
WHERE
  status = 'pending';

CREATE INDEX idx_container_group_id ON Jobs (status, container_group_id)
WHERE
  status = 'running' OR status = 'pending';