CREATE INDEX idx_container_group_id ON Jobs (status, container_group_id)
WHERE
  status = 'running' OR status = 'pending';