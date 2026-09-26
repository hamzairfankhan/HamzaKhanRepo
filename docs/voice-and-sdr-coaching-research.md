# graph8 voice agents and SDR training: what exists, where the gaps are, what to build

Research date: 26 Sep 2026. Sources: `@graph8/sdk` v0.245.0 endpoint registry (3,229 operations, installed locally), the graph8 MCP tool catalogue (586 tools; descriptions only, no data was read), graph8's public pages via search summaries (graph8.com itself is blocked from this container), the hackathon brief, and competitor material (Nooks, Hyperbound, Second Nature).

Confidence markers used below:
- **[API]** verified in the SDK registry or tool schema. It exists and is callable.
- **[site]** a graph8 marketing claim. Real, but the mechanism may live in the desktop app, not the API.
- **[hub]** graph8's internal ops tooling (CustomerHub MCP), not customer-facing.

---

## 1. What graph8 does today

### 1.1 Voice agents (`/voice/agents`, `/voice/twins`) [API]

An agent is a persona with: a `role` (SDR, AE, Receptionist, CSM), free-text `persona`, three 0–1 dials (`formality`, `conciseness`, `assertiveness`), separate `inbound_instructions` and `outbound_instructions`, an `outbound_voicemail_prompt`, a company-name pronunciation override, a caller-ID `phone`, a `voice` (Cartesia id or OpenAI voice), a `calendar_event_id` so it can book meetings on the call, up to 4 knowledge collections plus the org knowledge base, and optional MCP servers and "skills" (attachable actions). Agents can be cloned, saved as templates, and carry per-agent `memory` and an activity log.

`entity_type` is `agent` or `twin`. A twin is an agent seeded from a real person: `POST /voice/twins` (billable), `extract-linkedin` to pull the person's profile, twin files, and voice cloning via `/voice/voice-library/voices`. The site says twins are "trained on their deals, their writing style, and their voice", drop voicemails in the rep's cloned voice, and can "run discovery, qualification, or follow-up calls under supervised mode" [site].

Agent testing exists but is shallow: `test-cases` with assertion types `exact | contains | not_contains | expects_tool | refuses | cites_collection | llm_judge`, per channel `chat | inbound | outbound`, `run-all`, and `test-suite-status`. The SDK comment is explicit: **a run "never calls a model, never places a call"**. It only resolves what instructions and tools the agent *would* receive. `llm_judge` cases "may be SAVED but are skipped by dry runs." So there is no way today to evaluate how an agent actually converses before it talks to a prospect.

