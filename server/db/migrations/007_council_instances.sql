-- Several API instances can run behind a load balancer. A council session belongs to the instance
-- that runs it, so a restarting instance only fails its own interrupted sessions.
ALTER TABLE council_sessions ADD COLUMN instance_id text;
