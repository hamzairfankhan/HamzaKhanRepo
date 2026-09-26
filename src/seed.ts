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
