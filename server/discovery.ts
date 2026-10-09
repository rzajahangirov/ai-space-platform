import { parse } from 'yaml';
import { z } from 'zod';
import type { Component, Graph } from '../shared/domain';
import { categories, protocols } from '../shared/domain';
import { HttpError } from './core';

type Category = (typeof categories)[number];
type Protocol = (typeof protocols)[number];
export type DiscoveryFormat = 'docker-compose' | 'package.json' | 'requirements.txt';
export interface DiscoveredComponent {
  key: string;
  name: string;
  category: Category;
  technology: string;
  confidence: number;
  evidence: string;
  config: Record<string, string | number | boolean>;
}
export interface DiscoveredEdge {
  source: string;
  target: string;
  protocol: Protocol;
  confidence: number;
  evidence: string;
}
export interface Discovery {
  format: DiscoveryFormat;
  components: DiscoveredComponent[];
  edges: DiscoveredEdge[];
  warnings: string[];
}
type Rule = [RegExp, Category, string, Protocol];
// Order matters: specific images before generic ones (pgvector before postgres, loki before grafana).
const imageRules: Rule[] = [
  [/pgvector|qdrant|weaviate|milvus|chroma/, 'DATABASE', 'Vector Database', 'HTTP'],
  [/postgres|postgis|timescale/, 'DATABASE', 'PostgreSQL', 'SQL'],
  [/mysql|mariadb/, 'DATABASE', 'MySQL', 'SQL'],
  [/mongo/, 'DATABASE', 'MongoDB', 'TCP'],
  [/redis|valkey|keydb|dragonfly/, 'DATABASE', 'Redis', 'Redis'],
  [/elasticsearch|opensearch/, 'DATABASE', 'Elasticsearch', 'HTTP'],
  [/kafka|redpanda/, 'MESSAGING', 'Kafka', 'Kafka Event'],
  [/rabbitmq/, 'MESSAGING', 'RabbitMQ', 'RabbitMQ Message'],
  [/nats/, 'MESSAGING', 'Event Bus', 'TCP'],
  [/localstack/, 'EXTERNAL', 'AWS', 'HTTPS'],
  [/minio|seaweedfs/, 'STORAGE', 'S3', 'HTTP'],
  [/keycloak|authentik|zitadel|dexidp|ory\//, 'AUTH', 'Identity Provider', 'OAuth'],
  [/kong|tyk|krakend/, 'INFRASTRUCTURE', 'API Gateway', 'HTTP'],
  [/nginx|traefik|caddy|haproxy|envoy/, 'INFRASTRUCTURE', 'Reverse Proxy', 'HTTP'],
  [/loki|fluent|logstash|timberio\/vector/, 'OBSERVABILITY', 'Logs', 'HTTP'],
  [/jaeger|tempo|zipkin|otel|opentelemetry/, 'OBSERVABILITY', 'Tracing', 'gRPC'],
  [/prometheus/, 'OBSERVABILITY', 'Metrics', 'HTTP'],
  [/grafana/, 'OBSERVABILITY', 'Monitoring', 'HTTP'],
  [/ollama|vllm|text-generation-inference|localai/, 'AI', 'LLM', 'HTTP'],
];
type Library = [RegExp, string, Category, string, Protocol, number];
// [package pattern, component name, category, technology, protocol, confidence]
const libraries: Library[] = [
  [
    /^(pg|postgres|asyncpg|psycopg2?(-binary)?|psycopg)$/,
    'PostgreSQL',
    'DATABASE',
    'PostgreSQL',
    'SQL',
    0.85,
  ],
  [
    /^(drizzle-orm|@prisma\/client|sqlalchemy|typeorm|sequelize)$/,
    'Relational database',
    'DATABASE',
    'PostgreSQL',
    'SQL',
    0.45,
  ],
  [/^(mysql2?|pymysql|mysqlclient)$/, 'MySQL', 'DATABASE', 'MySQL', 'SQL', 0.85],
  [/^(mongodb|mongoose|pymongo|motor)$/, 'MongoDB', 'DATABASE', 'MongoDB', 'TCP', 0.85],
  [/^(ioredis|redis)$/, 'Redis', 'DATABASE', 'Redis', 'Redis', 0.85],
  [
    /^(kafkajs|kafka-python|confluent-kafka|aiokafka)$/,
    'Kafka',
    'MESSAGING',
    'Kafka',
    'Kafka Event',
    0.85,
  ],
  [/^(amqplib|pika|aio-pika)$/, 'RabbitMQ', 'MESSAGING', 'RabbitMQ', 'RabbitMQ Message', 0.8],
  [/^(@aws-sdk\/client-sqs)$/, 'SQS', 'MESSAGING', 'SQS', 'HTTPS', 0.8],
  [/^(@aws-sdk\/client-s3|aws-sdk|boto3)$/, 'Object storage', 'STORAGE', 'S3', 'HTTPS', 0.55],
  [
    /^(@elastic\/elasticsearch|elasticsearch)$/,
    'Elasticsearch',
    'DATABASE',
    'Elasticsearch',
    'HTTP',
    0.8,
  ],
  [/^(stripe)$/, 'Stripe', 'EXTERNAL', 'Stripe', 'HTTPS', 0.9],
  [/^(openai)$/, 'OpenAI', 'AI', 'LLM', 'HTTPS', 0.85],
  [/^(@anthropic-ai\/sdk|anthropic)$/, 'Anthropic', 'AI', 'LLM', 'HTTPS', 0.85],
  [/^(@google\/genai|google-genai|google-generativeai)$/, 'Gemini', 'AI', 'LLM', 'HTTPS', 0.85],
  [/^(@sentry\/.+|sentry-sdk)$/, 'Sentry', 'OBSERVABILITY', 'Monitoring', 'HTTPS', 0.85],
  [/^(@opentelemetry\/.+|opentelemetry-.+)$/, 'Tracing', 'OBSERVABILITY', 'Tracing', 'gRPC', 0.6],
  [/^(next-auth|@auth\/core|authlib)$/, 'OAuth provider', 'AUTH', 'OAuth', 'OAuth', 0.6],
  [
    /^(@clerk\/.+|@auth0\/.+|auth0-python)$/,
    'Identity provider',
    'AUTH',
    'Identity Provider',
    'OAuth',
    0.8,
  ],
  [/^(celery)$/, 'Celery worker', 'BACKEND', 'Background Worker', 'Internal RPC', 0.6],
];
const secretKey = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY)/i;

