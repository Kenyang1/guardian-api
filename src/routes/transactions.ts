import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import {
  createTransactionSchema,
  listTransactionsQuerySchema,
} from '../schemas/transaction';
import type { TransactionsRepo } from '../repos/transactionsRepo';

/**
 * Transactions router - the fully-built example endpoint pair.
 *
 * Demonstrates the patterns every other route in the API should copy:
 *   - Zod validation with 422 responses that name the failing field
 *   - user scoping from the verified JWT (never from the request body!)
 *   - cursor pagination
 *   - correct status codes: 201 created, 422 validation, 401 handled upstream
 *   - injected dependencies (repo + categorizer) so tests run offline
 */

// The categorizer is injected too: in production it calls your LLM cache flow;
// in tests it's a stub. Same DI story as auth.
export type Categorizer = (merchantRaw: string) => Promise<number>;

export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/#\d+/g, '')
    .replace(/\b\d{2,}\b/g, '')
    .replace(/\b(LLC|INC|CORP|CO)\b/g, '')
    .replace(/[^A-Z& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function transactionsRouter(repo: TransactionsRepo, categorize: Categorizer): Router {
  const router = Router();

  // POST /api/v1/transactions
  router.post('/', async (req: AuthedRequest, res: Response) => {
    try {
      const input = createTransactionSchema.parse(req.body);
      const userId = req.user!.uid; // guaranteed by requireAuth middleware

      // Category: user-supplied wins (manual); otherwise auto-categorize.
      const categoryId = input.categoryId ?? (await categorize(input.merchantRaw));
      const categorySource = input.categoryId ? 'manual' : 'auto';

      const created = await repo.create(userId, input, {
        merchantKey: normalizeMerchant(input.merchantRaw),
        categoryId,
        categorySource,
      });
      return res.status(201).json(created);
    } catch (err) {
      if (err instanceof ZodError) {
        // 422: the request was well-formed JSON but semantically invalid
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/v1/transactions?month=2026-07&limit=25&cursor=<uuid>
  router.get('/', async (req: AuthedRequest, res: Response) => {
    try {
      const query = listTransactionsQuerySchema.parse(req.query);
      const result = await repo.list(req.user!.uid, query);
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
