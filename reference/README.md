# Reference data (read-only)

Raw JSON pulled on 26 Sep 2026 from a real graph8 workspace via the graph8 MCP server,
kept only as **reference material**: to learn exact response shapes, calibrate evaluator
thresholds, build test fixtures, and ground the analyzer's prompt when the demo workspace
has no GTM context documents of its own.

Per the hackathon rules the build never targets this workspace. `autopilot seed --from-reference`
turns these files into a local snapshot for development; `autopilot collect` runs against the
demo workspace.

- `campaigns_list*.json` – campaign list (2 pages)
- `campaigns/` – one full campaign (documents, sequence, step catalog)
- `metrics/` – campaign metrics for a subset of campaigns
- `context/` – the org's GTM context documents (brand, messaging, audience, offer, market, campaign brief)
- `mailboxes.json`, `workflow_node_types.json` – platform reference
