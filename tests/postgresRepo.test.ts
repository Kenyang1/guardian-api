import type { Pool } from 'pg';
import { PostgresTransactionsRepo } from '../src/repos/transactionsRepo';
import { PostgresBudgetsRepo } from '../src/repos/budgetsRepo';
import { PostgresViewersRepo } from '../src/repos/viewersRepo';

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

const budgetDbRow = {
  id: '44444444-4444-4444-8444-444444444444',
  user_id: 'user-kenyang',
  category_id: '1',
  month: '2026-07',
  limit_cents: '20000',
  created_at: '2026-07-08T03:00:00.000Z',
};

describe('PostgresBudgetsRepo', () => {
  describe('upsert', () => {
    it('uses ON CONFLICT on the (user_id, category_id, month) key', async () => {
      const { pool, query } = makePool({ rows: [budgetDbRow] });
      const repo = new PostgresBudgetsRepo(pool);

      const saved = await repo.upsert('user-kenyang', {
        categoryId: 1,
        month: '2026-07',
        limitCents: 20000,
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/on conflict \(user_id, category_id, month\)/);
      expect(sql).toMatch(/do update set limit_cents = excluded\.limit_cents/);
      expect(params).toEqual(['user-kenyang', 1, '2026-07', 20000]);
      expect(saved.limitCents).toBe(20000);
      expect(saved.categoryId).toBe(1);
    });
  });

  describe('list', () => {
    it('filters by month only when one is given', async () => {
      const { pool, query } = makePool({ rows: [budgetDbRow] });
      const repo = new PostgresBudgetsRepo(pool);

      await repo.list('user-kenyang', '2026-07');
      let [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/user_id = \$1 and month = \$2/);
      expect(params).toEqual(['user-kenyang', '2026-07']);

      await repo.list('user-kenyang');
      [sql, params] = query.mock.calls[1];
      expect(sql).not.toMatch(/month = \$/);
      expect(params).toEqual(['user-kenyang']);
    });
  });

  describe('monthlyInsights', () => {
    it('left-joins spend so zero-spend budgets still appear, and computes remaining', async () => {
      const { pool, query } = makePool({
        rows: [
          { category_id: '1', category_name: 'Food & Drink', limit_cents: '20000', spent_cents: '1775' },
          { category_id: '6', category_name: 'Entertainment', limit_cents: '5000', spent_cents: '0' },
        ],
      });
      const repo = new PostgresBudgetsRepo(pool);

      const rows = await repo.monthlyInsights('user-kenyang', '2026-07');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/left join/);
      expect(sql).toMatch(/sum\(amount_cents\)/);
      expect(sql).toMatch(/coalesce\(t\.spent_cents, 0\)/);
      // $1 user, $2 month start date for the spend window, $3 budget month key
      expect(params).toEqual(['user-kenyang', '2026-07-01', '2026-07']);

      expect(rows).toEqual([
        {
          categoryId: 1,
          categoryName: 'Food & Drink',
          limitCents: 20000,
          spentCents: 1775,
          remainingCents: 18225,
        },
        {
          categoryId: 6,
          categoryName: 'Entertainment',
          limitCents: 5000,
          spentCents: 0,
          remainingCents: 5000,
        },
      ]);
    });
  });
});

const viewerDbRow = {
  id: '55555555-5555-4555-8555-555555555555',
  owner_uid: 'user-kenyang',
  viewer_email: 'elena@example.com',
  viewer_uid: null,
  status: 'pending',
  created_at: '2026-07-08T04:00:00.000Z',
};

