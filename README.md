# Campaign Autopilot

**A closed-loop agent for graph8 outbound campaigns: it grades every campaign, explains why each one under-performs, proposes specific changes with evidence, applies them after a human (or policy) says yes, and measures whether the change worked so the next cycle is smarter than the last.**

Built for the graph8 Programmable Revenue Hackathon, Lahore, 26–27 September 2026, on `@graph8/sdk` and the Anthropic SDK.

## The problem

A campaign manager on Monday morning has three disconnected things: a metrics dashboard, the copy that is actually going out, and an inbox full of replies. Nobody closes the loop between them. In a real graph8 workspace we looked at while designing this:

- 35 of 100 campaigns were marked *active*; four of six we sampled had **no sequence attached**, so "active" did not mean "sending".
- The largest campaign had sent ~21,000 emails for 17 replies (0.08%) with 436 bounces, and the analytics rollup lagged the send receipts by ~4,000 sends.
- A raw reply count hides quality: 17 replies could be 15 unsubscribes. Only reading the inbox tells you.

graph8 already exposes every ingredient (per-step metrics, sequence copy documents, inbox threads, deliverability health, brand and messaging docs). Campaign Autopilot ties them into one loop.

## How it works

```
collect ──► evaluate ──► analyze ──► propose ──► approve ──► apply ──► measure ──► learn
 (SDK)      (rules)      (Claude)    (typed)    (human /     (SDK,     (before/    (feeds next
                                                 policy)     tiered)    after)      cycle)
```

| Stage | What | Why it is built this way |
|---|---|---|
| **collect** | Snapshot every campaign: metrics + reconciliation, full campaign (documents incl. email copy, sequence, step catalog), per-step email metrics, inbox replies, deliverability. Written to `data/snapshots/<ts>/`. | Every later stage reads from disk, so every grade and proposal is reproducible and traceable to its inputs. |
| **evaluate** | Deterministic grade A–F plus flags (`no_sequence`, `high_bounce`, `low_reply`, `poor_reply_quality`, `stale`, `metrics_lag`, `deliverability_risk`, `dead_step`, `low_volume`). Each flag stores the numbers and thresholds that fired it. Reply rate uses a Wilson 95% interval so small samples are not over-read. | Arithmetic should be cheap, testable and explainable. The LLM is reserved for judgment. |
| **analyze** | Claude Opus 5 reads the evaluation, the actual email copy, the sequence structure, per-step metrics and up to 30 replies, grounded in the org's brand/compliance/messaging/persona docs. Returns a zod-validated object: reply classifications, a diagnosis, and up to 5 proposals with `before`/`after`, evidence, expected metric and confidence. | Structured output makes proposals machine-applicable and gradable. The schema rejects a proposal without evidence. |
| **approve** | Dashboard or CLI. In `tiered` autopilot mode, proposals whose graph8 operation is `read`/`write` tier and confidence ≥ 0.8 auto-approve; `external` (prospect-facing) and `destructive` always wait for a human. | The tier comes from graph8's own published operation metadata (`g8.api.operation(id).tier`), not from a guess. |
| **apply** | Only `approved` proposals; dry-run shows the exact operation, path and payload; each application records the call, the result and a metrics baseline. | Nothing reaches a prospect without a decision and an audit trail. |
| **measure** | On later cycles, compares the marginal rate since the change (with its interval) to the baseline and records `improved` / `no_change` / `worse` / `insufficient_data`. | "Improves over time" has to be demonstrated, not claimed. |
| **learn** | Outcomes become one-line learnings injected into the next analysis prompt. | The ledger is the memory that makes cycle N+1 better than cycle N. |

### graph8 surface used

`gtmCampaigns.listCampaigns / getCampaignFull / getCampaignMetrics / updateCampaignDocument / updateCampaignStep`, `analytics.getEmailByStep`, `inbox.listInbox`, `deliverability.getSafeToSend / listDegradedMailboxes / getSequencesHealth`, `sequences.pauseSequence`, `gtmContext` documents, all through the SDK's generated `g8.api` client (base URL `https://be.graph8.com/api/v1`).

## Setup

```bash
# macOS one-shot (Homebrew, git, gh, node, Claude Code, GitHub login, clone, npm install)
bash scripts/mac_setup.sh

# or manually
npm install
cp .env.example .env    # add G8_API_KEY (app.graph8.com → Settings → MCP & API → API) and ANTHROPIC_API_KEY
```

## Run

```bash
npm run autopilot -- collect                 # snapshot the workspace (read-only)
npm run autopilot -- evaluate                # grade table with flags
npm run autopilot -- explain "PLG MCP"       # full reasoning chain for one campaign
npm run autopilot -- analyze "PLG MCP"       # Claude: classify replies, diagnose, propose
npm run autopilot -- proposals -v            # see proposals with evidence and before/after
npm run autopilot -- approve prop_xxx        # or reject
npm run autopilot -- apply --dry-run         # exact API call, no change
npm run autopilot -- apply                   # apply approved proposals
npm run autopilot -- measure                 # after a later collect: did it work?
npm run autopilot -- run                     # one full cycle
npm run autopilot -- loop --every 30         # keep running

npm run dashboard                            # http://localhost:3000
```

No demo workspace yet? `npm run autopilot -- seed --from-reference` builds a snapshot from `reference/` (real shapes, real numbers, no key), and `seed --simulate` produces synthetic campaigns labelled **SIMULATED** everywhere they appear.

## Verify

```bash
npm run typecheck && npm test
```

## Layout

```
src/config.ts      thresholds and env             src/analyze.ts   Claude stage, zod schemas
src/g8/client.ts   typed wrappers over g8.api      src/ledger.ts    proposals, decisions, outcomes, learnings
src/collect.ts     workspace snapshot              src/apply.ts     tier-gated, approved-only, dry-run
src/evaluate.ts    deterministic grades and flags  src/measure.ts   before/after with intervals
src/context.ts     org GTM context for the prompt  src/cli.ts       every stage as a command
src/seed.ts        reference / simulated data      src/server.ts + web/index.html   dashboard
reference/         read-only reference pull        tests/           evaluate, ledger, apply, measure
```

## Demo (5 minutes)

1. Grade table: an F (active but no sequence), a D (0.08% reply on 21k sends).
2. Explain the D: flags with numbers, reply classes, diagnosis citing the copy and a brand rule.
3. Proposals: before/after diff, evidence, confidence, tier badge. Approve one, reject one.
4. Dry-run shows the exact SDK call; apply; the document changes in graph8.
5. Ledger: an earlier change with its measured outcome and the learning now in the prompt.
6. `autopilot loop --every 30` is what runs on Monday.
