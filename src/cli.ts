#!/usr/bin/env node
/**
 * autopilot CLI. Every command is one stage of the loop so each can be shown,
 * explained and re-run on its own during a demo.
 */
import { Command } from "commander";
import { analyzeCampaign, operationForProposal } from "./analyze.js";
import { applyProposal } from "./apply.js";
import { collectWorkspace, latestSnapshotDir, readSnapshot } from "./collect.js";
import { config } from "./config.js";
import { evaluate, gradeRank, type Evaluation } from "./evaluate.js";
import { tierOf } from "./g8/client.js";
import { addProposals, autoApprovable, decide, loadLedger, saveLedger, type Proposal, type Tier } from "./ledger.js";
import { measureAll } from "./measure.js";
import { createDemoCampaigns, snapshotFromReference, simulatedSnapshot } from "./seed.js";
import type { CampaignSnapshot } from "./types.js";

const program = new Command();
program.name("autopilot").description("Campaign Autopilot: evaluate, explain, improve and measure graph8 campaigns");

function loadLatest(): { dir: string; campaigns: CampaignSnapshot[] } {
  const dir = latestSnapshotDir();
  if (!dir) throw new Error("No snapshot yet. Run `autopilot collect` (needs G8_API_KEY) or `autopilot seed --from-reference`.");
  return { dir, ...readSnapshot(dir) };
}

export function evaluateAll(campaigns: CampaignSnapshot[]): Evaluation[] {
  return campaigns.map((c) => evaluate(c)).sort((a, b) => gradeRank[a.grade] - gradeRank[b.grade] || a.name.localeCompare(b.name));
}

function pad(s: string | number | null | undefined, n: number): string {
  const str = s === null || s === undefined ? "-" : String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str.padEnd(n);
}

export function renderGradeTable(evals: Evaluation[]): string {
  const lines = [
    `${pad("grade", 5)} ${pad("campaign", 58)} ${pad("sent", 7)} ${pad("reply%", 7)} ${pad("bounce%", 8)} flags`,
    "-".repeat(110),
  ];
  for (const e of evals) {
    const flags = e.flags.map((f) => f.code).join(",");
    lines.push(`${pad(e.grade, 5)} ${pad((e.simulated ? "[SIM] " : "") + e.name, 58)} ${pad(e.metrics.sent, 7)} ${pad(e.metrics.replyRatePct, 7)} ${pad(e.metrics.bounceRatePct, 8)} ${flags}`);
  }
  const counts = evals.reduce<Record<string, number>>((acc, e) => ((acc[e.grade] = (acc[e.grade] ?? 0) + 1), acc), {});
  lines.push("-".repeat(110), `totals: ${Object.entries(counts).map(([g, n]) => `${g}=${n}`).join("  ")}`);
  return lines.join("\n");
}

export function renderExplanation(e: Evaluation, snap?: CampaignSnapshot): string {
  const out: string[] = [];
  out.push(`# ${e.name}${e.simulated ? "  [SIMULATED DATA]" : ""}`);
  out.push(`campaign_id: ${e.campaign_id}   status: ${e.status}   grade: ${e.grade}`);
  out.push(`verdict: ${e.verdict}`);
  out.push("");
  out.push("## Numbers");
  const m = e.metrics;
  out.push(`sent=${m.sent} delivered=${m.delivered} replied=${m.replied} bounced=${m.bounced}`);
  out.push(`reply_rate=${m.replyRatePct ?? "-"}% (95% CI ${m.replyRateCI ? `${m.replyRateCI.low}–${m.replyRateCI.high}` : "-"}%)  bounce_rate=${m.bounceRatePct ?? "-"}%  positive_reply_rate=${m.positiveReplyRatePct ?? "not classified"}%  last_send=${m.stalenessDays ?? "-"} days ago`);
  if (e.step_dropoff.length) {
    out.push("");
    out.push("## Step drop-off");
    for (const s of e.step_dropoff) out.push(`  ${s.step_id}: sent=${s.sent} replied=${s.replied} (${s.replyRatePct ?? "-"}%)`);
  }
  out.push("");
  out.push(`## Flags (${e.flags.length})`);
  if (!e.flags.length) out.push("  none");
  for (const f of e.flags) out.push(`  [${f.severity}] ${f.code}: ${f.reason}`);
  if (snap?.full?.step_catalog?.steps) {
    out.push("");
    out.push("## Sequence");
    for (const [k, s] of Object.entries(snap.full.step_catalog.steps)) {
      const day = snap.full.sequence?.steps.find((x) => x.step_id === k)?.day;
      out.push(`  ${k} day ${day ?? "?"}: ${s.name} (${s.channel}, cta=${s.cta_type ?? "-"}, max_words=${s.constraints?.max_words ?? "-"})`);
    }
  }
  return out.join("\n");
}

