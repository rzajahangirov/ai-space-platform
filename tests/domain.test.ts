import { describe, it, expect } from 'vitest';
import { can } from '../server/core';
import { applyMutations } from '../server/graph';
import { agentOutputSchema, health, type Component } from '../shared/domain';
import { toolPolicy } from '../server/agents/tools';
import { LocalRulesProvider } from '../server/agents/providers';
import { shopSphereGraph } from '../server/db/seed';
const component: Component = {
  id: 'a',
  name: 'API',
  category: 'BACKEND',
  technology: 'REST API',
  description: '',
  x: 0,
  y: 0,
  config: {},
};
describe('human permissions', () => {
  it('separates viewing, reviewing, editing, and approval', () => {
    expect(can('VIEWER', 'read')).toBe(true);
    expect(can('VIEWER', 'comment')).toBe(false);
    expect(can('REVIEWER', 'review')).toBe(true);
    expect(can('REVIEWER', 'edit')).toBe(false);
    expect(can('EDITOR', 'edit')).toBe(true);
    expect(can('EDITOR', 'approve')).toBe(false);
    expect(can('ADMIN', 'approve')).toBe(true);
  });
});
describe('canonical graph', () => {
  it('removes incident edges without changing the original graph', () => {
    const graph = {
      components: [component, { ...component, id: 'b' }],
      edges: [{ id: 'e', source: 'a', target: 'b', protocol: 'HTTPS' as const, metadata: {} }],
    };
    const result = applyMutations(graph, [{ type: 'component.delete', id: 'a' }]);
    expect(result.components).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(graph.components).toHaveLength(2);
  });
  it('rejects dangling edges and duplicate entities in restores', () => {
    expect(() =>
      applyMutations({ components: [component], edges: [] }, [
        {
          type: 'edge.upsert',
          edge: { id: 'e', source: 'a', target: 'other-project', protocol: 'SQL', metadata: {} },
        },
      ]),
    ).toThrow('distinct components');
    expect(() =>
      applyMutations({ components: [], edges: [] }, [
        { type: 'graph.restore', graph: { components: [component, component], edges: [] } },
      ]),
    ).toThrow('Duplicate');
  });
});
describe('agent boundaries', () => {
  it('denies tool access unless tool, operation, and resource all match', () => {
    const grants = [{ tool: 'github', resource: 'org/repo', operation: 'read', policy: 'AUTO' }];
    expect(toolPolicy(grants, 'github', 'org/repo', 'read')).toBe('AUTO');
    expect(toolPolicy(grants, 'github', 'org/other', 'read')).toBe('DISABLED');
    expect(toolPolicy(grants, 'github', 'org/repo', 'write')).toBe('DISABLED');
  });
  it('rejects malformed and extra critical agent output fields', () => {
    expect(
      agentOutputSchema.safeParse({
        message: 'ok',
        findings: [],
        proposals: [],
        additions: [],
        delegates: [],
        execute: 'drop database',
      }).success,
    ).toBe(false);
    expect(
      agentOutputSchema.safeParse({
        message: 'ok',
        findings: [{ title: 'invented' }],
        proposals: [],
        additions: [],
        delegates: [],
      }).success,
    ).toBe(false);
  });
  it('local agents cite actual configuration and do not invent traffic', async () => {
    const provider = new LocalRulesProvider();
    const result = await provider.generate(
      {
        id: 's',
        name: 'Security',
        role: 'security',
        description: '',
        provider: 'local',
        model: 'rules-v1',
        instructions: '',
        enabled: true,
        status: 'idle',
        capabilities: [],
        settings: {},
      },
      {
        graph: shopSphereGraph(),
        revision: 0,
        prompt: 'review',
        knowledge: [],
        discussion: [],
        skills: [],
      },
    );
    expect(result.output.findings).toHaveLength(2);
    expect(result.output.findings[0].evidence).toContain('rateLimiting = false');
    expect(result.inputTokens).toBe(0);
    expect(agentOutputSchema.safeParse(result.output).success).toBe(true);
  });
});
it('health is derived from open findings only', () => {
  expect(
    health([
      { category: 'Security', severity: 'HIGH', status: 'OPEN' },
      { category: 'Security', severity: 'CRITICAL', status: 'RESOLVED' },
    ]).score,
  ).toBe(90);
});
it('accepts loopback aliases only on the same scheme and port, and never in production', async () => {
  const { originAllowed } = await import('../server/core');
  const origin = 'http://localhost:5173';
  expect(originAllowed('http://127.0.0.1:5173', origin)).toBe(true);
  expect(originAllowed('http://127.0.0.1:5174', origin)).toBe(false);
  expect(originAllowed('https://127.0.0.1:5173', origin)).toBe(false);
  expect(originAllowed('http://attacker.test:5173', origin)).toBe(false);
  expect(originAllowed(undefined, origin)).toBe(false);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  expect(originAllowed('http://127.0.0.1:5173', origin)).toBe(false);
  process.env.NODE_ENV = previous;
});
