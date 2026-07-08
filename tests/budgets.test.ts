import request from 'supertest';
import { buildApp } from '../src/app';
import { InMemoryTransactionsRepo } from '../src/repos/transactionsRepo';
import { InMemoryBudgetsRepo } from '../src/repos/budgetsRepo';

/**
 * Budgets + insights suite. Same offline setup as transactions.test.ts:
 * stub auth, in-memory repos, stub categorizer (DUNKIN -> 1, else 10).
 */

const USERS: Record<string, { uid: string }> = {
  'token-kenyang': { uid: 'user-kenyang' },
  'token-elena': { uid: 'user-elena' },
};

function makeApp() {
  const transactionsRepo = new InMemoryTransactionsRepo();
  return buildApp({
    verifyToken: async (token) => {
      const user = USERS[token];
      if (!user) throw new Error('bad token');
      return user;
    },
    transactionsRepo,
    budgetsRepo: new InMemoryBudgetsRepo(transactionsRepo),
    categorize: async (merchantRaw) => (merchantRaw.toUpperCase().includes('DUNKIN') ? 1 : 10),
  });
}

const julyFoodBudget = { categoryId: 1, month: '2026-07', limitCents: 20000 };

async function postTransaction(
  app: ReturnType<typeof makeApp>,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send({
      amountCents: 575,
      merchantRaw: 'DUNKIN #341782 MANCHESTER NH',
      occurredAt: '2026-07-06T12:30:00.000Z',
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/v1/budgets', () => {
  it('creates a budget (201)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send(julyFoodBudget);

    expect(res.status).toBe(201);
    expect(res.body.categoryId).toBe(1);
    expect(res.body.month).toBe('2026-07');
    expect(res.body.limitCents).toBe(20000);
    expect(res.body.userId).toBe('user-kenyang');
  });

  it('upserts: re-posting the same category+month replaces the limit', async () => {
    const app = makeApp();
    const first = await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send(julyFoodBudget);
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...julyFoodBudget, limitCents: 30000 });

    const list = await request(app)
      .get('/api/v1/budgets?month=2026-07')
      .set('Authorization', 'Bearer token-kenyang');
    expect(list.body.items).toHaveLength(1); // still one row, not two
    expect(list.body.items[0].limitCents).toBe(30000);
    expect(list.body.items[0].id).toBe(first.body.id); // same row, updated
  });

  it('rejects a malformed month (422)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...julyFoodBudget, month: 'July 2026' });
    expect(res.status).toBe(422);
    expect(res.body.issues[0].path).toContain('month');
  });

  it('rejects a float limit (422)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...julyFoodBudget, limitCents: 199.99 });
    expect(res.status).toBe(422);
  });

  it('requires auth (401)', async () => {
    const res = await request(makeApp()).post('/api/v1/budgets').send(julyFoodBudget);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/budgets', () => {
  it('filters by month and never leaks other users budgets', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send(julyFoodBudget);
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...julyFoodBudget, month: '2026-06' });
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-elena')
      .send(julyFoodBudget);

    const res = await request(app)
      .get('/api/v1/budgets?month=2026-07')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe('user-kenyang');
    expect(res.body.items[0].month).toBe('2026-07');
  });
});

describe('GET /api/v1/insights/monthly', () => {
  it('reports limit, spent, and remaining per budgeted category', async () => {
    const app = makeApp();

    // Budgets: Food & Drink 200.00, Entertainment 50.00 (no spending).
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send(julyFoodBudget);
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ categoryId: 6, month: '2026-07', limitCents: 5000 });

    // Spending: two July Dunkin runs (cat 1), one June run (outside window),
    // and one of Elena's (must not leak in).
    await postTransaction(app, 'token-kenyang');
    await postTransaction(app, 'token-kenyang', {
      amountCents: 1200,
      occurredAt: '2026-07-15T09:00:00.000Z',
    });
    await postTransaction(app, 'token-kenyang', { occurredAt: '2026-06-15T09:00:00.000Z' });
    await postTransaction(app, 'token-elena', { amountCents: 99999 });

    const res = await request(app)
      .get('/api/v1/insights/monthly?month=2026-07')
      .set('Authorization', 'Bearer token-kenyang');

    expect(res.status).toBe(200);
    expect(res.body.month).toBe('2026-07');
    expect(res.body.categories).toHaveLength(2);

    const food = res.body.categories.find((c: any) => c.categoryId === 1);
    expect(food.categoryName).toBe('Food & Drink');
    expect(food.limitCents).toBe(20000);
    expect(food.spentCents).toBe(575 + 1200); // July only, Kenyang only
    expect(food.remainingCents).toBe(20000 - 1775);

    const fun = res.body.categories.find((c: any) => c.categoryId === 6);
    expect(fun.spentCents).toBe(0); // budgeted, nothing spent -> still present
    expect(fun.remainingCents).toBe(5000);
  });

  it('can go over budget: remaining goes negative', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/v1/budgets')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...julyFoodBudget, limitCents: 1000 });
    await postTransaction(app, 'token-kenyang', { amountCents: 2500 });

    const res = await request(app)
      .get('/api/v1/insights/monthly?month=2026-07')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.body.categories[0].remainingCents).toBe(-1500);
  });

  it('requires a month param (422)', async () => {
    const res = await request(makeApp())
      .get('/api/v1/insights/monthly')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.status).toBe(422);
  });
});
