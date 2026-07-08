import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type {
  CreateTransactionInput,
  Transaction,
  UpdateTransactionInput,
} from '../schemas/transaction';

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

// Recomputed fields that accompany an update: a new merchantRaw needs a new
// merchantKey, and a caller-chosen category flips categorySource to 'manual'.
// The route computes these; the repo just persists them.
export interface UpdateDerived {
  merchantKey?: string;
  categorySource?: 'manual';
}

export interface TransactionsRepo {
  create(
    userId: string,
    input: CreateTransactionInput,
    derived: { merchantKey: string; categoryId: number; categorySource: 'auto' | 'manual' },
  ): Promise<Transaction>;
  list(userId: string, opts: ListOptions): Promise<ListResult>;
  // Every method below takes userId so ownership is checked atomically in the
  // lookup itself - "not found" and "not yours" are indistinguishable by
  // construction, which is what lets routes return 404 without leaking ids.
  findById(userId: string, id: string): Promise<Transaction | null>;
  update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
    derived: UpdateDerived,
  ): Promise<Transaction | null>;
  delete(userId: string, id: string): Promise<boolean>;
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

  async findById(userId: string, id: string): Promise<Transaction | null> {
    return this.rows.find((r) => r.id === id && r.userId === userId) ?? null;
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
    derived: UpdateDerived,
  ): Promise<Transaction | null> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) return null;
    if (patch.amountCents !== undefined) row.amountCents = patch.amountCents;
    if (patch.merchantRaw !== undefined) row.merchantRaw = patch.merchantRaw;
    if (patch.occurredAt !== undefined) row.occurredAt = patch.occurredAt;
    if (patch.categoryId !== undefined) row.categoryId = patch.categoryId;
    if (patch.note !== undefined) row.note = patch.note;
    if (derived.merchantKey !== undefined) row.merchantKey = derived.merchantKey;
    if (derived.categorySource !== undefined) row.categorySource = derived.categorySource;
    return row;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id && r.userId === userId);
    if (i < 0) return false;
    this.rows.splice(i, 1);
    return true;
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

  async findById(userId: string, id: string): Promise<Transaction | null> {
    const { rows } = await this.pool.query(
      `select id, user_id, amount_cents, merchant_raw, merchant_key,
              category_id, category_source, occurred_at, note, created_at
         from transactions
        where id = $1 and user_id = $2`,
      [id, userId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
    derived: UpdateDerived,
  ): Promise<Transaction | null> {
    // Dynamic SET clause: same params.push / $n trick as the WHERE in list().
    // Only columns present in the patch are updated.
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.amountCents !== undefined) set('amount_cents', patch.amountCents);
    if (patch.merchantRaw !== undefined) set('merchant_raw', patch.merchantRaw);
    if (patch.occurredAt !== undefined) set('occurred_at', patch.occurredAt);
    if (patch.categoryId !== undefined) set('category_id', patch.categoryId);
    if (patch.note !== undefined) set('note', patch.note);
    if (derived.merchantKey !== undefined) set('merchant_key', derived.merchantKey);
    if (derived.categorySource !== undefined) set('category_source', derived.categorySource);
    if (sets.length === 0) return this.findById(userId, id);

    params.push(id, userId);
    const { rows } = await this.pool.query(
      `update transactions
          set ${sets.join(', ')}
        where id = $${params.length - 1} and user_id = $${params.length}
        returning id, user_id, amount_cents, merchant_raw, merchant_key,
                  category_id, category_source, occurred_at, note, created_at`,
      params,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `delete from transactions where id = $1 and user_id = $2`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
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
