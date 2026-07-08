import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { createBudgetSchema, listBudgetsQuerySchema } from '../schemas/budget';
import type { BudgetsRepo } from '../repos/budgetsRepo';

/**
 * Budgets router. POST is an upsert (see budgetsRepo) - re-posting the same
 * category+month replaces the limit, so there is no separate PATCH endpoint.
 */

export function budgetsRouter(repo: BudgetsRepo): Router {
  const router = Router();

  // POST /api/v1/budgets
  router.post('/', async (req: AuthedRequest, res: Response) => {
    try {
      const input = createBudgetSchema.parse(req.body);
      const saved = await repo.upsert(req.user!.uid, input);
      return res.status(201).json(saved);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/v1/budgets?month=2026-07
  router.get('/', async (req: AuthedRequest, res: Response) => {
    try {
      const query = listBudgetsQuerySchema.parse(req.query);
      const items = await repo.list(req.user!.uid, query.month);
      return res.status(200).json({ items });
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
