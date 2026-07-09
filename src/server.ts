import 'dotenv/config';
import { Pool } from 'pg';
import { buildApp } from './app';
import { firebaseTokenVerifier } from './auth/firebaseVerifier';
import { PostgresTransactionsRepo } from './repos/transactionsRepo';
import { PostgresBudgetsRepo } from './repos/budgetsRepo';
import { PostgresViewersRepo } from './repos/viewersRepo';
import { PostgresMerchantCategoriesRepo } from './repos/merchantCategoriesRepo';
import { makeCachedCategorizer, type LlmClassifier } from './categorization/categorizer';
import { anthropicClassifier } from './categorization/anthropicClassifier';

/** Production wiring. */
const projectId = process.env.FIREBASE_PROJECT_ID;
const databaseUrl = process.env.DATABASE_URL;
if (!projectId || !databaseUrl) {
  throw new Error('FIREBASE_PROJECT_ID and DATABASE_URL must be set (see .env.example)');
}

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

// LLM categorization: cache in merchant_categories, Claude on a miss. Without
// an API key the classifier throws immediately and every miss takes the
// graceful fallback path to 'Other' - the API stays fully functional.
let classifier: LlmClassifier;
if (process.env.ANTHROPIC_API_KEY) {
  classifier = anthropicClassifier();
} else {
  console.warn('ANTHROPIC_API_KEY not set - merchant categorization will fall back to Other');
  classifier = async () => {
    throw new Error('no ANTHROPIC_API_KEY configured');
  };
}
const categorization = makeCachedCategorizer(new PostgresMerchantCategoriesRepo(pool), classifier);

const app = buildApp({
  verifyToken: firebaseTokenVerifier(projectId),
  transactionsRepo: new PostgresTransactionsRepo(pool),
  budgetsRepo: new PostgresBudgetsRepo(pool),
  viewersRepo: new PostgresViewersRepo(pool),
  categorize: async (merchantRaw) => (await categorization.categorize(merchantRaw)).categoryId,
  categorization,
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`guardian-api listening on :${port}`));
