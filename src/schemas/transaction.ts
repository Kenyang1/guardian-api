import { z } from 'zod';

/**
 * Shared schemas: the single source of truth for what a transaction looks like.
 *
 * WHY THIS FILE MATTERS: these Zod schemas serve three jobs at once:
 *   1. Runtime request validation in the API (see routes/transactions.ts)
 *   2. Compile-time TypeScript types (z.infer) used across the backend
 *   3. Copy this file (or publish it as a small package) into the React Native
 *      app so the client and server can NEVER disagree about payload shape.
 *      That is the "shared TypeScript schemas and API validation" pattern.
 */

export const CATEGORY_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const createTransactionSchema = z.object({
  amountCents: z
    .number()
    .int('amount must be in integer cents - never floats for money')
    .positive()
    .max(10_000_000, 'amount exceeds sanity limit'),
  merchantRaw: z.string().min(1).max(200),
  occurredAt: z.string().datetime({ message: 'must be an ISO 8601 datetime' }),
  categoryId: z.number().int().min(1).max(10).optional(), // omit -> auto-categorize
  note: z.string().max(500).optional(),
});

// PATCH body: same fields as create, all optional. The row id comes from the
// URL, never the body. An empty patch is almost certainly a client bug, so we
// reject it loudly instead of treating it as a no-op.
export const updateTransactionSchema = createTransactionSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field is required',
  });

export const transactionIdParamSchema = z.string().uuid('id must be a UUID');

export const listTransactionsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(), // id of the last item from the previous page
});

export const transactionResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  amountCents: z.number().int(),
  merchantRaw: z.string(),
  merchantKey: z.string(),
  categoryId: z.number().int(),
  categorySource: z.enum(['auto', 'manual']),
  occurredAt: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
export type Transaction = z.infer<typeof transactionResponseSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
