import request from 'supertest';
import { buildApp } from '../src/app';
import { InMemoryTransactionsRepo } from '../src/repos/transactionsRepo';
import { InMemoryBudgetsRepo } from '../src/repos/budgetsRepo';
import { InMemoryViewersRepo } from '../src/repos/viewersRepo';
import { InMemoryMerchantCategoriesRepo } from '../src/repos/merchantCategoriesRepo';
import { makeCachedCategorizer } from '../src/categorization/categorizer';

/**
 * Trusted-viewers suite. The four tests that matter (per the build guide):
 *   1. accepted viewer CAN read the owner's insights
 *   2. a viewer CANNOT write - no such route even exists
 *   3. revoked viewer loses access
 *   4. pending (unaccepted) viewer has no access
 * Everything else is supporting cast around the invite lifecycle.
 */

const USERS: Record<string, { uid: string; email: string }> = {
  'token-kenyang': { uid: 'user-kenyang', email: 'kenyang@example.com' },
  'token-elena': { uid: 'user-elena', email: 'elena@example.com' },
  'token-marc': { uid: 'user-marc', email: 'marc@example.com' },
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
    viewersRepo: new InMemoryViewersRepo(),
    categorize: async (merchantRaw) => (merchantRaw.toUpperCase().includes('DUNKIN') ? 1 : 10),
    categorization: makeCachedCategorizer(
      new InMemoryMerchantCategoriesRepo(),
      async (merchantRaw) => (merchantRaw.toUpperCase().includes('DUNKIN') ? 1 : 10),
    ),
  });
}

type App = ReturnType<typeof makeApp>;

/** Owner (kenyang) invites elena; returns the invite id. */
async function invite(app: App, email = 'elena@example.com'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/viewers/invite')
    .set('Authorization', 'Bearer token-kenyang')
    .send({ email });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('pending');
  expect(res.body.viewerUid).toBeNull(); // identity not bound yet
  return res.body.id;
}

async function accept(app: App, inviteId: string, token = 'token-elena') {
  const res = await request(app)
    .post(`/api/v1/viewers/accept/${inviteId}`)
    .set('Authorization', `Bearer ${token}`);
  return res;
}

/** Seed the owner with a July budget + one Dunkin transaction. */
async function seedOwnerData(app: App) {
  await request(app)
    .post('/api/v1/budgets')
    .set('Authorization', 'Bearer token-kenyang')
    .send({ categoryId: 1, month: '2026-07', limitCents: 20000 });
  await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', 'Bearer token-kenyang')
    .send({
      amountCents: 575,
      merchantRaw: 'DUNKIN #341782 MANCHESTER NH',
      occurredAt: '2026-07-06T12:30:00.000Z',
    });
}

const sharedInsightsUrl = '/api/v1/shared/user-kenyang/insights/monthly?month=2026-07';

describe('invite lifecycle', () => {
  it('accept binds the viewer uid and flips status', async () => {
    const app = makeApp();
    const inviteId = await invite(app);

    const res = await accept(app, inviteId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.viewerUid).toBe('user-elena'); // NULL -> bound identity
  });

  it('rejects acceptance by someone the invite was not addressed to', async () => {
    const app = makeApp();
    const inviteId = await invite(app); // addressed to elena@example.com

    const res = await accept(app, inviteId, 'token-marc');
    expect(res.status).toBe(404); // not 403: don't confirm the invite exists
  });

  it('an invite cannot be accepted twice', async () => {
    const app = makeApp();
    const inviteId = await invite(app);
    await accept(app, inviteId);
    expect((await accept(app, inviteId)).status).toBe(404); // no longer pending
  });

  it('re-inviting the same email is idempotent while pending', async () => {
    const app = makeApp();
    const first = await invite(app);
    const second = await invite(app);
    expect(second).toBe(first); // same row, no duplicate

    const list = await request(app)
      .get('/api/v1/viewers')
      .set('Authorization', 'Bearer token-kenyang');
    expect(list.body.items).toHaveLength(1);
  });

  it('owners cannot invite themselves (422)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/viewers/invite')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ email: 'KENYANG@example.com' }); // case-insensitive match
    expect(res.status).toBe(422);
  });

  it('rejects a malformed email (422)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/viewers/invite')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
  });
});