export function detectFormat(content: string, filename = ''): DiscoveryFormat {
  const name = filename.toLowerCase();
  if (name.endsWith('package.json')) return 'package.json';
  if (/requirements.*\.txt$/.test(name)) return 'requirements.txt';
  if (/\.ya?ml$/.test(name) || /^\s*services\s*:/m.test(content)) return 'docker-compose';
  if (content.trimStart().startsWith('{')) return 'package.json';
  if (/^[A-Za-z0-9_.-]+(\[.*\])?\s*([=<>~!]=|$)/m.test(content)) return 'requirements.txt';
  throw new HttpError(
    400,
    'Unrecognized file. Supported: docker-compose.yml, package.json, requirements.txt.',
  );
}

export function discover(content: string, filename?: string): Discovery {
  if (content.length > 200000) throw new HttpError(400, 'File must be smaller than 200 KB.');
  const format = detectFormat(content, filename);
  if (format === 'docker-compose') return fromCompose(content);
  if (format === 'package.json') return fromPackageJson(content);
  return fromRequirements(content);
}

function addEdge(edges: DiscoveredEdge[], edge: DiscoveredEdge) {
  if (edge.source === edge.target) return;
  const existing = edges.find((e) => e.source === edge.source && e.target === edge.target);
  if (!existing) edges.push(edge);
  else if (!existing.evidence.includes(edge.evidence)) {
    existing.confidence = Math.max(existing.confidence, edge.confidence);
    existing.evidence = `${existing.evidence}; ${edge.evidence}`;
  }
}
const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : value && typeof value === 'object'
      ? Object.keys(value)
      : [];
