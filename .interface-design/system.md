# Kit Margin Desk interface system ("Bench")

Light instrument panel for kit economics. Hard constraints kept: square-ish corners (tokens `--r-control`, `--r-panel`), hairlines and tonal fills instead of shadows, verdict sentence as page title, one signature (the price ruler).

## Tokens (app/styles/ledger.css :root)
- Surfaces: `--bone` page #e4e1d9, `--panel` #f2efe8, `--well` #d9d5ca, `--hairline`, `--hairline-strong`
- Ink: `--ink` #17181a, `--ink-2`, `--ink-3`, `--on-ink`
- Status (product-world names): `--gain` teal (margin earned), `--loss` vermilion (margin lost), `--caution` amber (thin or unknown); each with a `-wash`
- Live screens: `--live`
- Type: `--font-display` and `--font-ui` Schibsted Grotesk; `--font-figure` IBM Plex Mono for money, SKUs and quantities. Scale 12/14/17/20/24/50.
- Space: 4px grid `--s1..--s6`; control height `--hit`.

## Patterns
- Page head: verdict sentence (h1), one supporting line, hairline rule in ink. Lead page gets a 50px figure.
- Ruled tables with right-aligned tabular figures; stamps for status (ok, warn, bad, quiet).
- Signature: price ruler, a segmented bar of where each dollar of the price goes (parts, uplift, packaging, labor, margin). Mini version in table rows, big version on the kit editor.
- Kill switch is a bordered strip that turns vermilion when armed.
- Controls: all through `app/components/polaris.tsx`. Native elements with the Bench styles standalone, real `s-*` Polaris web components inside the Shopify admin. Do not use raw `<button>` or `<input>` for primary controls in routes.
- Per-location availability is a small ruled table in the kit editor sidebar, lead stamp "Most stock".

## Direction verification note
`direction.mjs --verify` reports "looks like portfolioSite: same font pairing". The tool derives the pairing from the direction catalog entry (Schibsted Grotesk + Martian Mono), not from this project's CSS. This project ships Schibsted Grotesk + IBM Plex Mono, installed and used; Martian Mono is neither installed nor referenced. Palette tokens also differ in role (this project's accents are gain/loss, not a generic accent). Treated as a catalog-level false positive; the remaining way to silence it would be choosing another direction, which would discard the KEEP list (bone panel, price ruler).