Supporting generators, all billable: `call-scripts/generate` (per contact, uses the agent's persona and memory; call types cold_call, follow_up, demo, closing), `campaigns/voicemails` (personalised voicemail), research endpoints (company, prospect profile, org chart, competitors, FAQ), `topics/classify`.

One-off AI call: `POST /voice/calls` dials any number now with a chosen agent or twin, with `dry_run`, `callback_url`, `event_id` for booking, and idempotency. Also `sequencer/content/voice/test-call`.

Inbound: receptionist agent, routing rules, business hours, phone directory, transfer to departments, missed-callback list, voicemail inbox, numbers with an assigned `answering-agent`.

### 1.2 Dialer (`/dialer/*`, `/voice/dialer/*`) [API]

Parallel and power dialing from a contact list; API resumes dial up to 4 at a time, the desktop client advertises 4–8 lines with sub-200 ms connect [site]. Per-SDR preferences: `parallel_count`, `skip_voicemails`, `auto_rotate_numbers`, `call_dnc_contacts`. Session controls: pause, resume, stop, skip/unskip contact, redial, hangup, mute, transfer, drop voicemail, prewarm voicemails, per-session booking event type, queue stats.

Dispositions: a fixed system set where each carries `is_connected`, plus up to 10 custom outcomes per org. A disposition write accepts `sentiment`, `notes`, `callback_at`.

Every call produces: transcript segments (`speaker`, `content`, `timestamp`), summary, recording, and **AI grading** (`GET /voice/dialer/calls/{room}/grading`, async, `pending` then `ready`, a manager can `markGradingReviewed`). Grading payload is an untyped dict in the SDK. There is `grading/search` with a closed `grading_bucket` of `high | med | low`, `grading/backfill` (billable) and `grading/campaign-readiness`.

Analytics: performance, quality, quality leaderboard, per-SDR detail, dialer report (dials, connection rate, talk time, dispositions, peak hour, redial success rate, callbacks), agency-level rollups, a voice-AI agent leaderboard and voice-AI graded-call search, and `/analytics/sdr/ai-agents/summary`.

Workflows: node types `create_dialer_session` and `update_call_disposition`; trigger events `new_call_ended`, `new_voicemail_detected`, `new_inbound_call`; disposition filters. Call outcomes can drive Slack, Roam, SMS, email, list moves and sequence changes.

Live coaching: "whisper-mode AI coach in the rep's ear", real-time grading, talk-track suggestions, objection coaching [site]. Nothing in the API; this is desktop-side.

### 1.3 Sales Coach (`/sales-coach/*`) [API]: the actual SDR training product

- **Practice calls.** `POST /sales-coach/calls` with `call_mode` `compete` ("the rep alone against the AI prospect") or `assisted` ("the coached variant"), `persona_type`, `prospect_name`, `prospect_company`. A call record stores `audio_url`, transcript, `duration_ms`, `call_status`, `final_score`. The AI prospect can be a real contact: `sales-coach/prospects/search` and `contact-lists`.
- **Interview rounds.** `POST /sales-coach/interviews`: "a scripted practice call a candidate is invited to." Fields: `audience_id`, `prospect_id` (the contact the AI plays), free-form `behavior`, `max_attempts`, `code_ttl_days` (default 14), members invited by email with a code, attempts recorded by code. This is the marketplace's hiring assessment: "a structured AI interview scored across 12 dimensions, hands-on platform certification, reference verification", tiers earned by performance [site].
- **Team layer.** Roles, sets, a `kpi-catalog`, leaderboards with weighted KPIs and a goal (`metric`, `period`, `target`), active-users summary.
- **Blog claims [site].** The AI persona "throws curveballs like 'I'm not interested', 'Call me next quarter'"; after a session the AI gives feedback on "filler words, key points missed, how well the rep articulated value"; "if graph8's AI agents encounter objections in the wild, those get fed back into the training module"; ramp time claims of 60 percent and "half the time".

### 1.4 Meeting coaching (`/meeting-transcripts`) [API]

Transcripts have a `coaching-queue`, an AI `review` (generate, regenerate, acknowledge), a follow-up draft, and stats. Meeting analysis fields: `sentiment`, `summary`, `next_steps`, `objections`, `talk_listen_ratio`. The site frames this as "a 20-minute coaching queue instead of a quarterly scramble."

### 1.5 Desk: the rep's daily cockpit (`/desk/*`) [API]

`kickoff` and `kickoff/audio` (a spoken daily brief, billable), `voice-memo` (rep dictates, desk acts), `next-best`, `pulse`, `wrapped`, `home-summary`, `email-score` and `email-improve`, decisions with a per-decision `brief` and `call-target`, plays behind approvals, and an org `autonomy` setting.

### 1.6 graph8's own SDR operation [hub]

Internally graph8 runs a weekly SDR grading engine: per-account element scores A1..C3, a composite, a letter grade, coaching flags and gates; a canonical dial/connect activity table; a `quizPassed` flag per SDR; and Roam-recorded "Shadow" sessions where a forward-deployed engineer shadows a rep. This is how graph8 coaches the marketplace SDRs it places. It is not exposed to customers.

---

## 2. Where it breaks, from the user's chair

**SDR manager, six reps, no time.** Every call is graded, but grading is a `high | med | low` bucket over an opaque dict. The manager can search graded calls, but nothing tells them *which three calls to listen to today* or *which one behaviour to coach this rep on this week*. The meeting side has a coaching queue; the cold-call side, where 95 percent of the volume is, does not.

**SDR in week two.** Practice calls exist, but the persona is `persona_type` plus a free-text `behavior`. The blog promises that objections met "in the wild" feed the training module. The API has no such link: no objection library, no scenario built from a real transcript, no way to say "practise the call you lost at 2:14 pm." Practice and real calls are also scored on different scales (`final_score` versus the dialer grading dict), so nobody can show a rep that practice moved their real numbers.

**Team deploying a twin or an AI SDR agent.** The test suite never places a call or invokes a model. A twin goes to real prospects "under supervised mode" with zero conversational evaluation. An agent persona edit (a new objection response, a new knowledge collection) cannot be regression-tested against a hard buyer before it ships. `campaign-readiness` exists, but it reads human-call grading; it does not exercise the agent.

**Rep adoption.** The 2026 coaching literature is consistent: 47-metric scorecards kill adoption, scores used as surveillance make reps game the system, and one skill per 1:1 is what works. graph8's grading is org-visible and manager-facing by default. There is no rep-owned, private practice loop.

**Competitive frame.** Nooks and Hyperbound both sell roleplay bots plus real-call scoring, and Nooks feeds real calls back into scenarios. graph8's edge is that it *also* runs the AI voice agents and twins, the CRM, the sequences and the buyer graph. The distinctive feature is one that trains the human and the twin with the same machinery and grades both on the same rubric, then acts on the result inside the platform. Nobody in the roleplay market does agent-on-agent evaluation.

---

## 3. Candidate features, scored

Scale 1–5. Effort is for a team of three in the remaining hackathon time.

| # | Feature | User value | Novelty vs Nooks/Hyperbound | Platform depth | Demo risk | Effort |
|---|---|---|---|---|---|---|
| A | **Replay the call you lost.** Turn yesterday's low-graded real calls into practice scenarios; the AI prospect calls the rep back and opens with the exact objection; re-grade on the same rubric; track whether that objection converts better next week. | 5 | 4 | 5 | 3 | 3 |
| B | **Sparring for AI agents.** An adversarial buyer agent phones the org's SDR agent or twin through N scenarios (gatekeeper, "send me an email", competitor, pricing, compliance trap); grade the transcripts; block launch below a readiness bar; re-run on every persona edit. | 4 | 5 | 5 | 3 | 3 |
| C | **Daily cold-call coaching queue.** Pick the three calls worth 20 minutes (connected, long, low grade, or booked exemplars), timestamp the moments, draft feedback, one skill per rep, push to Slack or Roam via workflow. | 4 | 2 | 4 | 1 | 2 |
| D | **Outcome-linked rubric.** Correlate grading elements with `booked` dispositions across the org; show which behaviours predict meetings; reweight coaching focus per campaign. | 4 | 3 | 3 | 2 | 3 |
| E | **Certification gate.** Rep must pass an interview round (scenario set) before a campaign's dialer session unlocks. | 3 | 2 | 4 | 2 | 2 |
| F | **Twin shadow score.** After each real call, ask the rep's twin what it would have said at key turns; diff; feed the delta into twin memory. | 3 | 4 | 4 | 4 | 4 |
| G | Voicemail-to-callback automation | 2 | 1 | 3 | 1 | 1 |

Rethinking, in order:

- My first instinct was **C** because it is safe and clearly useful. I dropped it as the headline: it is a better version of a queue graph8 already has for meetings, judges will read it as incremental, and Nooks ships the same thing.
- **A** alone is graph8's own stated vision made real, and it is the feature a rep would actually want. Its weakness is the demo: a human has to take a live call on stage and the practice-call audio path in the API is thin (`/sales-coach/calls` stores a record; the conversation happens in the desktop app).
- **B** alone is the most novel and fully autonomous, needs no human on stage, and graph8 needs it badly for the twins it deploys "supervised". Its weakness is product-market framing: "QA for voice agents" sounds narrow to a sales judge.
- The decision: **A and B are the same machine.** One adversarial buyer agent, built from real lost calls, with two trainees: the rep and the twin. Same scenario generator, same grader, same readiness scorecard. Build the engine once, demo it twice: first the agent sparring (no human, autonomous, always works), then the rep replay (the emotional moment). C becomes the delivery surface, not the product. D is the stretch goal that makes the rubric honest. E and F are roadmap.

---

## 4. The plan: adversarial buyer gym, on graph8

### 4.1 One-paragraph pitch

Every graded cold call in graph8 becomes a training scenario. A buyer agent, built from the real contact, the real company and the real objection, calls the trainee back. The trainee is either the rep who lost the call or the org's AI SDR agent or twin. The call flows through the same dialer transcript and grading pipeline as production calls, so practice and real scores are on one scale. A readiness scorecard tells the manager which rep to coach on which one skill, and blocks an AI agent from a campaign until it survives the hard buyers. The next week's real calls close the loop by showing whether that objection now converts.

### 4.2 Data flow

```
graded real calls ──► scenario miner ──► buyer agent (persona + opener + behavior)
 (grading/search      (Claude: locate       (voice upsert_agent, entity=agent,
  bucket=low,          the turn it broke,    role=Buyer, knowledge=company research)
  transcript)          extract objection,
                       classify)                    │
                                                    ▼
                                      ┌─────────── sparring call ───────────┐
                                      │ to_phone = rep's mobile  (mode A)   │
                                      │ to_phone = agent number  (mode B)   │
                                      │ POST /voice/calls, callback_url     │
                                      └─────────────────────────────────────┘
                                                    │ room_name
                                                    ▼
                     transcript + grading (same endpoints as production)
                                                    │
                                                    ▼
        scorecard ──► one-skill coaching note ──► Slack/Roam via workflow
                 └──► readiness gate for agents (pass/fail per scenario set)
                 └──► next-cycle measurement: same objection, real calls, disposition
```

### 4.3 graph8 surface used (all verified in SDK v0.245.0)

| Stage | Operation | Tier |
|---|---|---|
| Mine | `POST /analytics/dialer/grading/search` (`grading_bucket: low`), `GET /voice/dialer/calls/{room}/transcript`, `GET .../grading`, `GET /voice/dialer/calls?user_email=` | read |
| Ground | `POST /voice/research/company`, `POST /voice/research/prospect-profile`, `GET /voice/topics/classify` | billable |
| Build buyer | `POST /voice/agents` (or `g8_voice_upsert_agent`) role `Buyer`, dials assertive/low-formality, `outbound_instructions` = scenario script; `POST /voice/agents/{id}/save-as-template` per objection class | write |
| Call | `POST /voice/calls` with `dry_run` first, `callback_url` to our webhook, `contact_id` for context | external, billable |
| Grade | same transcript and grading endpoints; `POST .../grading/review` to mark reviewed | read/write |
| Practice ledger | `POST /sales-coach/calls` (`compete` or `assisted`), `PUT /sales-coach/calls/{id}` with `final_score`, `audio_url`, `duration_ms` | write |
| Certify | `POST /sales-coach/interviews` (scenario set as an interview round), members and attempts | write, external for invites |
| Coach delivery | workflow with `send_slack_notification` / `send_roam_notification`; trigger on `new_call_ended` | write |
| Agent gate | `GET /voice/agents/{id}/test-suite-status` plus our readiness result; `POST /voice/agents/{id}/test-cases` to persist each scenario as an `llm_judge` case for the record | read/write |
| Measure | `GET /analytics/dialer/leaderboard/sdr/{email}`, `GET /voice/dialer/stats`, dispositions per contact | read |

Tier metadata comes from `g8.api.operation(id).tier`, the same source Campaign Autopilot already uses, so the approval policy carries over: reads and writes auto-run, `external` (a real phone rings) always waits for a click.

### 4.4 Scenario mining rubric (the part Claude does)

Input: transcript segments, grading dict, disposition, contact and company. Output, zod-validated:

- `break_turn`: the segment index where the call was lost, with the quote.
- `objection_class`: closed set. `not_interested | timing | already_have_vendor | send_email | no_budget | not_decision_maker | gatekeeper | compliance_or_dnc | hostile | technical_question`.
- `buyer_profile`: title, seniority, mood, patience 0–1, verbosity 0–1, what would actually move them.
- `opener`: the exact first line the buyer agent says when the trainee picks up.
- `success_criteria`: 2–3 observable behaviours, each mapped to a grading element so the score is comparable.
- `one_skill`: the single behaviour to coach, in one sentence, written to the rep, not about the rep.

Adoption rules baked in: a rep's practice scores are private to the rep until they share; the manager sees trend and one-skill, not raw transcripts; no scenario is ever labelled with the rep's name in team views.

### 4.5 Agent sparring set (mode B)

Ten scenarios per agent, three difficulties each. Pass bar: median grade in `high` on easy, no `low` on medium, no compliance failure on hard. Compliance failures are hard fails: agent keeps talking after "take me off your list", claims a false identity, promises pricing it has no knowledge for, books a meeting without confirming a time. Each run is persisted as an `llm_judge` test case on the agent so the history lives in graph8, not only in our app. Re-run automatically when the persona or knowledge collections change (poll `updated_at` or diff config on each cycle).

### 4.6 Build order

Half day 1 (remaining today): verify the ten assumptions in section 5 against the hamzairfankhan5 workspace; mine 5 real or seeded low-grade calls into scenarios; stand up the webhook receiver; create two buyer agent templates.

Day 2 morning: mode B end to end with `dry_run`, then one real agent-to-agent call; grading polled to `ready`; scorecard rendered; readiness gate on one SDR agent.

Day 2 afternoon: mode A with one team member's phone; sales-coach ledger write; Slack delivery through a workflow; the measurement view (objection class, before and after, Wilson interval, reuse `src/evaluate.ts`).

Code freeze buffer: recorded fallback of both calls, seeded scorecards labelled SIMULATED, one-paragraph submission text.

### 4.7 Demo script (7 minutes)

1. Show the org's SDR agent about to be attached to a campaign. Click "spar". Buyer agent dials it. Live transcript scrolls. Grade arrives. It fails "already_have_vendor" hard. Gate blocks the campaign. Fix the persona in one line, re-spar, it passes. No human spoke.
2. Pull up a rep's real call from yesterday, graded low. Show the mined scenario and the opener. The presenter's phone rings. The buyer opens with the exact objection. Thirty seconds of live handling. Hang up. Grade lands. One-skill note appears in Slack.
3. The measurement panel: the same objection class across the rep's last 40 real calls, before and after, with the interval. Say out loud that the interval is wide because the sample is small. Judges trust honesty more than a green arrow.

### 4.8 Risks and fallbacks

- **Agent-to-agent call may not connect** (the inbound number must route to an answering agent). Verify first. Fallback: mode B calls a team member who reads the agent's script; still fully graded.
- **Grading latency.** Async and unbounded. Poll at 10 s with a 3-minute demo cap; fall back to our own Claude grade using the same rubric, clearly labelled.
- **Grading dict shape unknown.** Read one real payload on day 1 and type it defensively; never depend on a specific key for the demo path.
- **Credits and consent.** Every `external` call is a click behind `dry_run`. Only call phones the team owns. Never dial a real prospect in the demo.
- **Hackathon rule: fresh code.** This is new code. It can live in this repo as a sibling module to Campaign Autopilot (shared `src/g8/client.ts`, ledger and evaluate helpers) or as a fresh repo. Sharing helpers is fine; the product code is new.

---

## 5. Verify first in the hamzairfankhan5 workspace

Ten checks, all read-only except 8 and 9 which use `dry_run`:

1. `GET /voice/dialer/numbers`: at least one dialer-eligible number; note `connect_rate_7d`.
2. `GET /voice/numbers` with `answering-agent`: can a number be answered by an agent (needed for mode B).
3. `GET /voice/agents` full list: any SDR agent or twin exists; read one in full to see persona and knowledge shape.
4. `POST /analytics/dialer/grading/search` bucket `low`: are there graded calls at all? If none, seed from reference and label SIMULATED.
5. `GET /voice/dialer/calls/{room}/grading` on one call: capture the real grading dict shape.
6. `GET /sales-coach/team/kpi-catalog` and `/sales-coach/team/bootstrap`: is Sales Coach enabled for the org.
7. `GET /voice/agents/{id}/test-cases`: confirm `llm_judge` cases can be saved.
8. `POST /voice/calls` with `dry_run: true`: subscription, concurrency cap and caller-ID ownership pass.
9. `POST /sales-coach/calls` shape: confirm `compete` and `assisted` accepted, and whether `audio_url` can point at the dialer recording.
10. Workflow: `new_call_ended` trigger available and a Slack channel connected.

Blocked until the connector or `G8_API_KEY` for hamzairfankhan5 is in place. Everything in section 1 marked [API] was read from the SDK and does not depend on the workspace.

---

## 6. Sources

graph8 pages (via search summaries): [AI dialer](https://graph8.com/dialer/), [Voice AI on-device](https://graph8.com/platform/desktop/voice-ai/), [AI platform and twins](https://graph8.com/platform/ai/), [AI SDR agent](https://graph8.com/platform/ai/sdr-agent/), [Why your next SDR will be trained by an AI coach](https://graph8.com/blog/why-your-next-sdr-will-be-trained-by-an-ai-coach/), [Marketplace](https://graph8.com/marketplace/), [1,000 SDR applications](https://graph8.com/blog/1000-sdr-applications/), [Midmarket](https://graph8.com/midmarket/), [Screen-aware AI](https://graph8.com/platform/desktop/screen-aware-ai/), [Voice AI receptionist changelog](https://changelog.graph8.com/p/voice-ai-receptionist). Hackathon brief: [hamzanajeeb1/graph8-hackathon](https://github.com/hamzanajeeb1/graph8-hackathon). Competitors and coaching research: [Nooks roleplay comparison](https://www.nooks.ai/blog-posts/5-best-ai-roleplay-tools-for-sales-training-2026-comparison), [Nooks manager coaching stack](https://www.nooks.ai/blog-posts/ai-roleplay-bots-real-time-scoring-the-new-power-stack-for-sdr-manager-coaching), [Hyperbound AI roleplay for SDRs](https://www.hyperbound.ai/blog/ai-roleplay-sdrs-meetings), [MarketBetter coaching software 2026](https://marketbetter.ai/blog/best-sales-coaching-software-2026/), [Salesfinity SDR manager AI coaching guide](https://salesfinity.ai/blog/the-sdr-manager-s-guide-to-ai-powered-coaching-2026), [Trellus roleplay tools](https://www.trellus.ai/post/ai-sales-role-play-tools).
