-- Multiplayer conversations: many threads per project, shared by humans and agents.
CREATE TABLE conversations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title text NOT NULL, kind text NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','live_review')),
 created_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE INDEX conversations_project ON conversations(project_id,updated_at);
INSERT INTO conversations(id,project_id,title) SELECT 'general-' || id, id, 'General' FROM projects;

ALTER TABLE messages ADD COLUMN conversation_id text;
UPDATE messages SET conversation_id = 'general-' || project_id;
ALTER TABLE messages ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_fk FOREIGN KEY(project_id,conversation_id) REFERENCES conversations(project_id,id) ON DELETE CASCADE;
CREATE INDEX messages_conversation ON messages(conversation_id,created_at);

-- Runs belong to a conversation (NULL for component-thread runs). One active run per conversation
-- replaces one per project, so teammates can work with agents in parallel threads.
ALTER TABLE agent_runs ADD COLUMN conversation_id text;
ALTER TABLE agent_runs ADD COLUMN current_agent_id text;
ALTER TABLE agent_runs ADD COLUMN current_step text;
ALTER TABLE agent_runs ADD COLUMN input_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN output_tokens integer NOT NULL DEFAULT 0;
DROP INDEX one_active_run;
CREATE UNIQUE INDEX one_active_run ON agent_runs(project_id, COALESCE(conversation_id, '')) WHERE status IN ('queued','running');

-- Link agent output to the run (and therefore the message) that produced it.
ALTER TABLE proposals ADD COLUMN run_id text REFERENCES agent_runs(id);
-- Semantic operations allow re-validating a proposal on top of a newer graph.
ALTER TABLE proposals ADD COLUMN operations jsonb;
ALTER TABLE findings ADD COLUMN run_id text REFERENCES agent_runs(id);
ALTER TABLE tool_executions ADD COLUMN input_summary text NOT NULL DEFAULT '';

-- Documents written by agents or humans and reusable as project context.
CREATE TABLE artifacts (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 conversation_id text, title text NOT NULL,
 kind text NOT NULL DEFAULT 'document' CHECK(kind IN ('document','review','plan','api_spec','runbook','report','adr')),
 content text NOT NULL, revision integer NOT NULL DEFAULT 1,
 agent_id text, user_id text REFERENCES users(id), run_id text REFERENCES agent_runs(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_project ON artifacts(project_id,updated_at);

-- Existing agents receive the standard collaboration toolset; administrators can revoke it per agent.
INSERT INTO agent_tool_grants(agent_id,tool,resource,operation,policy)
SELECT a.id, t.tool, a.project_id, t.operation, 'AUTO'
FROM agents a CROSS JOIN (VALUES
 ('project.component.read','read'), ('project.search','read'), ('artifact.read','read'),
 ('architecture.propose','write'), ('finding.record','write'), ('artifact.write','write'), ('agent.ask','write')
) AS t(tool,operation)
ON CONFLICT DO NOTHING;
