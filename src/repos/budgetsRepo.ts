import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import {
  CATEGORY_NAMES,
  type Budget,
  type CreateBudgetInput,
  type InsightRow,
} from '../schemas/budget';
import type { TransactionsRepo } from './transactionsRepo';

/**
 * Budgets repository. Same seam as transactionsRepo: routes depend on the
 * interface, tests get the in-memory version, production gets Postgres.
 *
 * POST is an UPSERT, not a plain insert: the table's
 * unique (user_id, category_id, month) means "one budget per category per
 * month", so re-posting the same category+month REPLACES the limit instead of
 * erroring. That's what a mobile app editing your July food budget wants.
 */

export interface BudgetsRepo {
  upsert(userId: string, input: CreateBudgetInput): Promise<Budget>;
  list(userId: string, month?: string): Promise<Budget[]>;
  // One row per budgeted category: limit vs spent vs remaining for the month.
  monthlyInsights(userId: string, month: string): Promise<InsightRow[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local hacking)
// ---------------------------------------------------------------------------

export class InMemoryBudgetsRepo implements BudgetsRepo {
  private rows: Budget[] = [];

  // Insights joins budgets against transactions, so this repo needs to read
  // them - through the public TransactionsRepo interface, same as a route.
  constructor(private transactions: TransactionsRepo) {}

  async upsert(userId: string, input: CreateBudgetInput): Promise<Budget> {
    const existing = this.rows.find(
      (r) => r.userId === userId && r.categoryId === input.categoryId && r.month === input.month,
    );
    if (existing) {
      existing.limitCents = input.limitCents;
      return existing;
    }
    const row: Budget = {
      id: randomUUID(),
      userId,
      categoryId: input.categoryId,
      month: input.month,
      limitCents: input.limitCents,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(userId: string, month?: string): Promise<Budget[]> {
    return this.rows
      .filter((r) => r.userId === userId && (month ? r.month === month : true))
      .sort((a, b) => b.month.localeCompare(a.month) || a.categoryId - b.categoryId);
  }

  async monthlyInsights(userId: string, month: string): Promise<InsightRow[]> {
    const budgets = await this.list(userId, month);
    const { items } = await this.transactions.list(userId, { month, limit: 100 });
    return budgets.map((b) => {
      const spentCents = items
        .filter((t) => t.categoryId === b.categoryId)
        .reduce((sum, t) => sum + t.amountCents, 0);
      return {
        categoryId: b.categoryId,
        categoryName: CATEGORY_NAMES[b.categoryId] ?? 'Unknown',
        limitCents: b.limitCents,
        spentCents,
        remainingCents: b.limitCents - spentCents,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation (production)
// ---------------------------------------------------------------------------

export class PostgresBudgetsRepo implements BudgetsRepo {
  constructor(private pool: Pool) {}

  async upsert(userId: string, input: CreateBudgetInput): Promise<Budget> {
    // ON CONFLICT targets the unique (user_id, category_id, month) constraint:
    // first POST inserts, second POST for the same slot updates the limit.
    // Atomic - no select-then-insert race.
    const { rows } = await this.pool.query(
      `insert into budgets (user_id, category_id, month, limit_cents)
       values ($1, $2, $3, $4)
       on conflict (user_id, category_id, month)
       do update set limit_cents = excluded.limit_cents
       returning id, user_id, category_id, month, limit_cents, created_at`,
      [userId, input.categoryId, input.month, input.limitCents],
    );
    return mapBudgetRow(rows[0]);
  }

  async list(userId: string, month?: string): Promise<Budget[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (month) {
      params.push(month);
      where += ` and month = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `select id, user_id, category_id, month, limit_cents, created_at
         from budgets
        where ${where}
        order by month desc, category_id`,
      params,
    );
    return rows.map(mapBudgetRow);
  }

  async monthlyInsights(userId: string, month: string): Promise<InsightRow[]> {
    // The classic budget-vs-actual query:
    //   budgets (this user, this month)
    //     join categories for the display name
    //     left join a per-category spend aggregate for the same window.
    // LEFT join so a budgeted category with zero transactions still appears
    // (spent 0), which is exactly what a dashboard needs to show.
    const { rows } = await this.pool.query(
      `select b.category_id,
              c.name as category_name,
              b.limit_cents,
              coalesce(t.spent_cents, 0) as spent_cents
         from budgets b
         join categories c on c.id = b.category_id
         left join (
            select category_id, sum(amount_cents) as spent_cents
              from transactions
             where user_id = $1
               and occurred_at >= $2::date
               and occurred_at < ($2::date + interval '1 month')
             group by category_id
         ) t on t.category_id = b.category_id
        where b.user_id = $1 and b.month = $3
        order by b.category_id`,
      [userId, `${month}-01`, month],
    );
    return rows.map((r: Record<string, unknown>) => {
      const limitCents = Number(r.limit_cents);
      const spentCents = Number(r.spent_cents);
      return {
        categoryId: Number(r.category_id),
        categoryName: r.category_name as string,
        limitCents,
        spentCents,
        remainingCents: limitCents - spentCents,
      };
    });
  }
}

function mapBudgetRow(r: Record<string, unknown>): Budget {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    categoryId: Number(r.category_id),
    month: r.month as string,
    limitCents: Number(r.limit_cents),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}