function environment(value: unknown): [string, string][] {
  if (Array.isArray(value))
    return value.map((entry) => {
      const [k, ...rest] = String(entry).split('=');
      return [k, rest.join('=')];
    });
  if (value && typeof value === 'object')
    return Object.entries(value).map(([k, v]) => [k, v == null ? '' : String(v)]);
  return [];
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fromCompose(content: string): Discovery {
  let doc: unknown;
  try {
    // Alias expansion is capped to avoid exponential "billion laughs" documents.
    doc = parse(content, { maxAliasCount: 100 });
  } catch {
    throw new HttpError(400, 'The Compose file is not valid YAML.');
  }
  const services = z.record(z.string(), z.any()).safeParse((doc as any)?.services);
  if (!services.success || !Object.keys(services.data).length)
    throw new HttpError(400, 'The Compose file has no services section.');
  const entries = Object.entries(services.data).slice(0, 200);
  const components: DiscoveredComponent[] = [],
    edges: DiscoveredEdge[] = [],
    warnings: string[] = [];
  const protocolFor = new Map<string, Protocol>();
  for (const [key, raw] of entries) {
    const service = (raw ?? {}) as Record<string, unknown>;
    const image = typeof service.image === 'string' ? service.image.toLowerCase() : '';
    const base = image.replace(/[:@].*$/, '');
    const rule = image ? imageRules.find(([pattern]) => pattern.test(base)) : undefined;
    let category: Category, technology: string, confidence: number, evidence: string;
    if (rule) {
      [, category, technology] = rule;
      confidence = 0.9;
      evidence = `image "${image}"`;
      protocolFor.set(key, rule[3]);
    } else if (/zookeeper/.test(base)) {
      warnings.push(`Skipped "${key}": ZooKeeper is treated as part of the Kafka deployment.`);
      continue;
    } else {
      const frontend = /(^|[-_])(web|frontend|ui|client|storefront|site|next)([-_]|$)/.test(key);
      const worker = /(worker|consumer|job|cron|scheduler)/.test(key);
      category = frontend ? 'FRONTEND' : 'BACKEND';
      technology = frontend ? 'Custom Frontend' : worker ? 'Background Worker' : 'Microservice';
      confidence = service.build ? 0.65 : 0.5;
      evidence = service.build
        ? `built from source; role inferred from the service name "${key}"`
        : `unrecognized image "${image || 'none'}"; role inferred from the service name`;
      protocolFor.set(key, frontend ? 'HTTPS' : 'REST');
    }
    const ports = asList(service.ports).join(', ');
    components.push({
      key,
      name: key
        .split(/[-_]/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' '),
      category,
      technology,
      confidence,
      evidence,
      config: {
        composeService: key,
        ...(image ? { image } : {}),
        ...(ports ? { ports } : {}),
      },
    });
  }
  const keys = components.map((c) => c.key);
  for (const [key, raw] of entries) {
    if (!keys.includes(key)) continue;
    const service = (raw ?? {}) as Record<string, unknown>;
    for (const dep of asList(service.depends_on))
      if (keys.includes(dep))
        addEdge(edges, {
          source: key,
          target: dep,
          protocol: protocolFor.get(dep) ?? 'TCP',
          confidence: 0.75,
          evidence: 'depends_on',
        });
    for (const link of asList(service.links)) {
      const dep = link.split(':')[0];
      if (keys.includes(dep))
        addEdge(edges, {
          source: key,
          target: dep,
          protocol: protocolFor.get(dep) ?? 'TCP',
          confidence: 0.75,
          evidence: 'links',
        });
    }
    for (const [name, value] of environment(service.environment)) {
      // Values are inspected for host names but never stored: connection strings carry credentials.
      if (secretKey.test(name) && value && !/^\$\{?[A-Za-z_]/.test(value))
        warnings.push(`"${key}" sets ${name} to a literal value. Move secrets to a secret store.`);
      for (const dep of keys)
        if (dep !== key && new RegExp(`(^|[/@=,\\s])${escape(dep)}(:\\d+|/|,|\\s|$)`).test(value))
          addEdge(edges, {
            source: key,
            target: dep,
            protocol: protocolFor.get(dep) ?? 'TCP',
            confidence: 0.9,
            evidence: `environment ${name} references host "${dep}"`,
          });
    }
  }
  if (entries.length < Object.keys(services.data).length)
    warnings.push('Only the first 200 services were analyzed.');
  return { format: 'docker-compose', components, edges, warnings };
}

function dependencyDiscovery(
  format: DiscoveryFormat,
  app: DiscoveredComponent,
  dependencies: string[],
  warnings: string[],
): Discovery {
  const components = [app],
    edges: DiscoveredEdge[] = [];
  for (const dep of dependencies) {
    const library = libraries.find(([pattern]) => pattern.test(dep));
    if (!library) continue;
    const [, name, category, technology, protocol, confidence] = library;
    const key = `dep:${technology}:${name}`.toLowerCase();
    const existing = components.find((c) => c.key === key);
    if (existing) {
      existing.evidence += `, ${dep}`;
      existing.confidence = Math.max(existing.confidence, confidence);
    } else
      components.push({
        key,
        name,
        category,
        technology,
        confidence,
        evidence: `dependency ${dep}`,
        config: {},
      });
    addEdge(edges, {
      source: app.key,
      target: key,
      protocol,
      confidence,
      evidence: `dependency ${dep}`,
    });
  }
  return { format, components, edges, warnings };
}

function fromPackageJson(content: string): Discovery {
  let pkg: any;
  try {
    pkg = JSON.parse(content);
  } catch {
    throw new HttpError(400, 'package.json is not valid JSON.');
  }
  if (!pkg || typeof pkg !== 'object') throw new HttpError(400, 'package.json must be an object.');
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
  const has = (pattern: RegExp) => deps.some((d) => pattern.test(d));
  const frontend: [RegExp, string][] = [
    [/^next$/, 'Next.js'],
    [/^@angular\/core$/, 'Angular'],
    [/^(vue|nuxt)$/, 'Vue'],
    [/^(svelte|@sveltejs\/kit)$/, 'Svelte'],
    [/^react$/, 'React'],
  ];
  const framework = frontend.find(([p]) => has(p));
  const server = deps.find((d) => /^(express|fastify|@nestjs\/core|koa|hono|@hapi\/hapi)$/.test(d));
  const graphql = has(/^(graphql|@apollo\/server|graphql-yoga)$/);
  const name =
    typeof pkg.name === 'string' && pkg.name ? pkg.name.replace(/^@[^/]+\//, '') : 'Application';
  const app: DiscoveredComponent = {
    key: `app:${name}`,
    name,
    category: framework && (!server || framework[1] === 'Next.js') ? 'FRONTEND' : 'BACKEND',
    technology:
      framework && (!server || framework[1] === 'Next.js')
        ? framework[1]
        : graphql
          ? 'GraphQL API'
          : server
            ? 'REST API'
            : 'Microservice',
    confidence: framework || server ? 0.85 : 0.5,
    evidence: framework
      ? `dependency ${framework[1]}`
      : server
        ? `dependency ${server}`
        : 'no known framework dependency',
    config: { packageName: name, ...(server ? { framework: server } : {}) },
  };
  const warnings = deps.length ? [] : ['package.json declares no runtime dependencies.'];
  return dependencyDiscovery('package.json', app, deps, warnings);
}

function fromRequirements(content: string): Discovery {
  const deps = content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line && !line.startsWith('-'))
    .map((line) =>
      line
        .split(/[\s;=<>~!\[]/)[0]
        .toLowerCase()
        .replace(/_/g, '-'),
    )
    .filter(Boolean)
    .slice(0, 500);
  const framework = deps.find((d) => /^(fastapi|django|flask|starlette|litestar|aiohttp)$/.test(d));
  const app: DiscoveredComponent = {
    key: 'app:python-service',
    name: framework
      ? `${framework[0].toUpperCase()}${framework.slice(1)} service`
      : 'Python service',
    category: 'BACKEND',
    technology: framework ? 'REST API' : 'Microservice',
    confidence: framework ? 0.85 : 0.5,
    evidence: framework ? `dependency ${framework}` : 'no known web framework dependency',
    config: { ...(framework ? { framework } : {}), language: 'Python' },
  };
  return dependencyDiscovery('requirements.txt', app, deps, []);
}

const suffixes = /(service|svc|server|api|app|backend|database|db)$/;
export function normalizeName(value: string) {
  let s = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < 3 && suffixes.test(s) && s.replace(suffixes, '').length >= 3; i++)
    s = s.replace(suffixes, '');
  return s;
}
export interface DriftReport {
  matches: { componentId: string; observedKey: string; name: string; basis: string }[];
  missingInObservation: { componentId: string; name: string; technology: string }[];
  undeclared: { observedKey: string; name: string; technology: string; confidence: number }[];
  expectedEdges: { sourceName: string; targetName: string; protocol: string }[];
  unexpectedEdges: { sourceName: string; targetName: string; protocol: string; evidence: string }[];
  warnings: string[];
  total: number;
}
/** Compares the designed graph with an observed system. Pure: no I/O, no secrets. */
export function compareWithDesign(graph: Graph, observed: Discovery): DriftReport {
  const pairs = new Map<string, Component>(); // observed key -> designed component
  const used = new Set<string>();
  const bases = new Map<string, string>();
  const match = (o: DiscoveredComponent, c: Component, basis: string) => {
    pairs.set(o.key, c);
    used.add(c.id);
    bases.set(o.key, basis);
  };
  const free = () => graph.components.filter((c) => !used.has(c.id));
  for (const o of observed.components) {
    const mapped = free().find(
      (c) =>
        (o.config.composeService && c.config.composeService === o.config.composeService) ||
        (o.config.packageName && c.config.packageName === o.config.packageName),
    );
    if (mapped) match(o, mapped, 'explicit mapping');
  }
  for (const o of observed.components.filter((o) => !pairs.has(o.key))) {
    const n = normalizeName(o.name);
    const named = free().find((c) => {
      const d = normalizeName(c.name);
      return d === n || (Math.min(d.length, n.length) >= 4 && (d.includes(n) || n.includes(d)));
    });
    if (named) match(o, named, 'name');
  }
  // "PostgreSQL" identifies a database; "REST API" does not identify a particular service.
  const generic = new Set(['BACKEND', 'FRONTEND', 'CLIENT', 'CUSTOM']);
  for (const o of observed.components.filter(
    (o) => !pairs.has(o.key) && !generic.has(o.category),
  )) {
    const sameTech = free().filter((c) => c.technology === o.technology);
    const observedSame = observed.components.filter(
      (x) => !pairs.has(x.key) && x.technology === o.technology,
    );
    if (sameTech.length === 1 && observedSame.length === 1) match(o, sameTech[0], 'technology');
  }
  const designedById = new Map(graph.components.map((c) => [c.id, c]));
  const matchedIds = new Set([...pairs.values()].map((c) => c.id));
  const linked = (a: string, b: string, list: { source: string; target: string }[]) =>
    list.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  const observedDesignEdges = observed.edges
    .filter((e) => pairs.has(e.source) && pairs.has(e.target))
    .map((e) => ({ ...e, source: pairs.get(e.source)!.id, target: pairs.get(e.target)!.id }));
  // A Compose file describes the whole deployable system; a manifest describes one application.
  const scope =
    observed.format === 'docker-compose'
      ? graph.components.filter(
          (c) => !['EXTERNAL', 'CLIENT'].includes(c.category) && c.technology !== 'CDN',
        )
      : (() => {
          const app = pairs.get(observed.components[0]?.key);
          if (!app) return [];
          const neighbors = new Set(
            graph.edges.filter((e) => e.source === app.id).map((e) => e.target),
          );
          return graph.components.filter(
            (c) =>
              c.id === app.id ||
              (neighbors.has(c.id) && c.category !== 'BACKEND' && c.category !== 'FRONTEND'),
          );
        })();
  const report: DriftReport = {
    matches: [...pairs.entries()].map(([key, c]) => ({
      componentId: c.id,
      observedKey: key,
      name: c.name,
      basis: bases.get(key) ?? 'name',
    })),
    missingInObservation: scope
      .filter((c) => !matchedIds.has(c.id))
      .map((c) => ({ componentId: c.id, name: c.name, technology: c.technology })),
    undeclared: observed.components
      .filter((o) => !pairs.has(o.key))
      .map((o) => ({
        observedKey: o.key,
        name: o.name,
        technology: o.technology,
        confidence: o.confidence,
      })),
    expectedEdges: graph.edges
      .filter(
        (e) =>
          matchedIds.has(e.source) &&
          matchedIds.has(e.target) &&
          !linked(e.source, e.target, observedDesignEdges),
      )
      .map((e) => ({
        sourceName: designedById.get(e.source)!.name,
        targetName: designedById.get(e.target)!.name,
        protocol: e.protocol,
      })),
    unexpectedEdges: observedDesignEdges
      .filter((e) => !linked(e.source, e.target, graph.edges))
      .map((e) => ({
        sourceName: designedById.get(e.source)!.name,
        targetName: designedById.get(e.target)!.name,
        protocol: e.protocol,
        evidence: e.evidence,
      })),
    warnings: observed.warnings,
    total: 0,
  };
  report.total =
    report.missingInObservation.length +
    report.undeclared.length +
    report.expectedEdges.length +
    report.unexpectedEdges.length;
  return report;
}

export function driftSummary(report: DriftReport, sourceName: string) {
  const lines = [
    `Observed system from ${sourceName} compared with the designed architecture.`,
    `Matched components: ${report.matches.map((m) => `${m.name} (${m.basis})`).join(', ') || 'none'}.`,
  ];
  for (const e of report.expectedEdges)
    lines.push(`DRIFT expected ${e.sourceName} -> ${e.targetName} (${e.protocol}); not observed.`);
  for (const e of report.unexpectedEdges)
    lines.push(
      `DRIFT observed ${e.sourceName} -> ${e.targetName} (${e.evidence}); not in the design.`,
    );
  for (const c of report.missingInObservation)
    lines.push(`DRIFT designed component ${c.name} (${c.technology}) was not observed.`);
  for (const c of report.undeclared)
    lines.push(`DRIFT observed component ${c.name} (${c.technology}) is not in the design.`);
  for (const w of report.warnings) lines.push(`WARNING ${w}`);
  lines.push('Observations are static configuration analysis, not runtime telemetry.');
  return lines.join('\n');
}
