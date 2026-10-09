-- Personal inbox. Rows are only returned while the recipient is still a project member.
CREATE TABLE notifications (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('mention','approval_request','critical_finding','run_completed','run_failed','drift_detected')),
 title text NOT NULL, body text NOT NULL DEFAULT '', page text, component_id text, actor_name text,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox ON notifications(user_id,created_at);

-- Agents can reply inside component threads. Exactly one author kind per comment.
ALTER TABLE comments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE comments ADD COLUMN agent_id text;
ALTER TABLE comments ADD CONSTRAINT comments_agent_fk FOREIGN KEY(project_id,agent_id) REFERENCES agents(project_id,id) ON DELETE CASCADE;
ALTER TABLE comments ADD CONSTRAINT comments_single_author CHECK((user_id IS NULL) <> (agent_id IS NULL));

-- Explicitly @mentioned agents all start a run at delegation depth zero.
ALTER TABLE agent_runs ADD COLUMN participant_ids jsonb NOT NULL DEFAULT '[]';

-- Observe mode: an observed system (e.g. Docker Compose) compared with the designed graph.
CREATE TABLE observations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_name text NOT NULL, format text NOT NULL, revision integer NOT NULL,
 observed jsonb NOT NULL, drift jsonb NOT NULL, created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_project ON observations(project_id,created_at);
