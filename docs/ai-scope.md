# AdPilot AI Scope

## Core Objective

AdPilot maximizes true contribution profit by deciding when to:

- give Meta more budget
- constrain Meta with guardrails
- improve the inputs Meta is working with
- leave delivery alone

Meta owns auction-level delivery. AdPilot owns business judgment.

## What AdPilot Owns

- Campaign-level budget direction: scale, reduce, hard stop-loss
- Portfolio guidance: reallocation advisories and account-level profit guardrails
- Measurement trust: freeze budget changes when revenue, COGS, or coverage quality is too weak
- Creative input pressure: tell the operator when Meta needs stronger creative supply before more budget
- Operator workflow: approvals, hold states, fix-input advisories, cleanup, and audit compression
- Policy rules: explicit budget thresholds, penalties, trust weights, and review windows that stay understandable to the operator

## What AdPilot Does Not Own

- Auction-by-auction delivery
- Bid tuning
- Dayparting / schedule micromanagement
- Audience expansion rules
- Frequent ad-set or ad-level pause / refresh loops
- Ad-set budget automation when campaign budget is the true control surface

## Live Decision Taxonomy

### Executable

- Campaign budget increase
- Campaign budget decrease
- Campaign hard stop-loss pause

### Advisory

- Portfolio reallocation
- Portfolio scale / reduce guardrails
- Freeze due to low measurement trust
- Fix creative inputs
- Hold budget and let Meta continue delivery

## AI Ops Lanes

- `action_now`: fresh executable budget or stop-loss decisions
- `fix_inputs`: measurement trust or creative supply must improve first
- `hold`: explicit no-change states where Meta should keep delivering
- `cleanup`: stale approvals, delivery failures, and audit clutter
- `research`: advisory context that is useful for audit, not action

## Current Simplification

The live product no longer runs an internal policy-lab or shadow-learning loop. Budget policy changes should happen deliberately through explicit rules and operator review, not a hidden replay system.
