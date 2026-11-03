# Kit Margin Desk

Shopify embedded app for kit, bundle and gift-set sellers: bill of materials, component inventory sync, true landed cost and margin per kit, basic replenishment and purchase orders, and a ledger with one-click undo. Built from the MVP spec (project 1 of 4). V2 items are out of scope.

Stack: React Router 7 (Shopify app package 4.0), App Bridge, Admin GraphQL API 2026-04, PostgreSQL via Prisma, Shopify Billing API.

## Run it

Demo mode needs no Shopify, no database, no credentials:

    npm install
    npm run build
    DEMO_MODE=true PORT=3000 npm start     # open http://localhost:3000/app
    npm test                                # 59 unit tests (pure logic)
    npm run typecheck

Demo mode serves an in-memory candle-shop fixture: nested and fractional BOMs, a duplicate-SKU trap, a tracking-off component, a losing-money kit. Sync toggles, kit editing, settings, the dry run and ledger undo work in memory. Webhooks, billing, CSV import, POs, builds and the full catalog scan need a real store.

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

## Done since the first cut

- Initial Prisma migration committed (`prisma/migrations/20261103000000_init`, generated with `prisma migrate diff`, not applied to any database). Regenerate it if the schema changes before first deploy.
- Catalog scan uses Shopify bulk operations: `app/core/bulk.ts` (pure: query, JSONL parse, start/finish/poll, fakes) and `app/server/bulk.server.ts` (GraphQL gateway, Prisma store `CatalogScan` and `CatalogVariant`, jobs `bulk_finish` from the `bulk_operations/finish` webhook and `bulk_poll` fallback). Setup page has "Run full scan"; before a bulk scan completes it falls back to the capped 2,000-variant walk and says so.
- Daily digest: `app/core/digest.ts` (pure), `app/core/mailer.ts` (providers: `DIGEST_WEBHOOK_URL` POST, or console), `app/server/digest.server.ts`, worker enqueues at 13:00 UTC. Settings has recipient, quiet-day toggle and a live preview.
- PO export as PDF (pdf-lib, `app/core/po-pdf.ts`) next to CSV.
- Per-location kit availability (`app/core/locations.ts`) shown on the kit editor for plans with multi-location.
- Polaris: `app/components/polaris.tsx` wraps buttons, text/number/email fields, selects, checkboxes, banners and confirm modals. Embedded in Shopify (`PolarisProvider value` in `app/routes/app.tsx`, script loaded by `AppProvider`) they render real `s-*` Polaris web components; standalone demo renders native elements in the Bench styles. Types come from `@shopify/polaris-types`. Not yet migrated: the table sort/filter pill buttons, the VariantPicker combobox and the CSV textarea (native; Polaris has no equivalent that fits the combobox, and `s-text-area` was left out to keep the paste box behaviour).
- `.interface-design/system.md` saved.
- 59 unit tests (core, bulk, locations, digest, mailer, PDF).

## Mocked or unverified (honest list)

- Nothing here has run against a real Shopify store or Postgres. All GraphQL (`inventoryAdjustQuantities`, `inventorySetQuantities`, `inventoryItemUpdate`, variant, order, location queries, `bulkOperationRunQuery`, `currentBulkOperation`, `node(id) on BulkOperation`, `shop { email }`) was written from docs for API 2026-04; field names may need small fixes. The bulk gateway and Prisma store are only exercised through fakes.
- The migration SQL has never been applied. Billing (`billing.request/check`, plan names, `app_subscriptions/update`), OAuth/session storage, and webhook registration (including the new `bulk_operations/finish` topic in `shopify.app.toml`) are untested against Shopify.
- The Polaris branch of `app/components/polaris.tsx` is type-checked but has never rendered in a real admin: attribute names for `s-*` elements, `commandFor` modal wiring and event binding on React 18 need checking in a live embedded app. The native branch is what screenshots cover.
- The digest webhook relay and PDF layout were tested only in unit tests and by parsing the generated PDF, not by receiving a mail or viewing it in a reader.
- "Primary location" falls back to the first active location. Bulk query does not fetch per-location levels (health check does not need them). Order history beyond 60 days needs `read_all_orders`.
- Nightly reconciliation only recomputes app-managed kit quantities. `inventory_levels/update` triggers a debounced recompute.
- Dry run shows planned adjustments for the last 20 kit orders, simulated against current BOMs.
- Design-direction check reports "looks like portfolioSite" because the tool compares catalog pairings; see `.interface-design/system.md`.

## Visual QA status

- Not yet screenshot-verified. The demo-mode server could not be started in the QA session (the shell permission classifier denied the start command), so no route was captured or viewed. Routes still to be viewed: setup (full-scan panel), margin, replenish (PDF button), ledger, settings (desktop and 390px phone), pricing, kits, kit editor (location table).
- To do it: `npm run build`, `DEMO_MODE=true PORT=3121 npx react-router-serve ./build/server/index.js`, then run `look.mjs` per route.
- Static checks that did run: `tsc --noEmit` clean, 59 tests pass, build passes, dom-contract intact. Lint: one FAIL and two WARN, all judged false positives (see `.interface-design/system.md`).
- The Polaris web-component branch (`s-*`) still cannot be seen outside a real Shopify admin.

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
