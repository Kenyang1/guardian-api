import { normalizeMerchant } from '../routes/transactions';
import { CATEGORY_NAMES } from '../schemas/budget';
import type { MerchantCategoriesRepo } from '../repos/merchantCategoriesRepo';

/**
 * The LLM categorization flow: cache lookup -> Claude on a miss -> validate
 * against the 10 known categories -> upsert cache -> log an analytics event.
 *
 * The LLM is an enhancement, never a dependency: if the model returns garbage
 * or the API is down, the transaction still saves - it just lands in 'Other'
 * (10) and the failure is logged as 'llm_error_fallback'. Fallbacks are NOT
 * written to the cache: a transient outage must not permanently mislabel a
 * merchant.
 */

// The raw model call, injected: production wires the Anthropic SDK
// (anthropicClassifier.ts); tests wire a stub. Same DI story as auth.
// May throw, may return garbage - the service validates everything.
export type LlmClassifier = (merchantRaw: string) => Promise<number>;

export const FALLBACK_CATEGORY_ID = 10; // 'Other'

export interface CategorizationResult {
  merchantKey: string;
  categoryId: number;
  categoryName: string;
  source: 'cache' | 'llm' | 'fallback';
}

export interface CategorizationService {
  categorize(merchantRaw: string): Promise<CategorizationResult>;
}

function isValidCategoryId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

export function makeCachedCategorizer(
  repo: MerchantCategoriesRepo,
  classify: LlmClassifier,
): CategorizationService {
  return {
    async categorize(merchantRaw: string): Promise<CategorizationResult> {
      const merchantKey = normalizeMerchant(merchantRaw);

      // 1. Cache lookup - the common case once a merchant has been seen.
      const cached = await repo.getByKey(merchantKey);
      if (cached) {
        await repo.logEvent(merchantKey, 'cache_hit', cached.categoryId);
        return {
          merchantKey,
          categoryId: cached.categoryId,
          categoryName: CATEGORY_NAMES[cached.categoryId] ?? 'Unknown',
          source: 'cache',
        };
      }

      // 2. Cache miss - ask the model, but trust nothing it says.
      try {
        const categoryId = await classify(merchantRaw);
        if (!isValidCategoryId(categoryId)) {
          throw new Error(`classifier returned invalid category: ${categoryId}`);
        }
        // 3. Valid answer: cache it so the next lookup is a hit.
        await repo.upsert({ merchantKey, rawExample: merchantRaw, categoryId, source: 'llm' });
        await repo.logEvent(merchantKey, 'llm_call', categoryId);
        return {
          merchantKey,
          categoryId,
          categoryName: CATEGORY_NAMES[categoryId] ?? 'Unknown',
          source: 'llm',
        };
      } catch {
        // 4. Model down, timed out, or returned garbage: degrade gracefully.
        await repo.logEvent(merchantKey, 'llm_error_fallback', null);
        return {
          merchantKey,
          categoryId: FALLBACK_CATEGORY_ID,
          categoryName: CATEGORY_NAMES[FALLBACK_CATEGORY_ID],
          source: 'fallback',
        };
      }
    },
  };
}
