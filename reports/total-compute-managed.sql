SELECT
	SUM(num_heartbeats * heartbeat_interval) AS total_seconds
FROM
	Jobs
WHERE
	status NOT IN ('failed', 'canceled');
