import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { audit, authorize, HttpError, uid } from './core';
import { CouncilSession, councilTimeLimit, councilTokenLimit } from './council/council';
import { HttpCouncilLLM, seats, seatLabel, type CouncilLLM } from './council/llm';
import { tracingEnabled } from './tracing';
import type { RealtimeHub } from './realtime';

const pid = (r: FastifyRequest) => (r.params as { id: string }).id;
let llm: CouncilLLM = new HttpCouncilLLM();
/** Test hook: replace the model adapter (e.g. with a scripted fake). */
export function setCouncilLLM(value: CouncilLLM | undefined) {
  llm = value ?? new HttpCouncilLLM();
}

export function registerCouncilRoutes(app: FastifyInstance, db: DB, hub: RealtimeHub) {
  // A session cannot outlive its process: mark interrupted ones instead of silently resuming paid calls.
  const ready = db.query(
    "UPDATE council_sessions SET status='failed',error='Interrupted by a server restart.',finished_at=now() WHERE status='running'",
  );

  app.get('/api/projects/:id/council', async (request) => {
    await ready;
    await authorize(db, request.actor, pid(request));
    return {
      config: {
        timeLimitSeconds: councilTimeLimit(),
        tokenLimit: councilTokenLimit(),
        seats: seats.map((s) => ({ seat: s, label: seatLabel[s], model: llm.model(s) })),
        langsmith: tracingEnabled()
          ? { project: process.env.LANGSMITH_PROJECT || 'agentspace' }
          : null,
      },
      sessions: await db.query(
        `SELECT s.*,u.name AS requested_by_name,
          (SELECT count(*)::int FROM council_decisions d WHERE d.session_id=s.id AND d.status='pending_review') AS pending
         FROM council_sessions s JOIN users u ON u.id=s.requested_by WHERE s.project_id=$1 ORDER BY s.started_at DESC LIMIT 20`,
        [pid(request)],
      ),
    };
  });

  app.get('/api/projects/:id/council/:sessionId', async (request) => {
    await authorize(db, request.actor, pid(request));
    const { sessionId } = request.params as { sessionId: string };
    const [session] = await db.query(
      'SELECT * FROM council_sessions WHERE id=$1 AND project_id=$2',
      [sessionId, pid(request)],
    );
    if (!session) throw new HttpError(404, 'Council session not found.');
    return {
      session,
      events: await db.query('SELECT * FROM council_events WHERE session_id=$1 ORDER BY seq', [
        sessionId,
      ]),
      decisions: await db.query(
        `SELECT d.*,u.name AS reviewed_by_name FROM council_decisions d LEFT JOIN users u ON u.id=d.reviewed_by
         WHERE d.session_id=$1 ORDER BY d.position`,
        [sessionId],
      ),
    };
  });

  app.post('/api/projects/:id/council', async (request) => {
    await ready;
    await authorize(db, request.actor, pid(request), 'review');
    const { topic } = z
      .object({
        topic: z.string().trim().min(1).max(500).default('Review the whole architecture.'),
      })
      .parse(request.body ?? {});
    const id = uid(),
      timeLimit = councilTimeLimit(),
      tokenLimit = councilTokenLimit();
    try {
      await db.query(
        `INSERT INTO council_sessions(id,project_id,requested_by,topic,time_limit_seconds,token_limit,deadline_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          pid(request),
          request.actor.id,
          topic,
          timeLimit,
          tokenLimit,
          new Date(Date.now() + timeLimit * 1000).toISOString(),
        ],
      );
    } catch (e: any) {
      if (e?.code === '23505' || /one_active_council|unique/i.test(String(e?.message)))
        throw new HttpError(409, 'A council session is already running for this project.');
      throw e;
    }
    await audit(db, pid(request), request.actor, 'council.started', topic, { sessionId: id });
    const session = new CouncilSession(
      db,
      llm,
      id,
      pid(request),
      topic,
      () => hub.broadcast(pid(request)),
      timeLimit * 1000,
      tokenLimit,
    );
    // Runs in the background; the client follows progress through invalidation and polling.
    void session.run(request.actor).catch(async (e) => {
      app.log.error(e);
      await db
        .query(
          "UPDATE council_sessions SET status='failed',error=$1,finished_at=now() WHERE id=$2 AND status='running'",
          ['The council stopped unexpectedly.', id],
        )
        .catch(() => {});
    });
    return { id };
  });

  // Senior review: only owners and admins decide decisions the 4-of-5 rule held back.
  app.post('/api/projects/:id/council/decisions/:decisionId', async (request) => {
    await authorize(db, request.actor, pid(request), 'approve');
    const { decisionId } = request.params as { decisionId: string };
    const { decision, note } = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(request.body);
    const [row] = await db.query<{ title: string }>(
      `UPDATE council_decisions SET status=$1,review_note=$2,reviewed_by=$3,reviewed_at=now()
       WHERE id=$4 AND project_id=$5 AND status='pending_review' RETURNING title`,
      [decision, note ?? null, request.actor.id, decisionId, pid(request)],
    );
    if (!row) throw new HttpError(409, 'This decision is no longer waiting for review.');
    await audit(db, pid(request), request.actor, `council.decision.${decision}`, row.title, {
      decisionId,
    });
    hub.broadcast(pid(request));
    return { ok: true };
  });
}