describe('PostgresViewersRepo', () => {
  describe('invite', () => {
    it('upserts on (owner_uid, viewer_email), re-opening only revoked rows', async () => {
      const { pool, query } = makePool({ rows: [viewerDbRow] });
      const repo = new PostgresViewersRepo(pool);

      const invite = await repo.invite('user-kenyang', 'Elena@Example.com');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/on conflict \(owner_uid, viewer_email\)/);
      expect(sql).toMatch(/where trusted_viewers\.status = 'revoked'/);
      expect(params).toEqual(['user-kenyang', 'elena@example.com']); // lowercased
      expect(invite.status).toBe('pending');
      expect(invite.viewerUid).toBeNull();
    });

    it('falls back to selecting the existing row when the upsert returns none', async () => {
      const acceptedRow = { ...viewerDbRow, viewer_uid: 'user-elena', status: 'accepted' };
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // conflict, not revoked
        .mockResolvedValueOnce({ rows: [acceptedRow], rowCount: 1 });
      const repo = new PostgresViewersRepo({ query } as unknown as Pool);

      const invite = await repo.invite('user-kenyang', 'elena@example.com');
      expect(query).toHaveBeenCalledTimes(2);
      expect(invite.status).toBe('accepted'); // unchanged, idempotent
    });
  });

  describe('accept', () => {
    it('requires id + pending status + matching email in one atomic update', async () => {
      const accepted = { ...viewerDbRow, viewer_uid: 'user-elena', status: 'accepted' };
      const { pool, query } = makePool({ rows: [accepted] });
      const repo = new PostgresViewersRepo(pool);

      const row = await repo.accept(viewerDbRow.id, 'user-elena', 'Elena@Example.com');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/status = 'pending' and viewer_email = \$3/);
      expect(params).toEqual(['user-elena', viewerDbRow.id, 'elena@example.com']);
      expect(row?.viewerUid).toBe('user-elena');
    });

    it('returns null when no pending invite matches', async () => {
      const { pool } = makePool({ rows: [] });
      const repo = new PostgresViewersRepo(pool);
      expect(await repo.accept(viewerDbRow.id, 'user-marc', 'marc@example.com')).toBeNull();
    });
  });

  describe('revoke', () => {
    it('is owner-scoped and returns false when nothing matched', async () => {
      const { pool, query } = makePool({ rowCount: 1 });
      const repo = new PostgresViewersRepo(pool);

      expect(await repo.revoke('user-kenyang', viewerDbRow.id)).toBe(true);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/set status = 'revoked'/);
      expect(sql).toMatch(/where id = \$1 and owner_uid = \$2/);
      expect(params).toEqual([viewerDbRow.id, 'user-kenyang']);

      const { pool: emptyPool } = makePool({ rowCount: 0 });
      expect(await new PostgresViewersRepo(emptyPool).revoke('user-elena', viewerDbRow.id)).toBe(
        false,
      );
    });
  });

  describe('hasAcceptedAccess', () => {
    it("matches only status = 'accepted' rows linking owner and viewer", async () => {
      const { pool, query } = makePool({ rowCount: 1 });
      const repo = new PostgresViewersRepo(pool);

      expect(await repo.hasAcceptedAccess('user-kenyang', 'user-elena')).toBe(true);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/owner_uid = \$1 and viewer_uid = \$2 and status = 'accepted'/);
      expect(params).toEqual(['user-kenyang', 'user-elena']);

      const { pool: emptyPool } = makePool({ rowCount: 0 });
      expect(
        await new PostgresViewersRepo(emptyPool).hasAcceptedAccess('user-kenyang', 'user-marc'),
      ).toBe(false);
    });
  });
});

  describe('listForOwner / sharedWithMe', () => {
    it('scopes owner listings by owner_uid', async () => {
      const { pool, query } = makePool({ rows: [viewerDbRow] });
      const repo = new PostgresViewersRepo(pool);

      const items = await repo.listForOwner('user-kenyang');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/where owner_uid = \$1/);
      expect(params).toEqual(['user-kenyang']);
      expect(items[0].viewerEmail).toBe('elena@example.com');
    });

    it('shared-with-me returns only accepted rows for the viewer', async () => {
      const acceptedRow = { ...viewerDbRow, viewer_uid: 'user-elena', status: 'accepted' };
      const { pool, query } = makePool({ rows: [acceptedRow] });
      const repo = new PostgresViewersRepo(pool);

      const items = await repo.sharedWithMe('user-elena');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/viewer_uid = \$1 and status = 'accepted'/);
      expect(params).toEqual(['user-elena']);
      expect(items[0].ownerUid).toBe('user-kenyang');
    });
  });
