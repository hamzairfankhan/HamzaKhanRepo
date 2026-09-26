/**
 * Two ways to get data when the demo workspace has none yet:
 *
 *  --from-reference  builds a snapshot from the raw JSON captured from a
 *                    reference workspace (reference/ or data/raw). Real shapes,
 *                    real numbers, no API key needed. Used for development and tests.
 *  --simulate        fabricates a small set of campaigns with synthetic history.
 *                    Everything produced this way carries simulated=true and is
 *                    labelled SIMULATED in every output.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config.js";
import { writeSnapshot } from "./collect.js";
import type { CampaignFull, CampaignMetrics, CampaignSnapshot, CampaignSummary } from "./types.js";

const unwrap = <T,>(raw: string): T => {
  const j = JSON.parse(raw) as { result?: T } | T;
  return ((j as { result?: T }).result ?? j) as T;
};

export function referenceDir(): string | null {
  for (const d of ["reference", path.join("data", "raw")]) {
    const p = path.join(REPO_ROOT, d);
    if (fs.existsSync(path.join(p, "campaigns_list.json"))) return p;
  }
  return null;
}

export function snapshotFromReference(opts: { limit?: number } = {}): string {
  const dir = referenceDir();
  if (!dir) throw new Error("No reference data found (expected reference/campaigns_list.json)");
  const campaigns: CampaignSummary[] = [];
  for (const f of ["campaigns_list.json", "campaigns_list_p2.json"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) campaigns.push(...unwrap<{ campaigns: CampaignSummary[] }>(fs.readFileSync(p, "utf8")).campaigns);
  }
  const fulls = new Map<string, CampaignFull>();
  const fullDir = path.join(dir, "campaigns");
  if (fs.existsSync(fullDir)) {
    for (const f of fs.readdirSync(fullDir)) {
      const full = unwrap<CampaignFull>(fs.readFileSync(path.join(fullDir, f), "utf8"));
      if (full?.id) fulls.set(full.id, full);
    }
  }
  const snaps: CampaignSnapshot[] = [];
  for (const c of campaigns.slice(0, opts.limit ?? campaigns.length)) {
    const mp = path.join(dir, "metrics", `${c.id}.json`);
    const metrics = fs.existsSync(mp) ? unwrap<CampaignMetrics>(fs.readFileSync(mp, "utf8")) : null;
    snaps.push({
      collected_at: new Date().toISOString(),
      campaign: c,
      full: fulls.get(c.id) ?? null,
      metrics,
      step_metrics: [],
      replies: [],
      deliverability_risk: { degraded: false, reasons: [] },
    });
  }
  return writeSnapshot(snaps, { workspace: "live" });
}

/** Deterministic pseudo-random so simulated demos are repeatable. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export function simulatedSnapshot(): string {
  const r = rng(42);
  const mk = (id: string, name: string, sent: number, replied: number, bounced: number, extra: Partial<CampaignSnapshot> = {}): CampaignSnapshot => {
    const delivered = sent - bounced;
    return {
      collected_at: new Date().toISOString(),
      campaign: { id, name, status: "active", category: "Outbound" },
      full: null,
      metrics: {
        campaign_id: id,
        name,
        status: "active",
        is_running: true,
        sequence_count: 1,
        days: 90,
        email_metrics: { sent, delivered, opened: null, replied, bounced, reply_rate: delivered ? +(100 * replied / delivered).toFixed(2) : 0 },
        metrics_available: true,
        metric_status: "available",
        send_receipts: { dispatched: sent, succeeded: sent, last_dispatched_at: new Date(Date.now() - 86_400_000 * Math.floor(r() * 5)).toISOString() },
        reconciliation: { rollup_sent: sent, receipt_dispatched: sent, receipt_succeeded: sent, receipt_last_dispatched_at: null, discrepancy: false, note: "simulated" },
        simulated: true,
      },
      step_metrics: [
        { step_id: "step_1", sent: Math.round(sent * 0.5), replied: Math.round(replied * 0.8) },
        { step_id: "step_2", sent: Math.round(sent * 0.3), replied: Math.round(replied * 0.2) },
        { step_id: "step_3", sent: Math.round(sent * 0.2), replied: 0 },
      ],
      replies: [],
      deliverability_risk: { degraded: false, reasons: [] },
      simulated: true,
      ...extra,
    };
  };
  const snaps = [
    mk("sim-1", "SIM · VP Sales · Series B SaaS · Cold Intro", 2400, 6, 30),
    mk("sim-2", "SIM · RevOps Leaders · CRM Consolidation", 900, 27, 9),
    mk("sim-3", "SIM · Agencies · Free GTM Map", 1500, 4, 120),
    mk("sim-4", "SIM · Founders · First Sales Hire", 60, 2, 0),
  ];
  return writeSnapshot(snaps, { workspace: "simulated" });
}

// ------------------------------------------------------------------ create real campaigns in the demo workspace

import * as g8 from "./g8/client.js";

interface DemoCampaignSpec {
  name: string;
  goal: string;
  target_persona: string;
  primary_hook: string;
  core_concept: string;
  steps: Array<{ name: string; day: number; cta_type: string; max_words: number; subject: string; body: string }>;
}

/** Deliberately mixed quality so the evaluator and analyzer have something to say. */
export const DEMO_CAMPAIGNS: DemoCampaignSpec[] = [
  {
    name: "Autopilot Demo · VP Sales · Series B SaaS · Pipeline Coverage",
    goal: "Book 15-minute calls with VP Sales at Series B SaaS companies about pipeline coverage gaps.",
    target_persona: "VP Sales / Head of Sales at 50–300 person B2B SaaS companies, post Series B",
    primary_hook: "Your reps' output problem is usually what they meet when they open the CRM, not effort.",
    core_concept: "Show that pre-researched, signal-enriched records let the same reps have more conversations.",
    steps: [
      { name: "Email 1 - Permission Hook", day: 1, cta_type: "soft_ask", max_words: 150, subject: "quick question about pipeline coverage at {{company}}", body: "Hi {{first_name}},\n\nI'm reaching out because I noticed {{company}} recently expanded the sales team and I wanted to share some thoughts on how leading revenue organizations are leveraging AI-powered enrichment and intent data to maximize pipeline coverage and accelerate their go-to-market motion in today's competitive landscape.\n\nOur platform delivers a comprehensive, end-to-end solution that unifies data, outreach and voice in a single pane of glass, empowering teams to work smarter, not harder.\n\nWould you be open to a quick 30-minute call next week to explore synergies?\n\nBest regards" },
      { name: "Email 2 - Value Add", day: 4, cta_type: "content", max_words: 150, subject: "re: pipeline coverage", body: "Hi {{first_name}}, following up on my previous email. I wanted to share a case study that demonstrates how a similar company achieved a 300% increase in pipeline. Let me know if you would like to see it.\n\nBest regards" },
      { name: "Email 3 - Direct Ask", day: 8, cta_type: "meeting", max_words: 120, subject: "last one", body: "Hi {{first_name}}, I have not heard back so I assume this is not a priority. If that changes, feel free to reach out.\n\nBest regards" },
    ],
  },
  {
    name: "Autopilot Demo · RevOps Leaders · CRM Consolidation",
    goal: "Start conversations with RevOps leaders consolidating a fragmented GTM stack.",
    target_persona: "Head of RevOps / Sales Ops at 100–500 person B2B companies running 5+ GTM tools",
    primary_hook: "Every tool you added to fix a gap created two more handoffs.",
    core_concept: "Position one system of record for data, outreach and dialer as fewer handoffs, not more features.",
    steps: [
      { name: "Email 1 - Pain Open", day: 1, cta_type: "soft_ask", max_words: 110, subject: "{{company}}'s GTM stack", body: "{{first_name}}, how many tools does a lead touch between form fill and first call at {{company}}?\n\nMost RevOps teams we talk to count six. Each one is a sync job someone owns on a Monday.\n\nWe run data, sequences and the dialer in one system so the record is already filled in when a rep opens it.\n\nWorth 15 minutes to compare notes on your stack?" },
      { name: "Email 2 - Proof", day: 5, cta_type: "content", max_words: 110, subject: "re: {{company}}'s GTM stack", body: "{{first_name}}, one concrete example: a 120-rep team replaced three sync jobs with one record and cut lead-to-first-touch from 2 days to 40 minutes.\n\nHappy to walk through how they mapped it. Would a short call this week work?" },
    ],
  },
];

