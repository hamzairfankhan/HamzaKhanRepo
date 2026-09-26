/**
 * Collect a reproducible snapshot of every campaign in the workspace.
 * All later stages (evaluate, analyze, measure) read from the snapshot on disk,
 * so a demo or an explanation can always be traced back to the exact inputs.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import * as g8 from "./g8/client.js";
import type { CampaignSnapshot, CampaignSummary, StepMetrics } from "./types.js";

export interface SnapshotIndex {
  collected_at: string;
  workspace: "live" | "simulated";
  campaign_ids: string[];
  deliverability: unknown;
  context_docs: number;
}

export function snapshotsDir(): string {
  return path.join(config.dataDir, "snapshots");
}

export function latestSnapshotDir(): string | null {
  const dir = snapshotsDir();
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "index.json"))).sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

export function readSnapshot(dir: string): { index: SnapshotIndex; campaigns: CampaignSnapshot[] } {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as SnapshotIndex;
  const campaigns = index.campaign_ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as CampaignSnapshot);
  return { index, campaigns };
}

export function writeSnapshot(campaigns: CampaignSnapshot[], extra: Partial<SnapshotIndex> = {}): string {
  const collected_at = new Date().toISOString();
  const dir = path.join(snapshotsDir(), collected_at.replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  for (const c of campaigns) fs.writeFileSync(path.join(dir, `${c.campaign.id}.json`), JSON.stringify(c, null, 2));
  const index: SnapshotIndex = {
    collected_at,
    workspace: campaigns.some((c) => c.simulated) ? "simulated" : "live",
    campaign_ids: campaigns.map((c) => c.campaign.id),
    deliverability: null,
    context_docs: 0,
    ...extra,
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  return dir;
}

/** Pull per-step metrics out of the analytics by-step report. The report shape is loose (ReportPayload = Record<string, unknown>). */
export function parseStepMetrics(report: Record<string, unknown> | null | undefined): StepMetrics[] {
  if (!report) return [];
  const rows = (report.rows ?? report.steps ?? report.data ?? report.items) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const row = r as Record<string, unknown>;
      const stepId = String(row.step_id ?? row.step ?? row.step_order ?? row.step_number ?? row.name ?? "");
      const num = (k: string[]) => {
        for (const key of k) if (typeof row[key] === "number") return row[key] as number;
        return 0;
      };
      return {
        step_id: stepId,
        sent: num(["sent", "emails_sent", "sends"]),
        delivered: num(["delivered", "emails_delivered"]),
        replied: num(["replied", "replies", "emails_replied"]),
        bounced: num(["bounced", "bounces"]),
      };
    })
    .filter((s) => s.step_id);
}

function deliverabilityRisk(d: { safe: unknown; degraded: unknown; sequencesHealth: unknown }, sequenceIds: string[]) {
  const reasons: string[] = [];
  const safe = d.safe as Record<string, unknown> | null;
  if (safe && safe.safe_to_send === false) reasons.push(`fleet not safe to send: ${safe.reason ?? safe.verdict ?? "see deliverability report"}`);
  const degraded = d.degraded as unknown;
  const degradedList = Array.isArray(degraded) ? degraded : ((degraded as { mailboxes?: unknown[]; items?: unknown[] })?.mailboxes ?? (degraded as { items?: unknown[] })?.items ?? []);
  if (Array.isArray(degradedList) && degradedList.length) reasons.push(`${degradedList.length} degraded mailbox(es) in the fleet`);
  const health = d.sequencesHealth as { sequences?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | null;
  const seqRows = Array.isArray(health) ? health : (health?.sequences ?? []);
  for (const row of seqRows) {
    const id = String(row.sequence_id ?? row.id ?? "");
    const status = String(row.health ?? row.status ?? "").toLowerCase();
    if (sequenceIds.includes(id) && ["degraded", "critical", "unhealthy", "at_risk"].includes(status)) reasons.push(`sequence ${id} health=${status}`);
  }
  return { degraded: reasons.length > 0, reasons };
}

export async function collectWorkspace(opts: { days?: number; limit?: number; log?: (s: string) => void } = {}): Promise<string> {
  const log = opts.log ?? (() => {});
  const days = opts.days ?? 90;
  log("Listing campaigns…");
  let campaigns: CampaignSummary[] = await g8.listCampaigns();
  if (opts.limit) campaigns = campaigns.slice(0, opts.limit);
  log(`Found ${campaigns.length} campaigns. Reading deliverability…`);
  const deliverability = await g8.getDeliverability();

  const snapshots: CampaignSnapshot[] = [];
  for (const c of campaigns) {
    log(`  ${c.status.padEnd(7)} ${c.name}`);
    const [full, metrics] = await Promise.all([
      g8.getCampaignFull(c.id).catch(() => null),
      g8.getCampaignMetrics(c.id, days).catch(() => null),
    ]);
    const seqIds = (full?.linked_sequences ?? []).map((s) => String(s.sequence_id ?? s.id ?? "")).filter(Boolean);
    const [stepReport, replies] = await Promise.all([
      seqIds[0] ? g8.getEmailByStep(seqIds[0], days).catch(() => null) : Promise.resolve(null),
      seqIds[0] ? g8.listInbox({ sequenceId: seqIds[0], pageSize: 50 }).catch(() => []) : Promise.resolve([]),
    ]);
    snapshots.push({
      collected_at: new Date().toISOString(),
      campaign: c,
      full,
      metrics,
      step_metrics: parseStepMetrics(stepReport),
      replies,
      deliverability_risk: deliverabilityRisk(deliverability, seqIds),
    });
  }
  let contextDocs = 0;
  try {
    const docs = await g8.getGlobalContextDocs();
    contextDocs = docs.length;
    if (docs.length) {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, "workspace_context.json"), JSON.stringify(docs, null, 2));
    }
  } catch {
    /* context docs are optional */
  }
  const dir = writeSnapshot(snapshots, { deliverability, context_docs: contextDocs });
  log(`Snapshot written to ${dir}`);
  return dir;
}
