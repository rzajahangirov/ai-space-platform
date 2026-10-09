import 'dotenv/config';
import { connectDatabase, migrate } from './db';
import { buildApp } from './app';
import { closeCache } from './agents/cache';
const db = await connectDatabase();
await migrate(db);
const { app } = await buildApp(db);
await app.listen({
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app
      .close()
      .then(() => closeCache())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
