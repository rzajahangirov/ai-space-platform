CREATE TABLE users (
 id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text,
 oidc_subject text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE workspaces (id text PRIMARY KEY, name text NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE workspace_members (
 workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE, user_id text REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER')), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE projects (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), name text NOT NULL, description text NOT NULL DEFAULT '',
 environment text NOT NULL DEFAULT 'Production', revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_members (
 project_id text REFERENCES projects(id) ON DELETE CASCADE, user_id text REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('OWNER','ADMIN','EDITOR','REVIEWER','VIEWER')), PRIMARY KEY(project_id,user_id)
);
CREATE TABLE invitations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, token_hash text UNIQUE NOT NULL,
 role text NOT NULL CHECK(role IN ('ADMIN','EDITOR','REVIEWER','VIEWER')), email text,
 created_by text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, accepted_by text REFERENCES users(id), accepted_at timestamptz
);
CREATE TABLE components (
 id text NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL, category text NOT NULL,
 technology text NOT NULL, description text NOT NULL DEFAULT '', x double precision NOT NULL, y double precision NOT NULL,
 config jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(project_id,id)
);
CREATE TABLE edges (
 id text NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source text NOT NULL, target text NOT NULL,
 protocol text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(project_id,id),
 FOREIGN KEY(project_id,source) REFERENCES components(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,target) REFERENCES components(project_id,id) ON DELETE CASCADE,
 CHECK(source <> target)
);
CREATE TABLE architecture_views (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL, categories jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE architecture_versions (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision integer NOT NULL,
 graph jsonb NOT NULL, summary text NOT NULL, actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,revision)
);
CREATE TABLE agents (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name text NOT NULL, role text NOT NULL, description text NOT NULL DEFAULT '', provider text NOT NULL DEFAULT 'local', model text NOT NULL DEFAULT 'rules-v1',
 instructions text NOT NULL DEFAULT '', capabilities jsonb NOT NULL DEFAULT '[]', settings jsonb NOT NULL DEFAULT '{}',
 enabled boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'idle', created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE TABLE skills (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), name text NOT NULL, instructions text NOT NULL,
 required_tools jsonb NOT NULL DEFAULT '[]', output_format text NOT NULL DEFAULT 'AgentOutput', validation_rules jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 1
);
CREATE TABLE agent_skills (agent_id text REFERENCES agents(id) ON DELETE CASCADE, skill_id text REFERENCES skills(id) ON DELETE CASCADE, PRIMARY KEY(agent_id,skill_id));
CREATE TABLE agent_tool_grants (
 agent_id text REFERENCES agents(id) ON DELETE CASCADE, tool text NOT NULL, resource text NOT NULL,
 operation text NOT NULL, policy text NOT NULL CHECK(policy IN ('AUTO','APPROVAL_REQUIRED','DISABLED')), PRIMARY KEY(agent_id,tool,resource,operation)
);
CREATE TABLE agent_runs (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, requested_by text NOT NULL REFERENCES users(id),
 prompt text NOT NULL, component_id text, target_agent_id text, status text NOT NULL DEFAULT 'queued', source text NOT NULL DEFAULT 'human',
 turns integer NOT NULL DEFAULT 0, reserved_tokens integer NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX one_active_run ON agent_runs(project_id) WHERE status IN ('queued','running');
CREATE TABLE events (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX pending_events ON events(created_at) WHERE processed_at IS NULL;
CREATE TABLE messages (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id text REFERENCES users(id),
 agent_id text, run_id text REFERENCES agent_runs(id), actor_type text NOT NULL CHECK(actor_type IN ('human','agent','system')),
 author_name text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,agent_id) REFERENCES agents(project_id,id)
);
CREATE INDEX message_project ON messages(project_id,created_at);
CREATE TABLE findings (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id text NOT NULL, component_id text,
 category text NOT NULL, severity text NOT NULL CHECK(severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')), confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 title text NOT NULL, description text NOT NULL, evidence text NOT NULL, impact text NOT NULL, recommendation text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED','DISMISSED')), fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,fingerprint), FOREIGN KEY(project_id,agent_id) REFERENCES agents(project_id,id)
);
CREATE TABLE proposals (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id text NOT NULL,
 title text NOT NULL, reason text NOT NULL, risk text NOT NULL, tradeoffs text NOT NULL, changes jsonb NOT NULL,
 base_revision integer NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 decided_by text REFERENCES users(id), decided_at timestamptz, before_state jsonb, after_state jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,agent_id) REFERENCES agents(project_id,id)
);
CREATE TABLE comments (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, component_id text NOT NULL,
 user_id text NOT NULL REFERENCES users(id), content text NOT NULL, resolved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,component_id) REFERENCES components(project_id,id) ON DELETE CASCADE
);
CREATE TABLE audit_logs (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, actor_id text NOT NULL,
 actor_type text NOT NULL, actor_name text NOT NULL, action text NOT NULL, resource text NOT NULL, detail text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_project ON audit_logs(project_id,created_at);
CREATE TABLE usage_events (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), agent_id text NOT NULL REFERENCES agents(id), run_id text NOT NULL REFERENCES agent_runs(id),
 user_id text NOT NULL REFERENCES users(id), model text NOT NULL, input_tokens integer NOT NULL, output_tokens integer NOT NULL,
 estimated_cost numeric(12,6), latency_ms integer NOT NULL, failed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tool_executions (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), agent_id text NOT NULL REFERENCES agents(id), run_id text REFERENCES agent_runs(id),
 tool text NOT NULL, resource text NOT NULL, operation text NOT NULL, policy text NOT NULL, status text NOT NULL,
 duration_ms integer NOT NULL DEFAULT 0, result_summary text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_sources (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL,
 kind text NOT NULL, content text NOT NULL, component_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE repository_connections (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner text NOT NULL, repository text NOT NULL,
 branch text NOT NULL DEFAULT 'main', UNIQUE(project_id,owner,repository), UNIQUE(project_id,id)
);
CREATE TABLE component_repository_mappings (
 project_id text NOT NULL, component_id text NOT NULL, repository_id text NOT NULL, path text NOT NULL,
 PRIMARY KEY(project_id,component_id,repository_id,path), FOREIGN KEY(project_id,component_id) REFERENCES components(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,repository_id) REFERENCES repository_connections(project_id,id) ON DELETE CASCADE
);
