# AGENTS.md - AdPilot Engineering Guide

This repository is an AdPilot product codebase, not a deleted bot workspace. Do not look for or depend on old operator-memory files such as `SOUL.md`, `MEMORY.md`, `TOOLS.md`, `USER.md`, or similar bot-context documents.

Use this file as the compact system-design guide for future agents and engineers working in this repo.

## Operating Mode

- Build for correctness, maintainability, and debuggability before polish.
- Treat profit, revenue, refunds, COGS, shipping, payment fees, ad spend, and true net profit as financial data. Never fake precision or silently fall back to misleading percentages.
- Prefer small, scoped changes that reduce concept duplication and blast radius.
- Keep domain calculations out of UI components unless they are purely presentational formatting.
- Do not add AI, ads-performance, or operations surfaces unless they directly support profit visibility.
- When unsure, trace state and data writes before changing rendering code.

## Review Usage

- These numbered principles are active instructions, not optional background reading.
- Cite a principle ID when it materially explains a review finding or implementation choice.
- Prefer a specific principle ID over generic shorthand like KISS, DRY, or YAGNI.
- Do not force citations into trivial edits. If no specific principle applies, say so plainly.

## Baseline Rules

B1. Keep it simple. Prefer the smallest solution a maintainer can understand quickly.

B2. Say things once. Shared business logic belongs in the nearest stable owner, such as `server/domain`, `server/services`, `server/contracts`, a shared transform, or a focused client module. Do not point future work at packages that do not exist in this repo.

B3. Do not build speculative abstractions. Every change must trace to a concrete requirement, user-visible problem, correctness issue, or cleanup goal.

B4. Correctness comes before cleverness, speed, or polish. Prove intended behavior before compacting, optimizing, or widening an abstraction.

B5. Measure before optimizing. Keep deterministic behavior and readable control flow unless a measured hot path requires a targeted tradeoff.

B6. Optimize for readers. Obvious, searchable, intention-revealing code beats compressed expressions that are hard to debug.

B7. Prefer composition over inheritance. Use flat functions, explicit data flow, and small collaborators before classes, managers, or hierarchies.

B8. Give each file, function, and module one clear reason to change. If a unit changes for unrelated reasons, split by responsibility.

B9. Fail fast and fail loud. Validate early, preserve failure state, and report actionable errors instead of silently coercing data.

B10. Validate external inputs at boundaries with the repo's contract layer or Zod when introduced deliberately. Do not let loose maps, free strings, or untrusted payloads leak into domain logic.

B11. User-facing errors should explain the next useful action, not just name the failure.

B12. No scope creep. Finish the requested behavior and adjacent safety checks before inventing new surfaces.

## Core Principles

### Requirements Before Solutions

Start with what the system must do and how accurate, available, fast, or maintainable it must be. Do not jump to a library, abstraction, or UI pattern before naming the requirement it serves.

For this repo, the most important requirements are:

- Financial figures must reconcile to canonical data sources.
- UI should make profit and cost structure easy to understand.
- Server payloads should be stable, explicit, and testable.
- Mobile and desktop layouts must not clip or overlap key numbers.

### One Concept, One Place

Every business concept should have one canonical owner:

- Metric definitions belong in server/domain, server/services, or transforms.
- API response shape belongs in contracts.
- UI rendering belongs in `public/live/pages/*` and `public/style.css`.
- Presentation-only formatting can live client-side.

Avoid redefining the same metric in multiple chart modules. If a number appears in more than one view, ensure both views read the same server-owned value or the same shared transform.

### Server Owns Financial Calculations

Financial calculations should be server-side or shared pure domain logic:

- Gross revenue, refunds, net revenue, COGS, shipping, payment fees, ad spend KRW, true net profit, margin, ROAS, coverage, refund rate, and category revenue allocation should be computed before rendering whenever possible.
- Client-side recalculation is acceptable only for local what-if presentation controls, such as a payment-fee input, and must be visually scoped to that control.
- If the client recalculates, it must start from server-provided canonical fields and preserve obvious failure states such as zero denominators.

When denominator is zero, render `--`, `N/A`, or an explicit unavailable state. Do not render `0.0%` unless the true mathematical value is actually zero.

### Canonical vs Derived State

Classify data before storing or transforming it:

- Canonical state: source records that cannot be reconstructed if lost, such as Imweb orders, Meta spend rows, and Google Sheets COGS rows.
- Derived state: summaries, margins, rates, chart rows, coverage labels, Sankey nodes, and UI badges.
- Workflow state: sync state, loading state, selected date range, selected granularity.

