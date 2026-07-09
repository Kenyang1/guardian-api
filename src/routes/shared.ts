import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { requireOwnerOrAcceptedViewer } from '../middleware/ownerOrViewer';
import { monthlyInsightsQuerySchema } from '../schemas/budget';
import type { BudgetsRepo } from '../repos/budgetsRepo';
import type { ViewersRepo } from '../repos/viewersRepo';

/**
 * Shared (viewer-facing) routes. Deliberately tiny: ONE read-only GET.
 * There is no POST/PATCH/DELETE here at all - a viewer write is impossible
 * not because a check forbids it, but because no such route exists.
 * Absence of a route is stronger than a permission check.
 */

export function sharedRouter(viewers: ViewersRepo, budgets: BudgetsRepo): Router {
  const router = Router();

  // GET /api/v1/shared/:ownerUid/insights/monthly?month=YYYY-MM
  router.get(
    '/:ownerUid/insights/monthly',
    requireOwnerOrAcceptedViewer(viewers),
    async (req: AuthedRequest, res: Response) => {
      try {
        const { month } = monthlyInsightsQuerySchema.parse(req.query);
        const categories = await budgets.monthlyInsights(req.params.ownerUid, month);
        return res.status(200).json({ ownerUid: req.params.ownerUid, month, categories });
      } catch (err) {
        if (err instanceof ZodError) {
          return res.status(422).json({ error: 'validation failed', issues: err.issues });
        }
        return res.status(500).json({ error: 'internal error' });
      }
    },
  );

  return router;
}
