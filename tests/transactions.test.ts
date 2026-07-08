import request from 'supertest';
import { buildApp } from '../src/app';
import { InMemoryTransactionsRepo } from '../src/repos/transactionsRepo';
import { InMemoryBudgetsRepo } from '../src/repos/budgetsRepo';
import { normalizeMerchant } from '../src/routes/transactions';

/**
 * Offline test suite: auth verifier and categorizer are stubs, storage is the
 * in-memory repo. Run with `npm test` - Jest reports coverage, and THAT number
 * is the one that goes on your resume.
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

const validBody = {
  amountCents: 575,
  merchantRaw: 'DUNKIN #341782 MANCHESTER NH',
  occurredAt: '2026-07-06T12:30:00.000Z',
};

describe('auth middleware', () => {
  it('rejects requests with no token (401)', async () => {
    const res = await request(makeApp()).get('/api/v1/transactions');
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid token (401)', async () => {
    const res = await request(makeApp())
      .get('/api/v1/transactions')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/transactions', () => {
  it('creates a transaction and auto-categorizes it (201)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.categoryId).toBe(1); // stub categorizer: DUNKIN -> Food & Drink
    expect(res.body.categorySource).toBe('auto');
    expect(res.body.merchantKey).toBe('dunkin manchester nh');
    expect(res.body.userId).toBe('user-kenyang');
  });

  it('respects a user-supplied category (manual)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...validBody, categoryId: 6 });

    expect(res.status).toBe(201);
    expect(res.body.categoryId).toBe(6);
    expect(res.body.categorySource).toBe('manual');
  });

  it('rejects float amounts with a named issue (422)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...validBody, amountCents: 5.75 });

    expect(res.status).toBe(422);
    expect(res.body.issues[0].path).toContain('amountCents');
  });

  it('rejects a missing merchant (422)', async () => {
    const { merchantRaw: _drop, ...noMerchant } = validBody;
    const res = await request(makeApp())
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send(noMerchant);
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/transactions', () => {
  it('paginates with a cursor and never leaks other users data', async () => {
    const app = makeApp();

    // seed: 3 for kenyang, 1 for elena
    for (let i = 1; i <= 3; i++) {
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', 'Bearer token-kenyang')
        .send({ ...validBody, occurredAt: `2026-07-0${i}T10:00:00.000Z` });
    }
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-elena')
      .send(validBody);

    // page 1
    const page1 = await request(app)
      .get('/api/v1/transactions?limit=2')
      .set('Authorization', 'Bearer token-kenyang');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();
    expect(page1.body.items.every((t: any) => t.userId === 'user-kenyang')).toBe(true);

    // page 2 via cursor
    const page2 = await request(app)
      .get(`/api/v1/transactions?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', 'Bearer token-kenyang');
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('filters by month', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...validBody, occurredAt: '2026-06-15T10:00:00.000Z' });
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ ...validBody, occurredAt: '2026-07-15T10:00:00.000Z' });

    const res = await request(app)
      .get('/api/v1/transactions?month=2026-07')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].occurredAt.startsWith('2026-07')).toBe(true);
  });

  it('rejects a malformed month (422)', async () => {
    const res = await request(makeApp())
      .get('/api/v1/transactions?month=July')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.status).toBe(422);
  });
});

describe('normalizeMerchant', () => {
  it('collapses store numbers and locations to a stable key', () => {
    expect(normalizeMerchant('DUNKIN #341782 MANCHESTER NH')).toBe('dunkin manchester nh');
    expect(normalizeMerchant('DUNKIN #99201 MANCHESTER NH')).toBe('dunkin manchester nh');
  });
});

// Helper: create a row as the given user and return its id.
async function seedTransaction(app: ReturnType<typeof makeApp>, token: string) {
  const res = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send(validBody);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('PATCH /api/v1/transactions/:id', () => {
  it('updates supplied fields and leaves the rest alone (200)', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang')
      .send({ amountCents: 999, note: 'split with roommate' });

    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(999);
    expect(res.body.note).toBe('split with roommate');
    expect(res.body.merchantRaw).toBe(validBody.merchantRaw); // untouched
  });

  it('flips categorySource to manual when the category changes', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang'); // auto-categorized

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang')
      .send({ categoryId: 6 });

    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe(6);
    expect(res.body.categorySource).toBe('manual');
  });

  it('recomputes merchantKey when merchantRaw changes', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang')
      .send({ merchantRaw: 'STARBUCKS #55 BOSTON MA' });

    expect(res.status).toBe(200);
    expect(res.body.merchantKey).toBe('starbucks boston ma');
  });

  it("returns 404 when patching another user's row, leaving it unchanged", async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-elena')
      .send({ amountCents: 1 });
    expect(res.status).toBe(404);

    // Kenyang's row is untouched.
    const list = await request(app)
      .get('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang');
    expect(list.body.items[0].amountCents).toBe(validBody.amountCents);
  });

  it('returns 404 for a well-formed id that does not exist', async () => {
    const res = await request(makeApp())
      .patch('/api/v1/transactions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ note: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid field values (422)', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang')
      .send({ amountCents: 5.75 });

    expect(res.status).toBe(422);
    expect(res.body.issues[0].path).toContain('amountCents');
  });

  it('rejects an empty patch body (422)', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .patch(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang')
      .send({});
    expect(res.status).toBe(422);
  });

  it('rejects a malformed id (422)', async () => {
    const res = await request(makeApp())
      .patch('/api/v1/transactions/not-a-uuid')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ note: 'x' });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/v1/transactions/:id', () => {
  it('deletes an owned row (204) and the row is gone', async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const del = await request(app)
      .delete(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-kenyang');
    expect(del.status).toBe(204);

    const list = await request(app)
      .get('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang');
    expect(list.body.items).toHaveLength(0);
  });

  it("returns 404 when deleting another user's row, leaving it intact", async () => {
    const app = makeApp();
    const id = await seedTransaction(app, 'token-kenyang');

    const res = await request(app)
      .delete(`/api/v1/transactions/${id}`)
      .set('Authorization', 'Bearer token-elena');
    expect(res.status).toBe(404);

    const list = await request(app)
      .get('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang');
    expect(list.body.items).toHaveLength(1);
  });

  it('returns 404 for a row that never existed', async () => {
    const res = await request(makeApp())
      .delete('/api/v1/transactions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.status).toBe(404);
  });
});
