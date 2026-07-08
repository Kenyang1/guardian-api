import express from 'express';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { transactionsRouter, type Categorizer } from './routes/transactions';
import { budgetsRouter } from './routes/budgets';
import { insightsRouter } from './routes/insights';
import type { TransactionsRepo } from './repos/transactionsRepo';
import type { BudgetsRepo } from './repos/budgetsRepo';

/**
 * App factory: all external dependencies (auth verifier, repos, categorizer)
 * are injected. server.ts wires production implementations; tests wire stubs.
 */
export interface AppDeps {
  verifyToken: TokenVerifier;
  transactionsRepo: TransactionsRepo;
  budgetsRepo: BudgetsRepo;
  categorize: Categorizer;
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true }));

  const auth = requireAuth(deps.verifyToken);

  app.use(
    '/api/v1/transactions',
    auth,
    transactionsRouter(deps.transactionsRepo, deps.categorize),
  );
  app.use('/api/v1/budgets', auth, budgetsRouter(deps.budgetsRepo));
  app.use('/api/v1/insights', auth, insightsRouter(deps.budgetsRepo));

  return app;
}
