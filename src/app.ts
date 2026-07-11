import path from 'path';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
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
  // Browsers block cross-origin reads unless the server opts in. Open CORS is
  // correct here: this is a public API where EVERY request is authenticated by
  // a bearer token - CORS is not an auth layer, the JWT verification is.
  app.use(cors());
  app.use(express.json());

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true }));

  // Interactive API docs. The spec is hand-written (openapi.yaml at the repo
  // root); /docs is deliberately public - it documents the API, it can't call
  // anything without a bearer token. Resolves from src/ (ts-node) and dist/.
  const openapiSpec = YAML.load(path.join(__dirname, '..', 'openapi.yaml'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

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