Derived state should be recomputable from canonical state. If a cache or projection is introduced, label it as such and keep it rebuildable.

### Policy vs Mechanism

Keep decision rules separate from plumbing:

- Policy: what counts as recognized revenue, how cost coverage is classified, how category revenue is allocated, which denominator makes a rate valid.
- Mechanism: fetching files, calling APIs, rendering DOM, drawing charts, starting the server.

Do not bury business rules inside event handlers, chart callbacks, or DOM manipulation code.

### Stability at the Center, Variation at the Edges

Keep stable business meaning in the center and unstable UI choices at the edges:

- Domain rules and contracts should change carefully.
- Chart type, labels, spacing, and layout can change more often.
- External vendor response shapes should be normalized once near the boundary.

Every layer should transform once. Do not make each chart compensate differently for the same backend inconsistency.

## Code Shape Rules

C1. Name functions after the concept they accomplish, not the algorithm they use.

C2. Keep all work inside a function at one level of abstraction. Split complex functions into intention-revealing helpers when it makes the main path easier to read.

C3. Design around data flow and receiver decisions before inventing nouns, classes, managers, or framework-like structure.

C4. Use guard clauses for edge cases so the main path stays flat.

C5. Separate queries from commands. Questions return values; commands mutate state or perform side effects.

C6. Use explaining variables for complex expressions and replace magic literals with named constants.

C7. Hide mutable collections behind controlled accessors or owner functions when callers should not mutate them directly.

C8. Keep comments for why, tradeoffs, and invariants. Delete comments that merely restate code.

C9. Prefer reshaping data or control flow so a special case becomes the normal path. If a one-off branch remains, name the invariant that earns it.

C10. Add an abstraction only when it removes real duplication, lowers meaningful complexity, or clarifies a stable boundary.

C11. Prefer pure, directly testable owner functions when practical. If a small behavior requires broad route setup, heavy mocks, or large fixtures to test, policy is probably mixed with mechanism.

C12. Role names beat type names. Name variables for what they mean in the workflow, not just what data type they hold.

C13. Return interesting values only. Do not return data just to make a command look chainable.

C14. Provide useful developer debug representations, logs, or assertions where they shorten diagnosis. Keep developer diagnostics separate from user-facing display.

C15. Adopt patterns incrementally as refactoring tools when friction appears, not as ceremony upfront.

## Representation Rules

R1. Make illegal states unrepresentable when the type system, schema, or contract layer can carry the rule.

R2. Prefer discriminated unions, closed enums, branded IDs, required fields, exact schemas, and explicit registries over optional-field bags, free strings, and loose maps.

R3. Model lifecycles as explicit states plus legal transitions instead of scattered booleans that consumers must reconcile.

R4. Keep required facts required at the owner. Do not force consumers to recover missing required state from sibling fields, defaults, labels, or timing assumptions.

R5. If two fields can contradict each other, the shape is wrong. Split the concept, derive one field, or move the rule to the canonical owner.

R6. Keep reality, storage, transport, runtime request, and presentation distinct. A DB row, API DTO, vendor fact, domain object, and view model are not the same contract unless an owner doc says so.

R7. Do not encode domain meaning in UI labels, route-local strings, or test fixtures. Put stable meaning in the shared schema, enum, registry, contract, or owner module.

## State, Invariants, and Trust

Think in state transitions, not just functions. For any workflow, identify:

- What states exist?
- What transitions are allowed?
- Who or what triggers each transition?
- What invariants must always hold?
- What happens on retry, duplicate input, missing data, or stale data?

Important AdPilot invariants:

- Gross revenue minus refunds equals net revenue.
- True net profit equals net revenue minus COGS, shipping, payment fees, and ad spend KRW.
- Category revenue breakdowns must sum back to the gross revenue window they describe.
- Coverage notes must be scoped to the same time frame as the chart or explicitly labeled as all-time.
- Zero-revenue windows must not show fake percentage metrics.
- Derived chart state must not become a second source of truth.

Add tests for these invariants when touching the relevant code.

## Entropy Control

Prefer deletion and consolidation over new surfaces.

Use these checks during cleanup:

- If removing code does not change business guarantees, delete it.
- If adding one concept requires touching many files, the concept is scattered.
- If the same condition appears in many places, centralize it.
- If a helper has one caller and no domain meaning, consider co-locating instead.
- If a UI section duplicates another section's job, consolidate the better version and remove the weaker one.
- If a name has drifted, grep for the old name across code, tests, docs, comments, and strings.

