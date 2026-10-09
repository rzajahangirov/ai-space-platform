import { connectDatabase, migrate } from './index';
const db = await connectDatabase();
try {
  await migrate(db);
  console.log('Database migrations applied.');
} finally {
  await db.close();
}
