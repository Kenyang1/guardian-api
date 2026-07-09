import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { categorizeRequestSchema } from '../schemas/categorize';
import type { CategorizationService } from '../categorization/categorizer';

/**
 * Standalone categorization endpoint. The mobile app calls this as the user
 * types a merchant name, so the "Add transaction" form can show the suggested
 * category chip before the transaction is even submitted.
 */

export function categorizeRouter(service: CategorizationService): Router {
  const router = Router();

  // POST /api/v1/categorize
  router.post('/', async (req: AuthedRequest, res: Response) => {
    try {
      const { merchantRaw } = categorizeRequestSchema.parse(req.body);
      const result = await service.categorize(merchantRaw);
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
