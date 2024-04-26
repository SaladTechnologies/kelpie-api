DROP TABLE IF EXISTS ScalingRules;

CREATE TABLE ScalingRules (
  container_group_id UNIQUEIDENTIFIER PRIMARY KEY NOT NULL,
  org_name TEXT NOT NULL,
  project_name TEXT NOT NULL,
  container_group_name TEXT NOT NULL,
  user_id UNIQUEIDENTIFIER NOT NULL,
  created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  min_replicas INT NOT NULL DEFAULT 0,
  max_replicas INT NOT NULL DEFAULT 100,
  idle_threshold_seconds INT NOT NULL DEFAULT 300
);

CREATE INDEX idx_user_id ON ScalingRules (user_id);