describe('shared insights access (the four that matter)', () => {
  it('1. an accepted viewer can read the owners insights', async () => {
    const app = makeApp();
    await seedOwnerData(app);
    const inviteId = await invite(app);
    await accept(app, inviteId);

    const res = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-elena');

    expect(res.status).toBe(200);
    expect(res.body.ownerUid).toBe('user-kenyang');
    expect(res.body.categories[0].categoryName).toBe('Food & Drink');
    expect(res.body.categories[0].spentCents).toBe(575); // the owner's data
  });

  it('2. a viewer cannot write: no shared write route exists at all', async () => {
    const app = makeApp();
    const inviteId = await invite(app);
    await accept(app, inviteId);

    // Attempt to create a transaction "as" the owner through the shared
    // namespace: the route does not exist, so Express 404s before any
    // permission logic could even run.
    const res = await request(app)
      .post('/api/v1/shared/user-kenyang/transactions')
      .set('Authorization', 'Bearer token-elena')
      .send({
        amountCents: 100,
        merchantRaw: 'SNEAKY VIEWER WRITE',
        occurredAt: '2026-07-06T12:30:00.000Z',
      });
    expect(res.status).toBe(404);

    // And a viewer posting to the normal endpoint writes to their OWN
    // account - the owner's transaction list is untouched.
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-elena')
      .send({
        amountCents: 100,
        merchantRaw: 'ELENAS OWN COFFEE',
        occurredAt: '2026-07-06T12:30:00.000Z',
      });
    const owners = await request(app)
      .get('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang');
    expect(owners.body.items).toHaveLength(0);
  });

  it('3. a revoked viewer loses access', async () => {
    const app = makeApp();
    await seedOwnerData(app);
    const inviteId = await invite(app);
    await accept(app, inviteId);

    // Access works...
    const before = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-elena');
    expect(before.status).toBe(200);

    // ...owner revokes...
    const revoke = await request(app)
      .delete(`/api/v1/viewers/${inviteId}`)
      .set('Authorization', 'Bearer token-kenyang');
    expect(revoke.status).toBe(204);

    // ...and the very next read is refused.
    const after = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-elena');
    expect(after.status).toBe(403);
  });

  it('4. a pending (unaccepted) viewer has no access', async () => {
    const app = makeApp();
    await seedOwnerData(app);
    await invite(app); // never accepted

    const res = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-elena');
    expect(res.status).toBe(403);
  });

  it('a total stranger gets 403, an anonymous caller gets 401', async () => {
    const app = makeApp();
    await seedOwnerData(app);

    const stranger = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-marc');
    expect(stranger.status).toBe(403); // authenticated, not permitted

    const anonymous = await request(app).get(sharedInsightsUrl);
    expect(anonymous.status).toBe(401); // not even authenticated
  });

  it('the owner can use their own shared URL', async () => {
    const app = makeApp();
    await seedOwnerData(app);
    const res = await request(app)
      .get(sharedInsightsUrl)
      .set('Authorization', 'Bearer token-kenyang');
    expect(res.status).toBe(200);
  });
});

describe('revoke and re-invite', () => {
  it('only the owner can revoke (404 for others - do not confirm the id)', async () => {
    const app = makeApp();
    const inviteId = await invite(app);
    const res = await request(app)
      .delete(`/api/v1/viewers/${inviteId}`)
      .set('Authorization', 'Bearer token-elena');
    expect(res.status).toBe(404);
  });

  it('re-inviting a revoked viewer re-opens the invite as pending', async () => {
    const app = makeApp();
    const inviteId = await invite(app);
    await accept(app, inviteId);
    await request(app)
      .delete(`/api/v1/viewers/${inviteId}`)
      .set('Authorization', 'Bearer token-kenyang');

    const reopenedId = await invite(app); // helper asserts pending + null uid
    expect(reopenedId).toBe(inviteId); // same row re-opened, not a duplicate

    // The old acceptance is gone: elena must accept again to regain access.
    const res = await accept(app, reopenedId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });
});

describe('shared-with-me', () => {
  it('lists only accepted shares, from the viewer side', async () => {
    const app = makeApp();
    const inviteId = await invite(app);

    // Pending: nothing shared with elena yet.
    let res = await request(app)
      .get('/api/v1/viewers/shared-with-me')
      .set('Authorization', 'Bearer token-elena');
    expect(res.body.items).toHaveLength(0);

    await accept(app, inviteId);
    res = await request(app)
      .get('/api/v1/viewers/shared-with-me')
      .set('Authorization', 'Bearer token-elena');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].ownerUid).toBe('user-kenyang');
  });
});
