import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { monthlyInsightsQuerySchema } from '../schemas/budget';
import type { BudgetsRepo } from '../repos/budgetsRepo';

/**
 * Insights router: read-only aggregates. This is what the mobile dashboard
 * chart consumes - one row per budgeted category with limit/spent/remaining.
 */

export function insightsRouter(budgets: BudgetsRepo): Router {
  const router = Router();

  // GET /api/v1/insights/monthly?month=2026-07
  router.get('/monthly', async (req: AuthedRequest, res: Response) => {
    try {
      const { month } = monthlyInsightsQuerySchema.parse(req.query);
      const categories = await budgets.monthlyInsights(req.user!.uid, month);
      return res.status(200).json({ month, categories });
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
