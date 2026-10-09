-- Agent council: independent model "seats" (OpenAI, Gemini) each work in an isolated sandbox room,
-- consult each other through a logged channel, and produce decisions. Decisions are triaged by the
-- 4-of-5 rule: up to four unanimous decisions are accepted automatically, the rest wait for a senior review.
CREATE TABLE council_sessions (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 requested_by text NOT NULL REFERENCES users(id), topic text NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','limit_reached','failed')),
 phase text NOT NULL DEFAULT 'sandbox',
 time_limit_seconds integer NOT NULL, token_limit integer NOT NULL,
 tokens_used integer NOT NULL DEFAULT 0, embedding_tokens integer NOT NULL DEFAULT 0,
 documents_used integer NOT NULL DEFAULT 0, rag_mode text,
 trace_id text, trace_url text, error text, report_artifact_id text,
 started_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz NOT NULL, finished_at timestamptz
);
CREATE UNIQUE INDEX one_active_council ON council_sessions(project_id) WHERE status = 'running';
CREATE INDEX council_sessions_project ON council_sessions(project_id, started_at);

CREATE TABLE council_events (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
 seq integer NOT NULL, room text NOT NULL CHECK(room IN ('openai','google','shared','system')),
 kind text NOT NULL, content jsonb NOT NULL DEFAULT '{}',
 input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, latency_ms integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, seq)
);

CREATE TABLE council_decisions (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position integer NOT NULL,
 title text NOT NULL, rationale text NOT NULL, risk text NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH')),
 votes jsonb NOT NULL DEFAULT '[]', score real NOT NULL DEFAULT 0,
 status text NOT NULL CHECK(status IN ('auto_accepted','pending_review','approved','rejected')),
 triage_reason text NOT NULL DEFAULT '',
 reviewed_by text REFERENCES users(id), reviewed_at timestamptz, review_note text
);
CREATE INDEX council_decisions_review ON council_decisions(project_id) WHERE status = 'pending_review';
