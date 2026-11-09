# ShapeRouter API

> **Git policy — never auto-commit or auto-push.** Leave work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when
> the user explicitly asks in that turn**. Approval for an earlier change does not carry
> forward, and finishing a task is not permission to commit it. Stay on the current
> branch — do not create feature branches for code changes.

Backend API server for ShapeRouter, an LLM structured-output platform. Bun + Hono
HTTP server exposing public AI-invocation routes and admin CRUD for entities,
projects, endpoints, and keys. `private`, not published to npm; shipped as a Docker image.

## This repo is a thin wrapper

**Almost all behavior lives in two private packages, not here:**
`@sudobility/shapeshyft_service` (server, routes, middleware, auth, shared DB tables/DDL,
env reader, rate limiting) and `@sudobility/shapeshyft_engine` (LLM adapters, prompts,
media, provider catalog). ShapeShyft is the sibling product built on the same packages.

**A fix to a route, middleware, adapter, or prompt goes in the library, then both APIs
bump** — not in this repo. Do not look for `src/routes/index.ts`, `src/services/llm/`,
`src/middleware/`, `src/config/`, or `src/lib/entity-helpers.ts` here; they are in the
packages. What stays here is only what makes it ShapeRouter:

- `src/index.ts` — entry: `createApiServer({ name, routes, db, initDatabase, port })`.
- `src/service.ts` — `createShapeshyftService(...)` wiring + `mountShaperouterRoutes`
  (the only ShapeRouter-only routes). Key prefixes: user `shroute_`, entity `shrouteent`.