program
  .command("collect")
  .description("Snapshot every campaign in the workspace (read-only)")
  .option("--days <n>", "lookback window", "90")
  .option("--limit <n>", "only the first N campaigns")
  .action(async (o) => {
    await collectWorkspace({ days: Number(o.days), limit: o.limit ? Number(o.limit) : undefined, log: console.log });
  });

program
  .command("seed")
  .description("Build a snapshot without a live workspace")
  .option("--from-reference", "from the reference workspace pull under reference/")
  .option("--simulate", "synthetic campaigns, labelled SIMULATED")
  .option("--create", "CREATE demo campaigns (steps + email copy) in the connected workspace via the API")
  .option("--limit <n>")
  .action(async (o) => {
    if (o.create) {
      const ids = await createDemoCampaigns(console.log);
      console.log(`created ${ids.length} campaign(s); now run \`autopilot collect\``);
    } else if (o.simulate) console.log(`Simulated snapshot written to ${simulatedSnapshot()}`);
    else console.log(`Reference snapshot written to ${snapshotFromReference({ limit: o.limit ? Number(o.limit) : undefined })}`);
  });

program
  .command("evaluate")
  .description("Grade every campaign in the latest snapshot")
  .option("--json", "machine-readable output")
  .action((o) => {
    const { dir, campaigns } = loadLatest();
    const evals = evaluateAll(campaigns);
    if (o.json) return console.log(JSON.stringify(evals, null, 2));
    console.log(`snapshot: ${dir}\n`);
    console.log(renderGradeTable(evals));
  });

program
  .command("explain <campaign>")
  .description("Show the full reasoning chain for one campaign (id prefix or name substring)")
  .action((q: string) => {
    const { campaigns } = loadLatest();
    const snap = campaigns.find((c) => c.campaign.id.startsWith(q) || c.campaign.name.toLowerCase().includes(q.toLowerCase()));
    if (!snap) throw new Error(`No campaign matches "${q}"`);
    console.log(renderExplanation(evaluate(snap), snap));
  });

function findSnap(campaigns: CampaignSnapshot[], q: string): CampaignSnapshot {
  const snap = campaigns.find((c) => c.campaign.id.startsWith(q) || c.campaign.name.toLowerCase().includes(q.toLowerCase()));
  if (!snap) throw new Error(`No campaign matches "${q}"`);
  return snap;
}

function tierFor(type: Proposal["type"]): Tier {
  const { operationId, tierFallback } = operationForProposal(type);
  try {
    return tierOf(operationId as never);
  } catch {
    return tierFallback;
  }
}

export function renderProposal(p: Proposal, verbose = false): string {
  const head = `${p.id}  [${p.status}]  ${p.type}  tier=${p.tier}  conf=${p.confidence.toFixed(2)}  ${p.campaign_name}\n  ${p.title}`;
  if (!verbose) return head;
  const ev = p.evidence.map((e) => `    - (${e.kind}) ${e.text}`).join("\n");
  return `${head}\n  expects ${p.expected_metric} ${p.expected_direction}\n  rationale: ${p.rationale}\n  evidence:\n${ev}\n  --- before ---\n${p.before}\n  --- after ---\n${p.after}`;
}

async function analyzeOne(snap: CampaignSnapshot, ledger: ReturnType<typeof loadLedger>, log = console.log): Promise<Proposal[]> {
  const ev = evaluate(snap);
  log(`analyzing ${snap.campaign.name} (grade ${ev.grade}, ${snap.replies.length} replies)…`);
  const res = await analyzeCampaign(snap, ev, ledger);
  log(`  diagnosis: ${res.analysis.diagnosis}`);
  log(`  replies classified: ${res.analysis.reply_classification.length}; tokens in=${res.usage.input} cached=${res.usage.cache_read} out=${res.usage.output}`);
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
  for (const p of created) log(`  + ${renderProposal(p)}`);
  return created;
}

program
  .command("analyze [campaign]")
  .description("Ask Claude to classify replies, diagnose, and propose changes (all campaigns with a real grade, or one)")
  .option("--max <n>", "max campaigns when analyzing all", "5")
  .action(async (q: string | undefined, o) => {
    const { campaigns } = loadLatest();
    const ledger = loadLedger();
    const targets = q ? [findSnap(campaigns, q)] : evaluateAll(campaigns).filter((e) => e.grade !== "N/A").slice(0, Number(o.max)).map((e) => campaigns.find((c) => c.campaign.id === e.campaign_id)!);
    for (const snap of targets) {
      await analyzeOne(snap, ledger);
      saveLedger(ledger);
    }
  });

