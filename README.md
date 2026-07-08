# Guardian API - Codex kickoff

REST API for Guardian — a student budgeting app with trusted-viewer access.
Express + TypeScript + Zod + PostgreSQL (Supabase), with Firebase Auth JWT verification.

## Quick start

```bash
npm install
npm test          # 10 tests, runs fully offline, prints coverage
npm run dev       # requires .env (copy .env.example) with Firebase + Postgres set up
```

## Project structure

```
src/
  app.ts                    App factory - all dependencies injected (testability seam)
  server.ts                 Production wiring: Firebase verifier + Postgres pool
  middleware/auth.ts        Bearer-token middleware with injectable TokenVerifier
  auth/firebaseVerifier.ts  Verifies Firebase ID tokens against Google's JWKS
  schemas/transaction.ts    Zod schemas = runtime validation + TS types (share with the app)
  routes/transactions.ts    The example endpoint pair: POST + GET with pagination
  repos/transactionsRepo.ts Repository interface + InMemory (tests) + Postgres (prod)
tests/
  transactions.test.ts      Auth, validation, creation, pagination, user isolation
```

## The patterns to copy when adding endpoints

Every new route (budgets, viewers, insights, categorize) should follow
`routes/transactions.ts` exactly:

1. **Define the Zod schema first** in `src/schemas/` — it becomes both your
   validator and your TypeScript type, and you copy it into the React Native
   app so client and server can never disagree.
2. **Add a repo interface method** with an in-memory implementation (for tests)
   and a Postgres implementation (plain SQL).
3. **Write the route** using the injected repo. Scope every query by
   `req.user.uid` from the verified JWT — never trust a userId in the body.
4. **Write the tests before wiring production.** The whole suite runs offline
   because auth and storage are injected.

Status code conventions used throughout: `201` create, `200` read,
`401` unauthenticated, `403` authenticated-but-not-allowed (you'll need this
for trusted-viewer routes), `422` validation failure, `500` unexpected.

## Next endpoints to build (in order)

1. `PATCH /api/v1/transactions/:id` — edit + category override (marks the
   merchant cache row `user_override`)
2. `GET/POST /api/v1/budgets` — same pattern, new schema + repo
3. `POST /api/v1/viewers/invite` + `GET /api/v1/viewers/shared-with-me` — the
   authorization-logic showpiece: middleware must answer "owner OR accepted viewer?"
4. `POST /api/v1/categorize` — move the LLM merchant-categorization flow here
   (see the categorization guide); `server.ts` has the TODO marker
5. OpenAPI spec + Swagger UI at `/docs`, then deploy to Render/Railway

## Database schema (run in Supabase SQL editor)

```sql
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  merchant_raw text not null,
  merchant_key text not null,
  category_id smallint not null references categories(id),
  category_source text not null default 'auto',
  occurred_at timestamptz not null,
  note text,
  created_at timestamptz not null default now()
);
create index idx_transactions_user_time on transactions (user_id, occurred_at desc);
```

Because this API connects with Supabase's service-role connection and enforces
user scoping in SQL, you can keep RLS as a second defense layer or rely on the
API as the sole gateway — be ready to explain that tradeoff in interviews.

## Honest-metrics note

`npm test` prints a coverage table. Whatever it says when YOUR full API is done
is the number for your resume — measured, not estimated. Same for endpoint
count: count the routes you actually shipped.
