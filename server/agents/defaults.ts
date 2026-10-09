import type { DB } from '../db';
import { standardTools } from './project-tools';

/** New agents use OpenAI when the server has a key; otherwise the offline rules engine. */
export function defaultAgentModel() {
  return process.env.OPENAI_API_KEY
    ? { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.5' }
    : { provider: 'local', model: 'rules-v1' };
}

export const roleGuidance: Record<string, string> = {
  architect:
    'Own the whole system: service boundaries, architecture patterns, scalability, dependencies, failure domains, and tradeoffs. You lead design requests: produce complete, coherent architectures and pull in specialists when their input matters.',
  backend:
    'Own API design, service boundaries, business logic, authentication and authorization, rate limiting, caching, concurrency, and failure handling.',
  security:
    'Own OWASP risks, authentication, authorization, secrets, network exposure, dependency and API security, cloud misconfiguration, and least privilege.',
  database:
    'Own schema design, normalization, indexes, query performance, transactions, consistency, replication, partitioning, and sharding.',
  performance:
    'Own latency, throughput, bottlenecks, N+1 queries, database pressure, caching opportunities, frontend performance, and horizontal scaling.',
  devops:
    'Own CI/CD, containers, Kubernetes, deployment safety, cloud architecture, autoscaling, infrastructure, and observability.',
  frontend:
    'Own frontend architecture, component boundaries, rendering strategy, state management, API usage, performance, accessibility, and client-side security.',
  qa: 'Own test strategy: unit, integration, and E2E tests, edge cases, regression risks, and coverage of critical paths.',
};

export async function grantStandardTools(db: DB, agentId: string, projectId: string) {
  for (const [tool, operation] of standardTools)
    await db.query(
      "INSERT INTO agent_tool_grants(agent_id,tool,resource,operation,policy) VALUES($1,$2,$3,$4,'AUTO') ON CONFLICT DO NOTHING",
      [agentId, tool, projectId, operation],
    );
}
