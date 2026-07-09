import { z } from 'zod';

/** POST /api/v1/categorize request body. */
export const categorizeRequestSchema = z.object({
  merchantRaw: z.string().min(1).max(200),
});

export type CategorizeRequest = z.infer<typeof categorizeRequestSchema>;
