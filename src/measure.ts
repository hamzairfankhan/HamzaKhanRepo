/**
 * Did the change work? For every applied proposal, compare the targeted metric
 * at application time (baseline) with the same metric in the latest snapshot.
 *
 * Method: "window" compares the whole-campaign metric before/after. It is honest
 * about its limits: it is confounded by time and audience, so we only claim a
 * verdict when the post-change sample is large enough and the interval moved.
 * "cohort" (contacts entered after the change) is preferred when sequence
 * contact entry dates are available in the snapshot.
 */
import { evaluate, wilson } from "./evaluate.js";
import { addLearning, transition, type Ledger, type Proposal } from "./ledger.js";
import type { CampaignSnapshot } from "./types.js";

const MIN_NEW_SAMPLE = 100;

export function currentValue(p: Proposal, snap: CampaignSnapshot): { value: number | null; n: number } {
  const ev = evaluate(snap);
  const m = ev.metrics;
  switch (p.expected_metric) {
    case "bounce_rate":
      return { value: m.bounceRatePct, n: m.sent };
    case "positive_reply_rate":
      return { value: m.positiveReplyRatePct, n: m.delivered };
    case "step_reply_rate": {
      const s = ev.step_dropoff.find((x) => x.step_id === p.target.step_id);
      return { value: s?.replyRatePct ?? null, n: s?.sent ?? 0 };
    }
    case "deliverability":
      return { value: snap.deliverability_risk.degraded ? 0 : 1, n: 1 };
    default:
      return { value: m.replyRatePct, n: m.delivered };
  }
}

export function judge(p: Proposal, before: { value: number | null; n: number }, after: { value: number | null; n: number }) {
  const newSample = after.n - before.n;
  if (before.value === null || after.value === null || newSample < MIN_NEW_SAMPLE) {
    return { verdict: "insufficient_data" as const, note: `Only ${Math.max(0, newSample)} new sends since the change (need ${MIN_NEW_SAMPLE}).` };
  }
  // Marginal rate since the change, when the metric is a rate over n.
  const beforeCount = (before.value / 100) * before.n;
  const afterCount = (after.value / 100) * after.n;
  const marginal = newSample > 0 ? (100 * (afterCount - beforeCount)) / newSample : after.value;
  const ci = wilson(Math.max(0, afterCount - beforeCount), newSample);
  const up = p.expected_direction === "up";
  const improved = up ? (ci?.low ?? marginal) > before.value : (ci?.high ?? marginal) < before.value;
  const worse = up ? (ci?.high ?? marginal) < before.value : (ci?.low ?? marginal) > before.value;
  const note = `Rate since change ${marginal.toFixed(2)}% on ${newSample} new sends (95% CI ${ci ? `${ci.low.toFixed(2)}–${ci.high.toFixed(2)}` : "-"}%) vs ${before.value}% before.`;
  return { verdict: improved ? ("improved" as const) : worse ? ("worse" as const) : ("no_change" as const), note, marginal };
}

export function measureAll(ledger: Ledger, snaps: CampaignSnapshot[]): Proposal[] {
  const measured: Proposal[] = [];
  for (const p of ledger.proposals.filter((x) => x.status === "applied" && x.baseline)) {
    const snap = snaps.find((s) => s.campaign.id === p.campaign_id);
    if (!snap) continue;
    const before = { value: p.baseline!.value, n: p.baseline!.n };
    const after = currentValue(p, snap);
    const j = judge(p, before, after);
    if (j.verdict === "insufficient_data") continue; // stay `applied`; try again next cycle
    transition(p, "measured", {
      outcome: { measured_at: new Date().toISOString(), method: "window", before, after, verdict: j.verdict, note: j.note },
    });
    addLearning(ledger, {
      proposal_id: p.id,
      campaign_id: p.campaign_id,
      type: p.type,
      verdict: j.verdict,
      text: `${p.title} (${p.campaign_name}): ${p.expected_metric} ${before.value}% → ${(j.marginal ?? after.value)?.toFixed?.(2) ?? after.value}% after the change. ${j.note}`,
    });
    measured.push(p);
  }
  return measured;
}
