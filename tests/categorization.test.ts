import request from 'supertest';
import { buildApp } from '../src/app';
import { InMemoryTransactionsRepo } from '../src/repos/transactionsRepo';
import { InMemoryBudgetsRepo } from '../src/repos/budgetsRepo';
import { InMemoryViewersRepo } from '../src/repos/viewersRepo';
import { InMemoryMerchantCategoriesRepo } from '../src/repos/merchantCategoriesRepo';
import {
  FALLBACK_CATEGORY_ID,
  makeCachedCategorizer,
  type CategorizationService,
} from '../src/categorization/categorizer';

/**
 * LLM categorization suite. The classifier is a jest.fn stub - no network,
 * no API key. The DoD test: logging the same merchant twice produces exactly
 * one LLM call and one cache hit, visible in the events trail.
 */

describe('makeCachedCategorizer', () => {
  function setup(classifier: jest.Mock) {
    const repo = new InMemoryMerchantCategoriesRepo();
    const service = makeCachedCategorizer(repo, classifier);
    return { repo, service };
  }

  it('DoD: same merchant twice = one LLM call + one cache hit in the events', async () => {
    const classifier = jest.fn().mockResolvedValue(1);
    const { repo, service } = setup(classifier);

    const first = await service.categorize('DUNKIN #341782 MANCHESTER NH');
    const second = await service.categorize('DUNKIN #341782 MANCHESTER NH');

    expect(classifier).toHaveBeenCalledTimes(1); // second call never reached the model
    expect(first).toMatchObject({ categoryId: 1, categoryName: 'Food & Drink', source: 'llm' });
    expect(second).toMatchObject({ categoryId: 1, source: 'cache' });
    expect(repo.events.map((e) => e.outcome)).toEqual(['llm_call', 'cache_hit']);
  });

  it('normalization makes different store numbers share one cache entry', async () => {
    const classifier = jest.fn().mockResolvedValue(1);
    const { service } = setup(classifier);

    // Different raw strings, same merchant after normalization.
    const a = await service.categorize('DUNKIN #341782 MANCHESTER NH');
    const b = await service.categorize('DUNKIN #227105 MANCHESTER NH');

    expect(classifier).toHaveBeenCalledTimes(1);
    expect(a.merchantKey).toBe(b.merchantKey);
    expect(b.source).toBe('cache');
  });

  it.each([
    ['out-of-range id', 47],
    ['zero', 0],
    ['NaN from unparseable text', NaN],
    ['non-integer', 3.7],
  ])('invalid classifier output (%s) falls back to Other and is NOT cached', async (_name, bad) => {
    const classifier = jest.fn().mockResolvedValue(bad);
    const { repo, service } = setup(classifier);

    const result = await service.categorize('MYSTERY MERCHANT');
    expect(result).toMatchObject({ categoryId: FALLBACK_CATEGORY_ID, source: 'fallback' });
    expect(repo.events.map((e) => e.outcome)).toEqual(['llm_error_fallback']);

    // A transient failure must not poison the cache: the next attempt asks again.
    await service.categorize('MYSTERY MERCHANT');
    expect(classifier).toHaveBeenCalledTimes(2);
  });

  it('classifier throwing (API down) falls back to Other', async () => {
    const classifier = jest.fn().mockRejectedValue(new Error('api unreachable'));
    const { repo, service } = setup(classifier);

    const result = await service.categorize('DUNKIN MANCHESTER NH');
    expect(result.categoryId).toBe(FALLBACK_CATEGORY_ID);
    expect(result.source).toBe('fallback');
    expect(repo.events[0].outcome).toBe('llm_error_fallback');
  });
});

describe('POST /api/v1/categorize', () => {
  const USERS: Record<string, { uid: string }> = {
    'token-kenyang': { uid: 'user-kenyang' },
  };

  function makeApp(service?: CategorizationService) {
    const transactionsRepo = new InMemoryTransactionsRepo();
    const categorization =
      service ??
      makeCachedCategorizer(new InMemoryMerchantCategoriesRepo(), async (raw) =>
        raw.toUpperCase().includes('DUNKIN') ? 1 : 10,
      );
    return buildApp({
      verifyToken: async (token) => {
        const user = USERS[token];
        if (!user) throw new Error('bad token');
        return user;
      },
      transactionsRepo,
      budgetsRepo: new InMemoryBudgetsRepo(transactionsRepo),
      viewersRepo: new InMemoryViewersRepo(),
      categorize: async (raw) => (await categorization.categorize(raw)).categoryId,
      categorization,
    });
  }

  it('categorizes a merchant and reports the source', async () => {
    const app = makeApp();

    const first = await request(app)
      .post('/api/v1/categorize')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ merchantRaw: 'DUNKIN #341782 MANCHESTER NH' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      merchantKey: 'dunkin manchester nh',
      categoryId: 1,
      categoryName: 'Food & Drink',
      source: 'llm',
    });

    const second = await request(app)
      .post('/api/v1/categorize')
      .set('Authorization', 'Bearer token-kenyang')
      .send({ merchantRaw: 'DUNKIN #999 MANCHESTER NH' });
    expect(second.body.source).toBe('cache');
  });

  it('rejects a missing merchantRaw (422) and anonymous callers (401)', async () => {
    const app = makeApp();
    const invalid = await request(app)
      .post('/api/v1/categorize')
      .set('Authorization', 'Bearer token-kenyang')
      .send({});
    expect(invalid.status).toBe(422);

    const anonymous = await request(app)
      .post('/api/v1/categorize')
      .send({ merchantRaw: 'DUNKIN' });
    expect(anonymous.status).toBe(401);
  });

  it('transactions auto-categorize through the same cached flow', async () => {
    const repo = new InMemoryMerchantCategoriesRepo();
    const classifier = jest.fn().mockResolvedValue(1);
    const app = makeApp(makeCachedCategorizer(repo, classifier));

    const res = await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', 'Bearer token-kenyang')
      .send({
        amountCents: 575,
        merchantRaw: 'DUNKIN #341782 MANCHESTER NH',
        occurredAt: '2026-07-06T12:30:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.categoryId).toBe(1);
    expect(res.body.categorySource).toBe('auto');
    expect(repo.events.map((e) => e.outcome)).toEqual(['llm_call']);
  });
});
