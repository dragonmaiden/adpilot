# Frontend conventions (public/)

Vanilla JS dashboard — no React, no framework, no build step. Views are rendered
as template-string HTML from IIFE page modules in `public/live/pages/`.

## Stack
- HTML / CSS / vanilla JS (ES2022). IIFE modules attach to `window`.
- Icons: Lucide via `data-lucide="..."` attributes, hydrated by `lucide.createIcons()`.
- `public/index.html` loads scripts directly. No bundler.

## Design tokens (defined in `public/style.css`)
Use these. Never hardcode a value that has a token.

- **Spacing**: `--space-1..16` (1=0.25rem, 4=1rem, 8=2rem).
- **Type**: `--text-xs / sm / base / lg / xl` — fluid `clamp()` based.
- **Radius**: `--radius-sm / md / lg / xl / full`.
- **Color**: `--color-{bg, surface, surface-2, surface-offset, border, text, text-muted, text-faint}`
  and `--color-{primary, success, warning, error}` each with `-subtle / -hover / -active` variants.
- **Controls**: `--control-height-md` (2.5rem), `--control-height-sm` (2rem).
- **Motion**: `--transition-interactive` (180ms ease-out).

Use `color-mix(in srgb, var(--color-X) N%, transparent)` for tints; don't introduce new hex values.

## i18n contract
- Every user-facing string goes through `tr(en, kr)` from `public/live/shared.js`:
  `tr('Daily', '일별')` — first arg English, second Korean.
- Always wrap dynamic values in `esc(...)` (also in `shared.js`) before injecting into HTML strings — this codebase uses `innerHTML`, so XSS is on us to prevent.
- Korean labels run ~30% longer than English on average. Design widths and line-heights for the longer string, not the English placeholder.

## Rendering rules
- Page modules return HTML strings; the host assigns to `el.innerHTML`.
- **Do not rebuild the entire view on every keystroke of an input.** If an input
  drives a chart/diagram, split rendering: render the shell + input once, then
  re-render only the chart *body* via `el.replaceChildren(...newNodes)`. innerHTML
  rebuilds destroy and recreate the input element, which mangles focus and cursor
  position. (Real regression: typing `8.5` rendered as `50.8` before this rule.)
- Debounce input handlers that trigger any non-trivial re-render at ~80ms.
- Re-hydrate Lucide icons after any innerHTML mutation: `lucide.createIcons()`.

## File layout
- `public/style.css` — global styles (tokens + every component lives here)
- `public/base.css` — reset / base
- `public/i18n.js` — language detection
- `public/live/shared.js` — shared helpers: `tr`, `esc`, `formatKrw`, `formatSignedKrw`, `formatPercent`, `formatCount`, `formatUsd`
- `public/live/pages/*.js` — one IIFE per page (`calendar`, `overview`, `settings`, ...)

## Quality gates
- `npm test` — node's built-in test runner.
- `npm run lint` — eslint. Existing `MONTH_SHEET_RE` warning is known; no new errors.
- UI changes: visually verify at **480 / 768 / 1280 / 1920** viewport widths.
- Never use `--no-verify` to bypass hooks. Fix the underlying issue.

## Don'ts
- No new dependencies without checking existing modules first.
- No emojis in code unless explicitly requested.
- No backwards-compat shims for removed features — delete cleanly.
- No comments explaining what code does. Identifier names should carry that.
- No hardcoded colors, spacing, or font-sizes when a token exists.
- No `preserveAspectRatio="none"` on SVGs whose coordinates are pixel-meaningful — it silently distorts geometry.
