import type { Pool } from 'pg';

/**
 * Merchant categorization cache + analytics events. Same seam as every repo.
 *
 * The cache is keyed on merchant_key (the NORMALIZED string), not merchant_raw:
 * raw strings carry per-transaction noise (store numbers, register ids), so
 * caching on them would miss on nearly every purchase. Normalizing first is
 * what makes the cache actually hit.
 *
 * Every lookup outcome is logged to categorization_events so cache-hit rate
 * is measurable from day one - that number goes on the resume.
 */

export type CategorizationOutcome = 'cache_hit' | 'llm_call' | 'llm_error_fallback';

export interface MerchantCategory {
  merchantKey: string;
  rawExample: string;
  categoryId: number;
  source: string;
  createdAt: string;
}

export interface MerchantCategoriesRepo {
  getByKey(merchantKey: string): Promise<MerchantCategory | null>;
  upsert(entry: {
    merchantKey: string;
    rawExample: string;
    categoryId: number;
    source: string;
  }): Promise<MerchantCategory>;
  logEvent(
    merchantKey: string,
    outcome: CategorizationOutcome,
    categoryId: number | null,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local hacking)
// ---------------------------------------------------------------------------

export interface LoggedEvent {
  merchantKey: string;
  outcome: CategorizationOutcome;
  categoryId: number | null;
}

export class InMemoryMerchantCategoriesRepo implements MerchantCategoriesRepo {
  private rows = new Map<string, MerchantCategory>();
  // Exposed so tests can assert on the event trail.
  readonly events: LoggedEvent[] = [];

  async getByKey(merchantKey: string): Promise<MerchantCategory | null> {
    return this.rows.get(merchantKey) ?? null;
  }

  async upsert(entry: {
    merchantKey: string;
    rawExample: string;
    categoryId: number;
    source: string;
  }): Promise<MerchantCategory> {
    const existing = this.rows.get(entry.merchantKey);
    const row: MerchantCategory = {
      merchantKey: entry.merchantKey,
      rawExample: entry.rawExample,
      categoryId: entry.categoryId,
      source: entry.source,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.rows.set(entry.merchantKey, row);
    return row;
  }

  async logEvent(
    merchantKey: string,
    outcome: CategorizationOutcome,
    categoryId: number | null,
  ): Promise<void> {
    this.events.push({ merchantKey, outcome, categoryId });
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation (production)
// ---------------------------------------------------------------------------

export class PostgresMerchantCategoriesRepo implements MerchantCategoriesRepo {
  constructor(private pool: Pool) {}

  async getByKey(merchantKey: string): Promise<MerchantCategory | null> {
    const { rows } = await this.pool.query(
      `select merchant_key, raw_example, category_id, source, created_at
         from merchant_categories
        where merchant_key = $1`,
      [merchantKey],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async upsert(entry: {
    merchantKey: string;
    rawExample: string;
    categoryId: number;
    source: string;
  }): Promise<MerchantCategory> {
    const { rows } = await this.pool.query(
      `insert into merchant_categories (merchant_key, raw_example, category_id, source)
       values ($1, $2, $3, $4)
       on conflict (merchant_key)
       do update set category_id = excluded.category_id, source = excluded.source
       returning merchant_key, raw_example, category_id, source, created_at`,
      [entry.merchantKey, entry.rawExample, entry.categoryId, entry.source],
    );
    return mapRow(rows[0]);
  }

  async logEvent(
    merchantKey: string,
    outcome: CategorizationOutcome,
    categoryId: number | null,
  ): Promise<void> {
    await this.pool.query(
      `insert into categorization_events (merchant_key, outcome, category_id)
       values ($1, $2, $3)`,
      [merchantKey, outcome, categoryId],
    );
  }
}

function mapRow(r: Record<string, unknown>): MerchantCategory {
  return {
    merchantKey: r.merchant_key as string,
    rawExample: r.raw_example as string,
    categoryId: Number(r.category_id),
    source: r.source as string,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}