Avoid abstraction sprawl: no one-off adapters, wrappers, registries, or tiny helper files unless they reduce real duplication or encode a real domain rule.

## Code Quality Rubric

Use these as review and refactoring prompts, not as ceremony:

- Composed method: divide functions into sub-functions that each perform one identifiable task at the same abstraction level.
- Intention-revealing names: name functions after what they accomplish.
- Replace comments with clear code where possible; keep comments for why.
- Constructor or factory clarity: create well-formed objects with required parameters upfront.
- Single responsibility: each method, file, and module has one reason to change.
- Say things once: one piece of knowledge or logic should have one canonical owner.
- Behavior over state: get public behavior right and keep internal representation hidden.
- Guard clauses over deep nesting.
- Query methods return; command methods mutate.
- Explaining variables and role-suggesting names.
- Use polymorphism, registries, or lookup tables instead of repeated branching when the same conditional appears across multiple files.
- Delegate rather than inherit; use collaborators over deep class trees.
- Extract complex calculations into focused owner functions or method objects only when it improves testability and reading flow.
- Execute-around helpers are appropriate for paired setup and teardown that callers must not forget.
- Explicit initialization before mutation-by-convention; lazy initialization only for expensive work that may not be needed.
- Named constants over magic literals.
- Controlled field and collection access when mutation needs validation or hooks.
- Equality and hashing must be based on the same fields when both exist.
- Make repeated object-to-object protocols explicit and consistent.
- Use double dispatch only when behavior truly depends on two collaborating types.
- Use pluggable behavior for narrow variation; avoid subclass explosions.
- Collecting parameters are acceptable when multiple helpers contribute to one output.
- Convenience methods are justified when they make message flow easier to read left to right.
- Add patterns only after friction appears and the pattern reduces that friction.

## Frontend Standards

The frontend should be a thin, readable projection of server data.

- Use stable dimensions and responsive constraints for charts, grids, cards, and controls.
- Check desktop and mobile widths for clipping, overlap, and awkward unused space.
- Do not let labels, values, legends, or tooltips obscure the chart.
- Use colors consistently: positive revenue/profit in green families, costs/refunds/losses in red families, neutral metadata muted.
- Avoid duplicate charts or tables that answer the same question.
- Prefer clear chart structure over decorative polish.

For calendar and financial charts:

- Tooltips should include the actual figures users need to audit the view.
- Legends should match visual encodings: line series should look like lines, bars like filled swatches.
- Time-frame toggles must scope the data, labels, footnotes, and coverage notes together.
- Mobile calendar cells must wrap or scale compact values rather than clipping them.

## Testing And Verification

Run tests at the right level for the risk:

- Pure domain math: unit tests.
- API response shape: contract/static tests.
- Chart and layout regressions: focused DOM/static tests plus browser verification when useful.
- Financial correctness: invariant tests that reconcile totals.

Before finishing a meaningful change, prefer:

- `node --check` on touched JS files.
- Targeted tests for new behavior.
- `npm test`.
- `npm run lint`.
- `git diff --check`.

If a test or tool mutates generated data or snapshots, restore unrelated noise before finalizing.

## Review Prompts

Use these prompts when reviewing code in this repo:

1. Principles and red flags:
   Review for high cohesion, low coupling, small surface area, low entropy, clear ownership, single source of truth, explicit invariants, predictable state transitions, and easy-to-audit control flow. Flag anything over-engineered, duplicated, ambiguous, or hard to reason about.

2. Financial correctness:
   Verify every displayed financial figure traces to a canonical source or a tested server/domain transform. Check denominators, time-frame scoping, category allocations, COGS coverage, and refund handling.

3. Anti-sprawl:
   Identify unnecessary helpers, adapters, wrappers, tiny one-off modules, duplicate views, and public surfaces that add ceremony without reducing bugs or change amplification.

4. UI robustness:
   Check desktop and mobile layouts for clipping, overlap, misleading legends, hidden tooltips, awkward whitespace, and duplicate sections.

5. Post-migration cleanup:
   Search for stale terminology, deleted-file references, outdated instructions, old bot names, and partial rename leftovers. Close migrations fully.

6. Periodic structural health:
   Ask: where does this knowledge live, what does it take to add a new one, who is the single authority, can the backend survive without the UI, how many type-check branches exist, and what if another actor needs to do this?
