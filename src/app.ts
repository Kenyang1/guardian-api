import express from 'express';
import { requireAuth, type TokenVerifier } from './middleware/auth';
import { transactionsRouter, type Categorizer } from './routes/transactions';
import type { TransactionsRepo } from './repos/transactionsRepo';

/**
 * App factory: all external dependencies (auth verifier, repo, categorizer)
 * are injected. server.ts wires production implementations; tests wire stubs.
 */
export interface AppDeps {
  verifyToken: TokenVerifier;
  transactionsRepo: TransactionsRepo;
  categorize: Categorizer;
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true }));

  app.use(
    '/api/v1/transactions',
    requireAuth(deps.verifyToken),
    transactionsRouter(deps.transactionsRepo, deps.categorize),
  );

  return app;
}
