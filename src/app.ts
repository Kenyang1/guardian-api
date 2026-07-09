import express from 'express';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { transactionsRouter, type Categorizer } from './routes/transactions';
import { budgetsRouter } from './routes/budgets';
import { insightsRouter } from './routes/insights';
import { viewersRouter } from './routes/viewers';
import { sharedRouter } from './routes/shared';
import { categorizeRouter } from './routes/categorize';
import type { TransactionsRepo } from './repos/transactionsRepo';
import type { BudgetsRepo } from './repos/budgetsRepo';
import type { ViewersRepo } from './repos/viewersRepo';
import type { CategorizationService } from './categorization/categorizer';

/**
 * App factory: all external dependencies (auth verifier, repos, categorizer)
 * are injected. server.ts wires production implementations; tests wire stubs.
 */
export interface AppDeps {
  verifyToken: TokenVerifier;
  transactionsRepo: TransactionsRepo;
  budgetsRepo: BudgetsRepo;
  viewersRepo: ViewersRepo;
  categorize: Categorizer;
  categorization: CategorizationService;
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
  app.use('/api/v1/viewers', auth, viewersRouter(deps.viewersRepo));
  app.use('/api/v1/shared', auth, sharedRouter(deps.viewersRepo, deps.budgetsRepo));
  app.use('/api/v1/categorize', auth, categorizeRouter(deps.categorization));

  return app;
}