export async function createDemoCampaigns(log: (s: string) => void = console.log): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of DEMO_CAMPAIGNS) {
    log(`creating "${spec.name}"…`);
    const created = await g8.createCampaign({
      name: spec.name,
      category: "Outbound",
      goal: spec.goal,
      target_persona: spec.target_persona,
      primary_hook: spec.primary_hook,
      core_concept: spec.core_concept,
      target_channels: ["email"],
      auto_generate_documents: false,
    });
    const id = String(created.id ?? created.campaign_id ?? "");
    if (!id) throw new Error(`createCampaign returned no id: ${JSON.stringify(created).slice(0, 300)}`);
    ids.push(id);
    for (const s of spec.steps) {
      await g8.createCampaignStep(id, { name: s.name, channel: "email", mode: "email", day: s.day, cta_type: s.cta_type, constraints: { max_words: s.max_words }, stop_on_reply: true, personalization_level: "medium" });
    }
    const emails = spec.steps.map((s, i) => `## step_${i + 1} — ${s.name} (day ${s.day})\n\nSubject: ${s.subject}\n\n${s.body}`).join("\n\n---\n\n");
    await g8.createCampaignDocument(id, { display_name: "Emails", file_type: "emails", folder_path: "campaign_copy/channels/email", content: emails, status: "completed" });
    log(`  → ${id} with ${spec.steps.length} steps and an Emails document`);
  }
  return ids;
}
