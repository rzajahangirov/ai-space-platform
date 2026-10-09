import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { audit, authorize, emit, uid } from './core';
import { readGraph } from './graph';
import { compareWithDesign, discover, driftSummary } from './discovery';
import { membersWithRoles, notify } from './mentions';
import type { RealtimeHub } from './realtime';

const pid = (r: FastifyRequest) => (r.params as { id: string }).id;
const upload = z
  .object({
    content: z.string().min(1).max(200000),
    filename: z.string().trim().max(200).optional(),
  })
  .strict();
// Parsing is CPU-bound; keep it well below the global request budget.
const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export function registerObserveRoutes(app: FastifyInstance, db: DB, hub: RealtimeHub) {
  // Read-only analysis for the import flow. Nothing is persisted; the human chooses what to merge.
  app.post('/api/projects/:id/discover', limited, async (request) => {
    await authorize(db, request.actor, pid(request), 'edit');
    const data = upload.parse(request.body);
    const discovery = discover(data.content, data.filename);
    // Matches tell the reviewer which discovered items already exist in the design.
    const { matches } = compareWithDesign(await readGraph(db, pid(request)), discovery);
    return { discovery, matches };
  });

  // Observe mode: record what a deployment manifest says and how it differs from the design.
  app.post('/api/projects/:id/observations', limited, async (request) => {
    const projectId = pid(request);
    await authorize(db, request.actor, projectId, 'review');
    const data = upload.parse(request.body);
    const observed = discover(data.content, data.filename);
    const sourceName = data.filename || observed.format;
    const result = await db.transaction(async (tx) => {
      const [project] = await tx.query<{ revision: number }>(
        'SELECT revision FROM projects WHERE id=$1 FOR SHARE',
        [projectId],
      );
      const drift = compareWithDesign(await readGraph(tx, projectId), observed);
      const id = uid();
      // Only the derived structure is stored; raw file content (and any secrets in it) is discarded.
      await tx.query(
        'INSERT INTO observations(id,project_id,source_name,format,revision,observed,drift,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          projectId,
          sourceName,
          observed.format,
          project.revision,
          JSON.stringify(observed),
          JSON.stringify(drift),
          request.actor.id,
        ],
      );
      // Agents read the drift report through the regular, bounded knowledge retrieval.
      await tx.query(
        'INSERT INTO knowledge_sources(id,project_id,title,kind,content,metadata) VALUES($1,$2,$3,$4,$5,$6)',
        [
          uid(),
          projectId,
          `Observed architecture: ${sourceName} (v${project.revision})`,
          'observation',
          driftSummary(drift, sourceName),
          JSON.stringify({ observationId: id }),
        ],
      );
      await audit(
        tx,
        projectId,
        request.actor,
        'observation.recorded',
        `Compared ${sourceName} with v${project.revision}: ${drift.total} drift item${drift.total === 1 ? '' : 's'}.`,
        { observationId: id, format: observed.format },
      );
      await emit(tx, projectId, 'OBSERVATION_RECORDED', { observationId: id, drift: drift.total });
      if (drift.total)
        await notify(
          tx,
          projectId,
          await membersWithRoles(tx, projectId, ['OWNER', 'ADMIN', 'EDITOR']),
          {
            kind: 'drift_detected',
            title: `${drift.total} architecture drift item${drift.total === 1 ? '' : 's'} in ${sourceName}`,
            body: 'The observed system differs from the designed architecture.',
            page: 'Observe',
            actorName: request.actor.name,
          },
          request.actor.id,
        );
      return { id, revision: project.revision, drift, observed };
    });
    hub.broadcast(projectId);
    return result;
  });

  app.get('/api/projects/:id/observations', async (request) => {
    await authorize(db, request.actor, pid(request));
    return {
      observations: await db.query(
        `SELECT o.id,o.source_name,o.format,o.revision,o.drift,o.observed,o.created_at,u.name AS actor_name
         FROM observations o JOIN users u ON u.id=o.created_by WHERE o.project_id=$1 ORDER BY o.created_at DESC LIMIT 10`,
        [pid(request)],
      ),
    };
  });
}