- `src/credentials/llm-key-resolver.ts` — `ProviderCredentialResolver` backed by the
  per-entity `llm_api_keys` table (bound by `endpoints.llm_key_id`; call-time
  `llm_provider` override picks the entity's most-recently-updated active key).
- `src/db/` — `createLazyDatabase`, `initDatabase()`, `schema.ts` (re-exports shared
  tables + defines `llm_api_keys`), `llm-api-keys.ts` (that table's DDL + FK + backfill),
  `init.ts` (`bun run db:init`), `migrate.ts` (one-off).
- `src/routes/keys.ts` (LLM provider key CRUD, encrypted), `src/routes/provider-sync.ts`
  (point self-hosted LM Studio providers at the caller's IP).
- `src/lib/` — `encryption.ts` (ENCRYPTION_KEY-backed), `env-helper.ts` (`.env.local`
  wins), `peer-address.ts`, `provider-url.ts`.
- `src/schemas/` — `keys.ts`, `endpoint-binding.ts` (`llm_key_id` validation).

## Tech stack

- TypeScript (strict), runtime **Bun** (do not use npm/yarn/pnpm to install).
- Hono ~4.11, Drizzle ORM ~0.45, `postgres` driver ~3.4, Zod ~3.25.
- Firebase Admin auth (via `@sudobility/auth_service`), Vitest ~4.1 for tests.
- Sharp for image conversion. Six `@sudobility/*` packages from GitHub Packages
  (`.npmrc` points `@sudobility` at `npm.pkg.github.com`).

## Commands (all verified)

```bash
bun run dev          # Dev server, hot reload (--watch). Runs TS directly; no build.
bun run start        # Run src/index.ts (no watch)
bun run build        # bun build -> dist/ (production Docker only)
bun run start:prod   # Run dist/index.js
bun run test:unit    # Unit tests, Vitest. Excludes *.db.test.ts. This is what CI runs.
bun run test:watch   # Unit tests, watch mode
bun run test:db      # DB tests (*.db.test.ts), Vitest. MANUAL — never in CI.
                     # Needs TEST_DATABASE_URL on localhost; refuses any other host.
bun run test:db:setup  # Create local shaperouter_test database
bun run lint         # eslint src
bun run typecheck    # tsc --noEmit
bun run format       # prettier --write src
bun run db:init      # Run initDatabase() standalone, then exit (idempotent)
bun run verify       # typecheck + lint + test:unit  (pre-commit gate)
```

**There is no `bun run test` script** — use `bun run test:unit`. And **never `bun test`**
(Bun's own runner): it ignores both Vitest configs, collects the `*.db.test.ts` suites,
and runs them against `DATABASE_URL` from `.env` (a remote DB). Single file:
`bunx vitest run tests/unit/encryption.test.ts`.

## Database

- PostgreSQL, **`shaperouter` schema** (not `public`). Shared tables created by
  `initServiceTables(...)` with `schemaName: "shaperouter"`; add new shared tables via
  the library. `llm_api_keys` is the one table defined locally (`schema.ts` /
  `llm-api-keys.ts`).
- **Lazy Proxy connection** (`createLazyDatabase`): nothing connects at import; the
  connection opens on first access. Intentional — lets tests and scripts import `src/db`
  without `DATABASE_URL`.
- **`initDatabase()` IS the migration system** — no migration tool. It runs on every
  server boot *and* via `bun run db:init`; every statement is idempotent.

## Environment

`.env.local` overrides the process env. Required: `DATABASE_URL`;
`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`;
**`ENCRYPTION_KEY` (exactly 64 hex chars / 32 bytes)** — encrypts LLM keys and storage
creds at rest; missing it causes runtime errors. Optional: `SITEADMIN_EMAILS`,
`REVENUECAT_API_KEY` (rate limiting), `RESEND_*` + `APP_URL` (invitation email),
`LM_STUDIO_TIMEOUT_MS`, `PORT` (default 3000). Full list in `.env.example`.

## Auth and keys (three key types — the prefix routes the credential)

- `sk_live_...` — **project** key; authenticates callers of a published AI endpoint
  (`/api/v1/ai/:entity/:project/:endpoint`). Read from `Authorization: Bearer` or
  `?api_key=`. Public AI routes do NOT use Firebase and do NOT use `X-API-Key`.
- `shroute_...` — **personal** key; authenticates its owner on admin routes
  (`X-API-Key` or Bearer). Stores an AES copy, so `/reveal` is possible.
- `shrouteent...` — **entity** key; authenticates as the workspace itself (no person).
  Path-restricted to `/entities/*` (403 elsewhere), hash-only (plaintext shown once,
  unrecoverable), and cannot mint/reveal keys or touch `/users/*`.

Admin routes accept any of the three via `firebaseAuthMiddleware`, checked in order:
personal key, entity key, Firebase token. Handlers read `c.get("userId")` /
`c.get("userEmail")`, **never `firebaseUser`** (undefined on API-key requests).

## Gotchas

- **Route order matters**: public AI/provider routes register before admin routes;
  ShapeRouter-only routes (`/entities/self/providers`) register before `/entities/:slug`
  so `self` is not taken for a slug. (Admin apply a wildcard auth middleware.)
- **Invoke path has no `/invoke` suffix** — the endpoint name is the last path segment;
  `/prompt` is the one reserved suffix.
- **`@sudobility/*` packages are inlined** via Vitest `server.deps.inline` — they ship
  extensionless/directory-style imports Bun resolves but Node's ESM resolver rejects.
- **`hono/bun` is aliased** to `tests/stubs/hono-bun.ts` in both Vitest configs; do not
  make its `getConnInfo` return a fixed address (suites assert on their own fixtures).
- **Version mismatches among the six `@sudobility/*` deps** are the most common type-error
  cause. Update with `bun update @sudobility/<pkg> && bun run typecheck`.
- **`drizzle` cast to `any` in `service.ts`** is deliberate — instances differ under
  `bun link` during local library development.
- Rate limiting **fails open** (unconfigured/throwing RevenueCat lets requests through);
  site-admin-owned entities skip it. It is per-entity, keyed by entity id.

## Docs & build

- Dockerfile: `oven/bun`, installs with a GH Packages `~/.npmrc` (token via
  `GH_PACKAGES_TOKEN` build arg), `bun install --production`, runs `bun run start`,
  EXPOSE 8020 (set `PORT=8020` to match the healthcheck).
- CI: `.github/workflows/ci-cd.yml` calls `johnqh/workflows` unified CI/CD;
  `skip-npm-publish: true` (API server, not a library); publishes a Docker image.
- README covers install/usage/routes/providers. This is a **leaf app** — nothing
  depends on it; the ShapeShyft sibling and the `@sudobility/*` packages are upstream.
