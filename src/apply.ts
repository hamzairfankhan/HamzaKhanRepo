/**
 * Apply approved proposals through the graph8 SDK.
 *
 * Safety properties:
 *  - Only proposals in state `approved` are applied; nothing is applied straight from `pending`.
 *  - The tier of the underlying operation is read from graph8's contract. In `tiered`
 *    autopilot mode only read/write tiers may be auto-approved; external/destructive
 *    always required a human decision before reaching this stage.
 *  - `dryRun` prints the exact operation, path and payload and changes nothing.
 *  - Every application records the call, the result, and a metrics baseline for `measure`.
 */
import { operationForProposal } from "./analyze.js";
import * as g8 from "./g8/client.js";
import { evaluate } from "./evaluate.js";
import { findProposal, transition, type ApiCallPlan, type Ledger, type Proposal, type Tier } from "./ledger.js";
import type { CampaignSnapshot } from "./types.js";

function stepNumberFromId(stepId: string): number | null {
  const m = /(\d+)/.exec(stepId);
  return m ? Number(m[1]) : null;
}

/** Replace one step's section inside the campaign "emails" markdown document. Falls back to a literal before→after replacement. */
export function patchEmailsDocument(content: string, before: string, after: string): { content: string; how: "exact" | "normalised" } {
  if (before && content.includes(before)) return { content: content.replace(before, after), how: "exact" };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const nb = norm(before);
  if (nb) {
    // Find the span in the original whose normalised form equals `before`.
    const words = nb.split(" ");
    const firstIdx = content.indexOf(words[0]);
    if (firstIdx >= 0) {
      let end = firstIdx;
      let seen = "";
      while (end < content.length && norm(seen).length < nb.length) {
        seen += content[end++];
      }
      if (norm(seen) === nb) return { content: content.slice(0, firstIdx) + after + content.slice(end), how: "normalised" };
    }
  }
  throw new Error("Could not locate the 'before' text in the current document; it may have changed since the proposal was made.");
}

export function planCall(p: Proposal, snap: CampaignSnapshot | undefined): ApiCallPlan {
  const { operationId, tierFallback } = operationForProposal(p.type);
  let tier: Tier = tierFallback;
  let method = "PUT";
  let path = "";
  try {
    const info = g8.opInfo(operationId as never);
    tier = (info.tier as Tier | null) ?? tierFallback;
    method = info.method;
    path = info.path;
  } catch {
    /* no API key: keep fallbacks for dry-run display */
  }
  const campaignId = p.campaign_id;
  switch (p.type) {
    case "rewrite_step_copy":
    case "change_subject":
    case "add_reply_branch": {
      const doc = snap?.full?.documents.find((d) => d.id === p.target.document_id) ?? snap?.full?.documents.find((d) => d.file_type === "emails");
      if (!doc) throw new Error("No campaign document to patch (need the 'emails' document in the snapshot)");
      const patched = patchEmailsDocument(doc.content, p.before, p.after);
      return { operationId, method, path: path.replace("{campaign_id}", campaignId).replace("{document_id}", doc.id), tier, input: { path: { campaign_id: campaignId, document_id: doc.id }, body: { content: patched.content } } };
    }
    case "change_step_timing": {
      const stepId = p.target.step_id ?? "";
      const day = Number(/(\d+)/.exec(p.after)?.[1]);
      if (!stepId || Number.isNaN(day)) throw new Error("change_step_timing needs target.step_id and a day number in 'after'");
      return { operationId, method, path: path.replace("{campaign_id}", campaignId).replace("{step_id}", stepId), tier, input: { path: { campaign_id: campaignId, step_id: stepId }, body: { day } } };
    }
    case "remove_dead_step": {
      const stepId = p.target.step_id ?? "";
      if (!stepId) throw new Error("remove_dead_step needs target.step_id");
      // Non-destructive removal: push the step far out and stop it from sending, rather than deleting it.
      return { operationId, method, path: path.replace("{campaign_id}", campaignId).replace("{step_id}", stepId), tier, input: { path: { campaign_id: campaignId, step_id: stepId }, body: { condition: "disabled_by_autopilot", do_not_send_rules: ["disabled_by_autopilot"] } } };
    }
    case "pause_for_deliverability": {
      const seq = p.target.sequence_id ?? snap?.full?.linked_sequences?.[0]?.sequence_id ?? snap?.full?.linked_sequences?.[0]?.id;
      if (!seq) throw new Error("pause_for_deliverability needs a sequence id");
      return { operationId, method: "POST", path: path.replace("{sequence_id}", String(seq)), tier, input: { path: { sequence_id: String(seq) } } };
    }
    case "narrow_audience":
      throw new Error("narrow_audience is advisory in this version: apply it in graph8 by attaching a narrower list.");
  }
}

export function baselineFor(p: Proposal, snap: CampaignSnapshot | undefined) {
  if (!snap) return undefined;
  const ev = evaluate(snap);
  const m = ev.metrics;
  const pick = (): { value: number | null; n: number; step_id?: string } => {
    switch (p.expected_metric) {
      case "bounce_rate":
        return { value: m.bounceRatePct, n: m.sent };
      case "positive_reply_rate":
        return { value: m.positiveReplyRatePct, n: m.delivered };
      case "step_reply_rate": {
        const s = ev.step_dropoff.find((x) => x.step_id === p.target.step_id);
        return { value: s?.replyRatePct ?? null, n: s?.sent ?? 0, step_id: p.target.step_id ?? undefined };
      }
      case "deliverability":
        return { value: snap.deliverability_risk.degraded ? 0 : 1, n: 1 };
      default:
        return { value: m.replyRatePct, n: m.delivered };
    }
  };
  return { collected_at: snap.collected_at, ...pick() };
}

export interface ApplyOutcome {
  proposal: Proposal;
  plan: ApiCallPlan;
  applied: boolean;
  error?: string;
}

export async function applyProposal(ledger: Ledger, id: string, snaps: CampaignSnapshot[], opts: { dryRun?: boolean } = {}): Promise<ApplyOutcome> {
  const p = findProposal(ledger, id);
  if (p.status !== "approved") throw new Error(`Proposal ${p.id} is ${p.status}; only approved proposals can be applied.`);
  const snap = snaps.find((s) => s.campaign.id === p.campaign_id);
  const plan = planCall(p, snap);
  if (opts.dryRun) return { proposal: p, plan, applied: false };
  try {
    const input = plan.input as { path: Record<string, string>; body?: Record<string, unknown> };
    let result: unknown;
    switch (p.type) {
      case "rewrite_step_copy":
      case "change_subject":
      case "add_reply_branch":
        result = await g8.updateCampaignDocument(input.path.campaign_id, input.path.document_id, input.body as never);
        break;
      case "change_step_timing":
      case "remove_dead_step":
        result = await g8.updateCampaignStep(input.path.campaign_id, input.path.step_id, input.body as never);
        break;
      case "pause_for_deliverability":
        result = await g8.pauseSequence(input.path.sequence_id);
        break;
      default:
        throw new Error(`No applier for ${p.type}`);
    }
    transition(p, "applied", { applied_at: new Date().toISOString(), api_call: plan, api_result: result, baseline: baselineFor(p, snap) });
    return { proposal: p, plan, applied: true };
  } catch (e) {
    const msg = (e as Error).message;
    transition(p, "failed", { api_call: plan, api_result: { error: msg } });
    return { proposal: p, plan, applied: false, error: msg };
  }
}
