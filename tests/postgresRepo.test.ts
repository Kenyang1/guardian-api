import type { Pool } from 'pg';
import { PostgresTransactionsRepo } from '../src/repos/transactionsRepo';

/**
 * Unit tests for the Postgres repo with a stubbed pool: no database needed.
 * The point is to pin down the SQL we generate - especially the dynamic SET
 * clause in update() - and the row mapping, without a live connection.
 */

const dbRow = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-kenyang',
  amount_cents: '575',
  merchant_raw: 'DUNKIN #341782 MANCHESTER NH',
  merchant_key: 'dunkin manchester nh',
  category_id: '1',
  category_source: 'auto',
  occurred_at: '2026-07-06T12:30:00.000Z',
  note: null,
  created_at: '2026-07-08T02:21:18.418Z',
};

function makePool(result: { rows?: unknown[]; rowCount?: number | null }) {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0, ...result });
  return { pool: { query } as unknown as Pool, query };
}

describe('PostgresTransactionsRepo', () => {
  describe('create', () => {
    it('inserts with parameterized values and maps the returned row', async () => {
      const { pool, query } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);

      const created = await repo.create(
        'user-kenyang',
        {
          amountCents: 575,
          merchantRaw: 'DUNKIN #341782 MANCHESTER NH',
          occurredAt: '2026-07-06T12:30:00.000Z',
        },
        { merchantKey: 'dunkin manchester nh', categoryId: 1, categorySource: 'auto' },
      );

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/insert into transactions/);
      expect(params[0]).toBe('user-kenyang');
      expect(created.amountCents).toBe(575); // numeric string from pg -> number
      expect(created.userId).toBe('user-kenyang');
    });
  });

  describe('findById', () => {
    it('scopes the lookup by id AND user_id', async () => {
      const { pool, query } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);

      const found = await repo.findById('user-kenyang', dbRow.id);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/where id = \$1 and user_id = \$2/);
      expect(params).toEqual([dbRow.id, 'user-kenyang']);
      expect(found?.merchantKey).toBe('dunkin manchester nh');
    });

    it('returns null when no row matches', async () => {
      const { pool } = makePool({ rows: [] });
      const repo = new PostgresTransactionsRepo(pool);
      expect(await repo.findById('user-kenyang', dbRow.id)).toBeNull();
    });
  });

  describe('update', () => {
    it('builds a SET clause containing only the patched columns', async () => {
      const { pool, query } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);

      await repo.update('user-kenyang', dbRow.id, { amountCents: 999, note: 'hi' }, {});

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/set amount_cents = \$1, note = \$2/);
      // No assignments to unpatched columns (they may appear in RETURNING).
      expect(sql).not.toMatch(/merchant_raw =|category_id =|occurred_at =/);
      expect(sql).toMatch(/where id = \$3 and user_id = \$4/);
      expect(params).toEqual([999, 'hi', dbRow.id, 'user-kenyang']);
    });

    it('includes derived merchant_key and category_source when supplied', async () => {
      const { pool, query } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);

      await repo.update(
        'user-kenyang',
        dbRow.id,
        { merchantRaw: 'STARBUCKS #55 BOSTON MA', categoryId: 6 },
        { merchantKey: 'starbucks boston ma', categorySource: 'manual' },
      );

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/merchant_raw = \$1/);
      expect(sql).toMatch(/category_id = \$2/);
      expect(sql).toMatch(/merchant_key = \$3/);
      expect(sql).toMatch(/category_source = \$4/);
      expect(params.slice(0, 4)).toEqual([
        'STARBUCKS #55 BOSTON MA',
        6,
        'starbucks boston ma',
        'manual',
      ]);
    });

    it('returns null when the row is missing or owned by someone else', async () => {
      const { pool } = makePool({ rows: [] });
      const repo = new PostgresTransactionsRepo(pool);
      const result = await repo.update('user-elena', dbRow.id, { note: 'mine now' }, {});
      expect(result).toBeNull();
    });

    it('falls back to findById when the patch has nothing to set', async () => {
      const { pool, query } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);

      const result = await repo.update('user-kenyang', dbRow.id, {}, {});

      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/select/);
      expect(result?.id).toBe(dbRow.id);
    });
  });

  describe('delete', () => {
    it('returns true when a row was deleted', async () => {
      const { pool, query } = makePool({ rowCount: 1 });
      const repo = new PostgresTransactionsRepo(pool);

      expect(await repo.delete('user-kenyang', dbRow.id)).toBe(true);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/delete from transactions where id = \$1 and user_id = \$2/);
      expect(params).toEqual([dbRow.id, 'user-kenyang']);
    });

    it('returns false when nothing matched', async () => {
      const { pool } = makePool({ rowCount: 0 });
      const repo = new PostgresTransactionsRepo(pool);
      expect(await repo.delete('user-elena', dbRow.id)).toBe(false);
    });
  });

  describe('list', () => {
    it('adds month and cursor filters and reports nextCursor', async () => {
      const secondRow = { ...dbRow, id: '22222222-2222-4222-8222-222222222222' };
      const thirdRow = { ...dbRow, id: '33333333-3333-4333-8333-333333333333' };
      const { pool, query } = makePool({ rows: [dbRow, secondRow, thirdRow] });
      const repo = new PostgresTransactionsRepo(pool);

      const result = await repo.list('user-kenyang', {
        month: '2026-07',
        cursor: dbRow.id,
        limit: 2,
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/occurred_at >= \$2::date/);
      expect(sql).toMatch(/occurred_at < \(select occurred_at from transactions where id = \$3\)/);
      expect(params).toEqual(['user-kenyang', '2026-07-01', dbRow.id, 3]); // limit+1
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBe(secondRow.id); // 3 rows returned -> more pages
    });

    it('returns a null cursor when the page is not full', async () => {
      const { pool } = makePool({ rows: [dbRow] });
      const repo = new PostgresTransactionsRepo(pool);
      const result = await repo.list('user-kenyang', { limit: 2 });
      expect(result.nextCursor).toBeNull();
    });
  });
});
