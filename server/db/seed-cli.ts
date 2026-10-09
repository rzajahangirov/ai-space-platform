import { connectDatabase, migrate } from './index';
import { seedDemo } from './seed';
const db = await connectDatabase();
try {
  await migrate(db);
  await seedDemo(db);
  console.log(
    'ShopSphere is ready. Sign in as demo@agentspace.local using DEMO_PASSWORD (see .env.example).',
  );
} finally {
  await db.close();
}
