import { z } from 'zod';

/**
 * Budgets module schemas. Same three-job pattern as transaction.ts:
 * runtime validation, inferred TS types, and a shape the mobile app can share.
 */

const monthString = z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM');

export const createBudgetSchema = z.object({
  categoryId: z.number().int().min(1).max(10),
  month: monthString, // required: a budget without a month is meaningless
  limitCents: z
    .number()
    .int('limits are integer cents - never floats for money')
    .positive()
    .max(10_000_000, 'limit exceeds sanity limit'),
});

export const listBudgetsQuerySchema = z.object({
  month: monthString.optional(), // omitted -> all months
});

// Mirrors the budgets table column-for-column, like transactionResponseSchema.
export const budgetResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  categoryId: z.number().int(),
  month: z.string(),
  limitCents: z.number().int(),
  createdAt: z.string(),
});

export const monthlyInsightsQuerySchema = z.object({
  month: monthString, // required here: "insights for which month?" must be answered
});

// One dashboard row per budgeted category: limit vs spent vs what's left.
export const insightRowSchema = z.object({
  categoryId: z.number().int(),
  categoryName: z.string(),
  limitCents: z.number().int(),
  spentCents: z.number().int(),
  remainingCents: z.number().int(),
});

// Mirror of the categories seed data. Postgres joins the real table; the
// in-memory repo (tests) uses this map. If the seed ever changes, change both.
export const CATEGORY_NAMES: Record<number, string> = {
  1: 'Food & Drink',
  2: 'Groceries',
  3: 'Transportation',
  4: 'Housing & Utilities',
  5: 'Education',
  6: 'Entertainment',
  7: 'Shopping',
  8: 'Health',
  9: 'Income',
  10: 'Other',
};

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;
export type Budget = z.infer<typeof budgetResponseSchema>;
export type MonthlyInsightsQuery = z.infer<typeof monthlyInsightsQuerySchema>;
export type InsightRow = z.infer<typeof insightRowSchema>;
