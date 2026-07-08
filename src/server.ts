import 'dotenv/config';
import { Pool } from 'pg';
import { buildApp } from './app';
import { firebaseTokenVerifier } from './auth/firebaseVerifier';
import { PostgresTransactionsRepo } from './repos/transactionsRepo';
import { PostgresBudgetsRepo } from './repos/budgetsRepo';

/**
 * Production wiring. The categorizer below is a placeholder that returns
 * 'Other' (10) - replace it with your LLM cache flow (see the categorization
 * guide): check merchant_categories, call the model on a miss, store result.
 */
const projectId = process.env.FIREBASE_PROJECT_ID;
const databaseUrl = process.env.DATABASE_URL;
if (!projectId || !databaseUrl) {
  throw new Error('FIREBASE_PROJECT_ID and DATABASE_URL must be set (see .env.example)');
}

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

const app = buildApp({
  verifyToken: firebaseTokenVerifier(projectId),
  transactionsRepo: new PostgresTransactionsRepo(pool),
  budgetsRepo: new PostgresBudgetsRepo(pool),
  categorize: async () => 10, // TODO: wire the LLM merchant-categorization flow here
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`guardian-api listening on :${port}`));
