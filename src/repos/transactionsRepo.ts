import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { CreateTransactionInput, Transaction } from '../schemas/transaction';

/**
 * Repository pattern: routes depend on this interface, never on a database
 * directly. Two implementations ship in this file:
 *   - InMemoryTransactionsRepo: used by the test suite (fast, no DB needed)
 *   - PostgresTransactionsRepo: production, plain SQL against Supabase Postgres
 *
 * Interview talking point: this is the seam that makes the API testable and
 * lets you swap storage without touching a single route.
 */

export interface ListOptions {
  month?: string; // 'YYYY-MM'
  limit: number;
  cursor?: string;
}

export interface ListResult {
  items: Transaction[];
  nextCursor: string | null;
}

export interface TransactionsRepo {
  create(
    userId: string,
    input: CreateTransactionInput,
    derived: { merchantKey: string; categoryId: number; categorySource: 'auto' | 'manual' },
  ): Promise<Transaction>;
  list(userId: string, opts: ListOptions): Promise<ListResult>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local hacking)
// ---------------------------------------------------------------------------

export class InMemoryTransactionsRepo implements TransactionsRepo {
  private rows: Transaction[] = [];

  async create(
    userId: string,
    input: CreateTransactionInput,
    derived: { merchantKey: string; categoryId: number; categorySource: 'auto' | 'manual' },
  ): Promise<Transaction> {
    const row: Transaction = {
      id: randomUUID(),
      userId,
      amountCents: input.amountCents,
      merchantRaw: input.merchantRaw,
      merchantKey: derived.merchantKey,
      categoryId: derived.categoryId,
      categorySource: derived.categorySource,
      occurredAt: input.occurredAt,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(userId: string, opts: ListOptions): Promise<ListResult> {
    let items = this.rows
      .filter((r) => r.userId === userId)
      .filter((r) => (opts.month ? r.occurredAt.startsWith(opts.month) : true))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    if (opts.cursor) {
      const i = items.findIndex((r) => r.id === opts.cursor);
      items = i >= 0 ? items.slice(i + 1) : items;
    }
    const page = items.slice(0, opts.limit);
    const nextCursor = items.length > opts.limit ? page[page.length - 1].id : null;
    return { items: page, nextCursor };
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation (production - plain SQL, no ORM magic to explain away)
// ---------------------------------------------------------------------------

export class PostgresTransactionsRepo implements TransactionsRepo {
  constructor(private pool: Pool) {}

  async create(
    userId: string,
    input: CreateTransactionInput,
    derived: { merchantKey: string; categoryId: number; categorySource: 'auto' | 'manual' },
  ): Promise<Transaction> {
    const { rows } = await this.pool.query(
      `insert into transactions
         (user_id, amount_cents, merchant_raw, merchant_key, category_id, category_source, occurred_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, user_id, amount_cents, merchant_raw, merchant_key,
                 category_id, category_source, occurred_at, note, created_at`,
      [
        userId,
        input.amountCents,
        input.merchantRaw,
        derived.merchantKey,
        derived.categoryId,
        derived.categorySource,
        input.occurredAt,
        input.note ?? null,
      ],
    );
    return mapRow(rows[0]);
  }

  async list(userId: string, opts: ListOptions): Promise<ListResult> {
    // Cursor pagination: fetch limit+1 rows to know whether a next page exists.
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (opts.month) {
      params.push(`${opts.month}-01`);
      where += ` and occurred_at >= $${params.length}::date
                 and occurred_at < ($${params.length}::date + interval '1 month')`;
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      where += ` and occurred_at < (select occurred_at from transactions where id = $${params.length})`;
    }
    params.push(opts.limit + 1);
    const { rows } = await this.pool.query(
      `select id, user_id, amount_cents, merchant_raw, merchant_key,
              category_id, category_source, occurred_at, note, created_at
         from transactions
        where ${where}
        order by occurred_at desc
        limit $${params.length}`,
      params,
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit).map(mapRow);
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }
}

function mapRow(r: Record<string, unknown>): Transaction {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    amountCents: Number(r.amount_cents),
    merchantRaw: r.merchant_raw as string,
    merchantKey: r.merchant_key as string,
    categoryId: Number(r.category_id),
    categorySource: r.category_source as 'auto' | 'manual',
    occurredAt: new Date(r.occurred_at as string).toISOString(),
    note: (r.note as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}
