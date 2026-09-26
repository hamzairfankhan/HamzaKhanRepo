/**
 * The ledger is the system's memory: every proposal, who approved it, what was
 * applied (exact API call + payload), the metrics baseline at that moment, the
 * outcome measured later, and the learning distilled from it.
 *
 * Stored as one JSON file so it can be inspected, diffed and demoed. Every write
 * goes through this module so state transitions stay valid.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type ProposalType =
  | "rewrite_step_copy"
  | "change_subject"
  | "change_step_timing"
  | "remove_dead_step"
  | "pause_for_deliverability"
  | "narrow_audience"
  | "add_reply_branch";

export type Tier = "read" | "write" | "billable" | "external" | "destructive" | "unknown";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "failed" | "measured";

export interface Evidence {
  kind: "metric" | "reply" | "context_rule" | "step_metric" | "flag";
  /** e.g. "reply_rate_pct=0.08 (17/20758)" or a quoted reply line. */
  text: string;
}

export interface ApiCallPlan {
  operationId: string;
  method: string;
  path: string;
  tier: Tier;
  input: unknown;
}

export interface Proposal {
  id: string;
  created_at: string;
  campaign_id: string;
  campaign_name: string;
  type: ProposalType;
  title: string;
  target: { document_id?: string; step_id?: string; sequence_id?: string | number };
  before: string;
  after: string;
  rationale: string;
  evidence: Evidence[];
  expected_metric: "reply_rate" | "positive_reply_rate" | "bounce_rate" | "step_reply_rate" | "deliverability";
  expected_direction: "up" | "down";
  confidence: number;
  tier: Tier;
  status: ProposalStatus;
  decided_by?: "human" | "autopilot";
  decided_at?: string;
  decision_note?: string;
  applied_at?: string;
  api_call?: ApiCallPlan;
  api_result?: unknown;
  baseline?: { collected_at: string; value: number | null; n: number; step_id?: string };
  outcome?: {
    measured_at: string;
    method: "cohort" | "window";
    before: { value: number | null; n: number };
    after: { value: number | null; n: number };
    verdict: "improved" | "no_change" | "worse" | "insufficient_data";
    note: string;
  };
}

export interface Learning {
  id: string;
  created_at: string;
  proposal_id: string;
  campaign_id: string;
  type: ProposalType;
  verdict: NonNullable<Proposal["outcome"]>["verdict"];
  /** One sentence the analyzer can act on, e.g. "Shorter step 1 (< 90 words) raised reply rate 0.3% -> 0.9% for agency SDR personas." */
  text: string;
}

export interface Ledger {
  version: 1;
  proposals: Proposal[];
  learnings: Learning[];
}

const ledgerPath = () => path.join(config.dataDir, "ledger.json");

export function loadLedger(): Ledger {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return { version: 1, proposals: [], learnings: [] };
  return JSON.parse(fs.readFileSync(p, "utf8")) as Ledger;
}

export function saveLedger(l: Ledger): void {
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(ledgerPath(), JSON.stringify(l, null, 2));
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function addProposals(l: Ledger, ps: Omit<Proposal, "id" | "created_at" | "status">[]): Proposal[] {
  const created = ps.map((p) => ({ ...p, id: newId("prop"), created_at: new Date().toISOString(), status: "pending" as const }));
  l.proposals.push(...created);
  return created;
}

export function findProposal(l: Ledger, id: string): Proposal {
  const p = l.proposals.find((x) => x.id === id || x.id.endsWith(id));
  if (!p) throw new Error(`No proposal with id ${id}`);
  return p;
}

const allowed: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["applied", "failed", "rejected"],
  rejected: [],
  applied: ["measured"],
  failed: ["approved"],
  measured: [],
};

export function transition(p: Proposal, to: ProposalStatus, patch: Partial<Proposal> = {}): Proposal {
  if (!allowed[p.status].includes(to)) {
    throw new Error(`Proposal ${p.id}: cannot go from ${p.status} to ${to}`);
  }
  Object.assign(p, patch, { status: to });
  return p;
}

export function decide(l: Ledger, id: string, approve: boolean, by: "human" | "autopilot", note?: string): Proposal {
  const p = findProposal(l, id);
  return transition(p, approve ? "approved" : "rejected", {
    decided_by: by,
    decided_at: new Date().toISOString(),
    decision_note: note,
  });
}

/** Policy gate for tiered autopilot mode: which pending proposals may be auto-approved. */
export function autoApprovable(p: Proposal, minConfidence = config.thresholds.autoApplyConfidence): boolean {
  return p.status === "pending" && (p.tier === "read" || p.tier === "write") && p.confidence >= minConfidence;
}

export function addLearning(l: Ledger, learning: Omit<Learning, "id" | "created_at">): Learning {
  const item = { ...learning, id: newId("learn"), created_at: new Date().toISOString() };
  l.learnings.push(item);
  return item;
}

/** Learnings rendered for the analyzer prompt, newest first. */
export function learningsForPrompt(l: Ledger, max = 20): string {
  const items = [...l.learnings].reverse().slice(0, max);
  if (!items.length) return "(no measured outcomes yet)";
  return items.map((x) => `- [${x.verdict}] (${x.type}) ${x.text}`).join("\n");
}
