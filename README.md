# Kit Margin Desk

Shopify embedded app for kit, bundle and gift-set sellers: bill of materials, component inventory sync, true landed cost and margin per kit, basic replenishment and purchase orders, and a ledger with one-click undo. Built from the MVP spec (project 1 of 4). V2 items are out of scope.

Stack: React Router 7 (Shopify app package 4.0), App Bridge, Admin GraphQL API 2026-04, PostgreSQL via Prisma, Shopify Billing API.

## Run it

Demo mode needs no Shopify, no database, no credentials:

    npm install
    npm run build
    DEMO_MODE=true PORT=3000 npm start     # open http://localhost:3000/app
    npm test                                # 37 unit tests (pure logic)
    npm run typecheck

Demo mode serves an in-memory candle-shop fixture: nested and fractional BOMs, a duplicate-SKU trap, a tracking-off component, a losing-money kit. Sync toggles, kit editing, settings, the dry run and ledger undo work in memory. Webhooks, billing, CSV import, POs and builds need a real store.

Real mode:

1. `cp .env.example .env` and fill in `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL` (Postgres).
2. Edit `shopify.app.toml` (client_id, URLs), then `npm run setup` (Prisma generate and migrate; create the first migration with `npx prisma migrate dev --name init`).
3. `npm run dev` (Shopify CLI) for the web app, and `npm run worker` in a second process for the job queue and nightly reconciliation.

Env vars: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL, SCOPES, DATABASE_URL, DEMO_MODE, BILLING_LIVE (billing runs in test mode unless "true").

## Layout

- `app/core` pure logic, no I/O, all unit-tested: `bom.ts` (explode, nesting cap 3, cycle detection, derived availability), `margin.ts` (landed cost, margin, cost-change impact, weighted average cost), `sync.ts` (convergent order/refund/cancel planner), `ledger.ts` (`applyAdjustments`, undo with drift detection and compensating adjustment), `replenish.ts`, `plans.ts`, `csv.ts`, `views.ts`.
- `app/server` Shopify GraphQL boundary (`shopify-api.ts`), Prisma repo, sync handlers, DB job queue, UI actions, demo fixture.
- `app/routes` screens (Kits, Setup health check and dry run, BOM editor, Margin desk, Replenish and POs, Ledger, Settings, Plan) and webhook endpoints.
- `worker/index.ts` job loop. `prisma/schema.prisma` data model.

## Design decisions worth knowing

- Sync is off by default; kill switch "Pause all sync" stops every write.
- Sync is convergent: per order line the app stores what it has applied and always moves to `ordered - restocked refunds - unfulfilled cancels`. Duplicate delivery, edits, partial refunds and refund-before-create all land on the same stock (property-tested). Refunds with no restock never add components.
- Orders are decremented at creation, not payment (spec choice, mirrors native bundles).
- Kits touching duplicate SKUs are held back from sync; costing still works.
- Undo is never paywalled. If stock moved since the batch, undo explains why and offers a compensating adjustment.
- Plan limits: over-cap kit orders are not decremented and are logged for review, never silently dropped.
- Webhooks only verify HMAC and enqueue; a Postgres job table with SKIP LOCKED does the work, with retries and backoff.

## Billing

`app/shopify.server.ts` declares Kit Desk ($29), Kit Desk Pro ($59), Plus ($119), 14-day trials, via the Billing API. Entitlements are re-derived from `billing.check` on every request and kept in sync by the `app_subscriptions/update` webhook. Free tier: 3 kits, 20 kit orders a month. Annual prices are listed in the UI but only monthly plans are wired to billing.

## Mocked or unverified (honest list)

- Nothing here has run against a real Shopify store or Postgres. GraphQL queries and mutations (`inventoryAdjustQuantities`, `inventorySetQuantities`, `inventoryItemUpdate`, variant and order queries, billing) were written from docs for API 2026-04 and are untested; field names may need small fixes.
- No Prisma migration is committed (needs a database to generate); run `prisma migrate dev`.
- "Primary location" falls back to the first active location.
- Catalog scan walks 2,000 variants synchronously; larger catalogs should use `bulkOperationRunQuery` (not implemented). Order history beyond 60 days needs `read_all_orders`.
- The nightly reconciliation only recomputes app-managed kit quantities; the digest email, PDF PO export (CSV only), and multi-location kit availability are not implemented. `inventory_levels/update` triggers a debounced recompute.
- The embedded shell uses Shopify's AppProvider and `s-app-nav`. The UI is custom CSS (a deliberate design decision, see below), not Polaris components; Polaris React was removed. If App Store review requires Polaris web components for controls, swap the markup in `app/components` and keep the tokens.
- Dry run shows the planned adjustments for the last 20 kit orders, simulated against current BOMs.
- `.interface-design/system.md` was not saved.

## Design

"Bench" direction (light instrument panel): bone page, paper panels, hairlines, square corners, Schibsted Grotesk with IBM Plex Mono figures, teal for gain and vermilion for loss. Signature: a price ruler showing where each dollar of a kit's price goes (parts, uplift, packaging, labor, margin).