program
  .command("proposals")
  .description("List proposals in the ledger")
  .option("--status <s>", "filter by status")
  .option("-v, --verbose")
  .action((o) => {
    const ledger = loadLedger();
    const rows = ledger.proposals.filter((p) => !o.status || p.status === o.status);
    if (!rows.length) return console.log("(no proposals)");
    for (const p of rows) console.log(renderProposal(p, o.verbose) + "\n");
  });

program
  .command("approve <id>")
  .option("--note <text>")
  .action((id: string, o) => {
    const ledger = loadLedger();
    const p = decide(ledger, id, true, "human", o.note);
    saveLedger(ledger);
    console.log(`approved ${p.id}: ${p.title}`);
  });

program
  .command("reject <id>")
  .option("--note <text>")
  .action((id: string, o) => {
    const ledger = loadLedger();
    const p = decide(ledger, id, false, "human", o.note);
    saveLedger(ledger);
    console.log(`rejected ${p.id}: ${p.title}`);
  });

program
  .command("apply [id]")
  .description("Apply approved proposals through the graph8 API (one, or all approved)")
  .option("--dry-run", "show the exact API call and change nothing")
  .action(async (id: string | undefined, o) => {
    const { campaigns } = loadLatest();
    const ledger = loadLedger();
    const ids = id ? [id] : ledger.proposals.filter((p) => p.status === "approved").map((p) => p.id);
    if (!ids.length) return console.log("nothing approved to apply");
    for (const pid of ids) {
      const r = await applyProposal(ledger, pid, campaigns, { dryRun: Boolean(o.dryRun) });
      console.log(`${o.dryRun ? "DRY RUN" : r.applied ? "APPLIED" : "FAILED"}  ${r.proposal.id}  ${r.plan.method} ${r.plan.path}  tier=${r.plan.tier}`);
      console.log(JSON.stringify(r.plan.input, null, 2).split("\n").map((l) => "    " + l).slice(0, 40).join("\n"));
      if (r.error) console.log(`    error: ${r.error}`);
    }
    if (!o.dryRun) saveLedger(ledger);
  });

program
  .command("measure")
  .description("Compare applied changes against the latest snapshot and record outcomes + learnings")
  .action(() => {
    const { campaigns } = loadLatest();
    const ledger = loadLedger();
    const measured = measureAll(ledger, campaigns);
    saveLedger(ledger);
    if (!measured.length) return console.log("no applied proposal has enough new data yet");
    for (const p of measured) console.log(`${p.outcome!.verdict.toUpperCase()}  ${p.title}: ${p.outcome!.note}`);
  });

program
  .command("run")
  .description("One full cycle: collect → measure → evaluate → analyze → (tiered auto-approve) → apply")
  .option("--no-collect", "reuse the latest snapshot")
  .option("--max <n>", "max campaigns to analyze", "3")
  .action(async (o) => {
    if (o.collect) await collectWorkspace({ log: console.log });
    const { campaigns } = loadLatest();
    const ledger = loadLedger();
    const measured = measureAll(ledger, campaigns);
    console.log(`measured ${measured.length} earlier change(s)`);
    const evals = evaluateAll(campaigns);
    console.log(renderGradeTable(evals));
    const targets = evals.filter((e) => e.grade !== "N/A" && e.grade !== "A").slice(0, Number(o.max));
    for (const e of targets) await analyzeOne(campaigns.find((c) => c.campaign.id === e.campaign_id)!, ledger);
    if (config.autopilotMode === "tiered") {
      for (const p of ledger.proposals.filter(autoApprovable)) {
        decide(ledger, p.id, true, "autopilot", "auto-approved: safe tier, high confidence");
        console.log(`autopilot approved ${p.id} (${p.tier}, ${p.confidence})`);
      }
    }
    saveLedger(ledger);
    const approved = ledger.proposals.filter((p) => p.status === "approved");
    for (const p of approved) {
      const r = await applyProposal(ledger, p.id, campaigns);
      console.log(`${r.applied ? "APPLIED" : "FAILED"} ${p.id} ${p.title}${r.error ? ": " + r.error : ""}`);
    }
    saveLedger(ledger);
    const pending = ledger.proposals.filter((p) => p.status === "pending").length;
    console.log(`\n${pending} proposal(s) waiting for a human decision. Run \`autopilot proposals\` or open the dashboard.`);
  });

program
  .command("loop")
  .description("Run cycles forever")
  .option("--every <minutes>", "interval", "30")
  .action(async (o) => {
    const every = Number(o.every) * 60_000;
    for (;;) {
      await program.parseAsync(["node", "autopilot", "run"]);
      console.log(`next cycle in ${o.every} min`);
      await new Promise((r) => setTimeout(r, every));
    }
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
