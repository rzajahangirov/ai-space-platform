import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { DB } from './db';
import { authorize, hash, HttpError, originAllowed, uid } from './core';
import type { Presence } from '../shared/domain';
import { createClient } from 'redis';

const CHANNEL = 'agentspace:invalidate';
export class RealtimeHub {
  private rooms = new Map<string, Map<WebSocket, Presence>>();
  private publisher?: ReturnType<typeof createClient>;
  private subscriber?: ReturnType<typeof createClient>;
  private listeners: ((projectId: string) => void)[] = [];
  constructor(private instance = 'local') {}
  /** Called for every committed-change invalidation, local or from another instance. */
  onInvalidate(fn: (projectId: string) => void) {
    this.listeners.push(fn);
  }
  /**
   * Several instances behind a load balancer: committed-change invalidations are fanned out through
   * Redis pub/sub so clients connected to any instance refetch. Presence stays per instance.
   * Best effort: polling still repairs a missed notification.
   */
  async enableFanout(url: string) {
    try {
      let connected = false;
      // Fail the first connect fast so startup never waits on Redis; reconnect only once it has worked.
      const pub = createClient({
        url,
        socket: {
          connectTimeout: 2000,
          reconnectStrategy: (n) => (connected ? Math.min(n * 200, 5000) : false),
        },
      });
      const sub = pub.duplicate();
      pub.on('error', () => {});
      sub.on('error', () => {});
      await pub.connect();
      await sub.connect();
      connected = true;
      await sub.subscribe(CHANNEL, (raw) => {
        try {
          const { projectId, from } = JSON.parse(raw);
          if (from !== this.instance) this.local(projectId);
        } catch {
          /* ignore malformed message */
        }
      });
      this.publisher = pub;
      this.subscriber = sub;
      return true;
    } catch {
      return false;
    }
  }
  broadcast(projectId: string) {
    this.local(projectId);
    if (this.publisher?.isReady)
      void this.publisher
        .publish(CHANNEL, JSON.stringify({ projectId, from: this.instance }))
        .catch(() => {});
  }
  private local(projectId: string) {
    for (const fn of this.listeners) fn(projectId);
    for (const socket of this.rooms.get(projectId)?.keys() ?? [])
      this.send(socket, { type: 'invalidate' });
  }
  private send(socket: WebSocket, value: unknown) {
    if (socket.readyState === 1 && socket.bufferedAmount < 256000)
      socket.send(JSON.stringify(value));
  }
  private presence(projectId: string) {
    const room = this.rooms.get(projectId);
    if (room)
      for (const socket of room.keys())
        this.send(socket, { type: 'presence', members: [...room.values()] });
  }
  register(app: FastifyInstance, db: DB, origin: string) {
    app.get<{ Params: { id: string } }>(
      '/api/projects/:id/live',
      {
        websocket: true,
        preValidation: async (request) => {
          if (!originAllowed(request.headers.origin, origin))
            throw new HttpError(403, 'WebSocket origin rejected.');
          await authorize(db, request.actor, request.params.id);
        },
      },
      (socket, request) => {
        const projectId = request.params.id,
          room = this.rooms.get(projectId) ?? new Map<WebSocket, Presence>();
        if (room.size >= 100) {
          socket.close(1013, 'Project connection limit reached');
          return;
        }
        this.rooms.set(projectId, room);
        const member: Presence = {
          id: uid(),
          userId: request.actor.id,
          name: request.actor.name,
          selected: null,
        };
        room.set(socket, member);
        let last = 0,
          alive = true;
        this.presence(projectId);
        this.send(socket, { type: 'invalidate' });
        socket.on('pong', () => {
          alive = true;
        });
        // Handlers attached synchronously. Presence is ephemeral; graph writes use validated HTTP transactions.
        socket.on('message', (raw) => {
          if (Date.now() - last < 50) return;
          last = Date.now();
          try {
            const value = z
              .object({
                selected: z.string().max(100).nullable(),
                cursor: z
                  .object({
                    x: z.number().finite().min(-100000).max(100000),
                    y: z.number().finite().min(-100000).max(100000),
                  })
                  .optional(),
              })
              .strict()
              .parse(JSON.parse(raw.toString()));
            Object.assign(member, value);
            this.presence(projectId);
          } catch {
            /* Discard malformed presence messages. */
          }
        });
        const timer = setInterval(() => {
          void (async () => {
            const [session] = await db.query(
              'SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',
              [hash(request.cookies.agentspace_session ?? '')],
            );
            if (!alive || !session) {
              socket.close(1008, 'Session expired');
              return;
            }
            await authorize(db, request.actor, projectId);
            alive = false;
            socket.ping();
          })().catch(() => socket.close(1008, 'Access revoked'));
        }, 15000);
        socket.on('close', () => {
          clearInterval(timer);
          room.delete(socket);
          if (!room.size) this.rooms.delete(projectId);
          else this.presence(projectId);
        });
        socket.on('error', () => socket.close());
      },
    );
  }
  close() {
    for (const room of this.rooms.values())
      for (const socket of room.keys()) socket.close(1001, 'Server shutting down');
    void this.subscriber?.quit().catch(() => {});
    void this.publisher?.quit().catch(() => {});
  }
}
