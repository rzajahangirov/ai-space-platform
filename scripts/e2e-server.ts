import { connectDatabase, migrate } from '../server/db';
import { seedDemo } from '../server/db/seed';
import { buildApp } from '../server/app';
// Tests use a fresh in-memory PostgreSQL database and never modify local workspace data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
const db = await connectDatabase({ memory: true });
await migrate(db);
await seedDemo(db);
const { app } = await buildApp(db, { origin: 'http://localhost:5174' });
await app.listen({ port: 5174, host: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
