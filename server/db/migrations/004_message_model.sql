-- The model that actually produced an agent message, so old answers keep their true origin
-- after an agent is switched to another provider.
ALTER TABLE messages ADD COLUMN model text;
UPDATE messages SET model = 'rules-v1' WHERE actor_type = 'agent' AND content LIKE '[Local rule-based review]%';
UPDATE messages m SET model = u.model
FROM usage_events u
WHERE m.model IS NULL AND m.actor_type = 'agent' AND u.run_id = m.run_id AND u.agent_id = m.agent_id AND NOT u.failed;
