/**
 * Dashboard + JSON API. One static page (web/index.html) talks to these routes.
 * The server reuses the same functions as the CLI, so what the judges see in the
 * browser is exactly what the terminal does.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { analyzeCampaign, operationForProposal } from "./analyze.js";
import { applyProposal } from "./apply.js";
import { collectWorkspace, latestSnapshotDir, readSnapshot } from "./collect.js";
import { config, REPO_ROOT } from "./config.js";
import { evaluate, gradeRank } from "./evaluate.js";
import { tierOf } from "./g8/client.js";
import { addProposals, autoApprovable, decide, loadLedger, saveLedger, type Proposal, type Tier } from "./ledger.js";
import { measureAll } from "./measure.js";
import { simulatedSnapshot, snapshotFromReference } from "./seed.js";

const app = new Hono();
const log: string[] = [];
const say = (s: string) => {
  log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  if (log.length > 200) log.shift();
  console.log(s);
};

function state() {
  const dir = latestSnapshotDir();
  const ledger = loadLedger();
  if (!dir) return { snapshot: null, campaigns: [], evaluations: [], ledger, log, mode: config.autopilotMode, hasKey: Boolean(config.g8ApiKey) };
  const { index, campaigns } = readSnapshot(dir);
  const evaluations = campaigns.map((c) => evaluate(c)).sort((a, b) => gradeRank[a.grade] - gradeRank[b.grade] || a.name.localeCompare(b.name));
  return {
    snapshot: { dir: path.basename(dir), ...index },
    campaigns: campaigns.map((c) => ({
      id: c.campaign.id,
      name: c.campaign.name,
      status: c.campaign.status,
      goal: c.campaign.goal,
      target_persona: c.campaign.target_persona,
      replies: c.replies.length,
      steps: c.full?.sequence?.steps ?? [],
      step_catalog: c.full?.step_catalog?.steps ?? {},
      documents: (c.full?.documents ?? []).map((d) => ({ id: d.id, file_type: d.file_type, display_name: d.display_name, chars: d.content.length })),
      emails_doc: c.full?.documents.find((d) => d.file_type === "emails")?.content ?? null,
    })),
    evaluations,
    ledger,
    log,
    mode: config.autopilotMode,
    hasKey: Boolean(config.g8ApiKey),
  };
}

function tierFor(type: Proposal["type"]): Tier {
  const { operationId, tierFallback } = operationForProposal(type);
  try {
    return tierOf(operationId as never);
  } catch {
    return tierFallback;
  }
}

app.get("/api/state", (c) => c.json(state()));

app.post("/api/collect", async (c) => {
  try {
    const dir = await collectWorkspace({ log: say });
    return c.json({ ok: true, dir });
  } catch (e) {
    say(`collect failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

app.post("/api/seed", async (c) => {
  const { mode } = (await c.req.json().catch(() => ({}))) as { mode?: string };
  const dir = mode === "simulate" ? simulatedSnapshot() : snapshotFromReference();
  say(`seeded snapshot (${mode ?? "reference"}) → ${path.basename(dir)}`);
  return c.json({ ok: true, dir });
});

app.post("/api/analyze/:id", async (c) => {
  const id = c.req.param("id");
  const dir = latestSnapshotDir();
  if (!dir) return c.json({ ok: false, error: "no snapshot" }, 400);
  const { campaigns } = readSnapshot(dir);
  const snap = campaigns.find((s) => s.campaign.id === id);
  if (!snap) return c.json({ ok: false, error: "unknown campaign" }, 404);
  const ledger = loadLedger();
  try {
    const ev = evaluate(snap);
    say(`analyzing ${snap.campaign.name}…`);
    const res = await analyzeCampaign(snap, ev, ledger);
    const created = addProposals(
      ledger,
      res.analysis.proposals.map((p) => ({
        campaign_id: snap.campaign.id,
        campaign_name: snap.campaign.name,
        type: p.type,
        title: p.title,
        target: { document_id: p.target.document_id ?? undefined, step_id: p.target.step_id ?? undefined, sequence_id: p.target.sequence_id ?? undefined },
        before: p.before,
        after: p.after,
        rationale: p.rationale,
        evidence: p.evidence,
        expected_metric: p.expected_metric,
        expected_direction: p.expected_direction,
        confidence: p.confidence,
        tier: tierFor(p.type),
      })),
    );
    if (config.autopilotMode === "tiered") for (const p of created.filter(autoApprovable)) decide(ledger, p.id, true, "autopilot", "auto-approved: safe tier, high confidence");
    saveLedger(ledger);
    say(`  ${created.length} proposal(s); diagnosis: ${res.analysis.diagnosis.slice(0, 160)}…`);
    return c.json({ ok: true, diagnosis: res.analysis.diagnosis, reply_classification: res.analysis.reply_classification, proposals: created, usage: res.usage });
  } catch (e) {
    say(`analyze failed: ${(e as Error).message}`);
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post("/api/proposals/:id/:decision", async (c) => {
  const ledger = loadLedger();
  const { note } = (await c.req.json().catch(() => ({}))) as { note?: string };
  try {
    const p = decide(ledger, c.req.param("id"), c.req.param("decision") === "approve", "human", note);
    saveLedger(ledger);
    say(`${p.status}: ${p.title}`);
    return c.json({ ok: true, proposal: p });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

app.post("/api/apply/:id", async (c) => {
  const { dryRun } = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
  const dir = latestSnapshotDir();
  if (!dir) return c.json({ ok: false, error: "no snapshot" }, 400);
  const { campaigns } = readSnapshot(dir);
  const ledger = loadLedger();
  try {
    const r = await applyProposal(ledger, c.req.param("id"), campaigns, { dryRun });
    if (!dryRun) saveLedger(ledger);
    say(`${dryRun ? "dry-run" : r.applied ? "APPLIED" : "FAILED"} ${r.plan.method} ${r.plan.path} (${r.plan.tier})${r.error ? ": " + r.error : ""}`);
    return c.json({ ok: r.applied || Boolean(dryRun), plan: r.plan, error: r.error });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

app.post("/api/measure", (c) => {
  const dir = latestSnapshotDir();
  if (!dir) return c.json({ ok: false, error: "no snapshot" }, 400);
  const { campaigns } = readSnapshot(dir);
  const ledger = loadLedger();
  const measured = measureAll(ledger, campaigns);
  saveLedger(ledger);
  say(`measured ${measured.length} change(s)`);
  return c.json({ ok: true, measured });
});

app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(REPO_ROOT, "web")) || "web" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Campaign Autopilot dashboard → http://localhost:${port}`));
