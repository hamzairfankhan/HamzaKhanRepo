/**
 * Deterministic campaign evaluation. No LLM here: every grade and flag is a pure
 * function of numbers, and every flag records the numbers and thresholds that
 * fired it, so the result is reproducible and explainable.
 */
import { config, type Thresholds } from "./config.js";
import type { CampaignSnapshot, ReplyClass, StepMetrics } from "./types.js";

export type Grade = "A" | "B" | "C" | "D" | "F" | "N/A";

export type FlagCode =
  | "no_sequence"
  | "low_volume"
  | "high_bounce"
  | "low_reply"
  | "poor_reply_quality"
  | "stale"
  | "metrics_lag"
  | "deliverability_risk"
  | "dead_step"
  | "not_launched";

export interface Flag {
  code: FlagCode;
  severity: "risk" | "warn" | "info";
  /** Human-readable, with the numbers and thresholds that fired it. */
  reason: string;
  data: Record<string, number | string | boolean | null>;
}

export interface DerivedMetrics {
  sent: number;
  delivered: number;
  replied: number;
  bounced: number;
  bounceRatePct: number | null;
  replyRatePct: number | null;
  /** Wilson 95% interval on reply rate, in percent. */
  replyRateCI: { low: number; high: number } | null;
  positiveReplies: number | null;
  positiveReplyRatePct: number | null;
  classifiedReplies: number;
  stalenessDays: number | null;
}

export interface Evaluation {
  campaign_id: string;
  name: string;
  status: string;
  grade: Grade;
  /** One sentence: why this grade. */
  verdict: string;
  flags: Flag[];
  metrics: DerivedMetrics;
  step_dropoff: Array<{ step_id: string; sent: number; replied: number; replyRatePct: number | null }>;
  simulated: boolean;
  evaluated_at: string;
}

/** Wilson score interval for a binomial proportion. Returns percentages. */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: (100 * Math.max(0, (centre - margin) / denom)), high: (100 * Math.min(1, (centre + margin) / denom)) };
}

const pct = (a: number, b: number): number | null => (b > 0 ? (100 * a) / b : null);
const round = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function deriveMetrics(
  snap: CampaignSnapshot,
  replyClasses?: Record<string, ReplyClass>,
  now = new Date(),
): DerivedMetrics {
  const em = snap.metrics?.email_metrics;
  const sent = em?.sent ?? 0;
  const delivered = em?.delivered ?? 0;
  const replied = em?.replied ?? 0;
  const bounced = em?.bounced ?? 0;

  let positiveReplies: number | null = null;
  let classifiedReplies = 0;
  if (replyClasses) {
    const classes = snap.replies.map((r) => replyClasses[r.id]).filter(Boolean);
    classifiedReplies = classes.length;
    positiveReplies = classes.filter((c) => c === "positive").length;
  }

  const last = snap.metrics?.send_receipts?.last_dispatched_at ?? snap.metrics?.reconciliation?.receipt_last_dispatched_at ?? null;
  const stalenessDays = last ? (now.getTime() - new Date(last).getTime()) / 86_400_000 : null;

  return {
    sent,
    delivered,
    replied,
    bounced,
    bounceRatePct: round(pct(bounced, sent)),
    replyRatePct: round(pct(replied, delivered)),
    replyRateCI: (() => {
      const ci = wilson(replied, delivered);
      return ci ? { low: round(ci.low)!, high: round(ci.high)! } : null;
    })(),
    positiveReplies,
    positiveReplyRatePct: positiveReplies === null ? null : round(pct(positiveReplies, delivered)),
    classifiedReplies,
    stalenessDays: round(stalenessDays, 1),
  };
}

export function stepDropoff(steps: StepMetrics[]) {
  return steps.map((s) => ({
    step_id: s.step_id,
    sent: s.sent,
    replied: s.replied,
    replyRatePct: round(pct(s.replied, s.sent)),
  }));
}

export function evaluate(
  snap: CampaignSnapshot,
  opts: { replyClasses?: Record<string, ReplyClass>; now?: Date; thresholds?: Thresholds } = {},
): Evaluation {
  const t = opts.thresholds ?? config.thresholds;
  const now = opts.now ?? new Date();
  const m = deriveMetrics(snap, opts.replyClasses, now);
  const status = snap.campaign.status;
  const active = status === "active";
  const flags: Flag[] = [];

  const metricStatus = snap.metrics?.metric_status ?? "unknown";

  if (active && metricStatus === "missing") {
    flags.push({
      code: "no_sequence",
      severity: "risk",
      reason: `Status is "active" but no sequence is attached (metric_status=missing): nothing is being sent.`,
      data: { metric_status: metricStatus, sequence_count: snap.metrics?.sequence_count ?? 0 },
    });
  }
  if (snap.full && snap.full.is_launched === false && active) {
    flags.push({
      code: "not_launched",
      severity: "info",
      reason: `Campaign is marked active but is_launched=false.`,
      data: { is_launched: false },
    });
  }
  if (snap.metrics?.reconciliation?.discrepancy) {
    const r = snap.metrics.reconciliation;
    flags.push({
      code: "metrics_lag",
      severity: "info",
      reason: `Analytics rollup counted ${r.rollup_sent} sends but send receipts show ${r.receipt_succeeded} succeeded; the metrics pipeline is lagging (not an outage). Receipt count is used where it matters.`,
      data: { rollup_sent: r.rollup_sent, receipt_succeeded: r.receipt_succeeded },
    });
  }
  if (snap.deliverability_risk.degraded) {
    flags.push({
      code: "deliverability_risk",
      severity: "risk",
      reason: `Sending infrastructure is degraded: ${snap.deliverability_risk.reasons.join("; ")}.`,
      data: { reasons: snap.deliverability_risk.reasons.join(" | ") },
    });
  }
  if (m.bounceRatePct !== null && m.bounceRatePct > t.maxBounceRatePct) {
    flags.push({
      code: "high_bounce",
      severity: "risk",
      reason: `Bounce rate ${m.bounceRatePct}% (${m.bounced}/${m.sent}) exceeds the ${t.maxBounceRatePct}% ceiling; this damages domain reputation regardless of copy.`,
      data: { bounce_rate_pct: m.bounceRatePct, threshold_pct: t.maxBounceRatePct, bounced: m.bounced, sent: m.sent },
    });
  }
  if (m.stalenessDays !== null && active && m.stalenessDays > t.staleDays) {
    flags.push({
      code: "stale",
      severity: "warn",
      reason: `Last email dispatched ${m.stalenessDays} days ago while status is active (threshold ${t.staleDays} days).`,
      data: { staleness_days: m.stalenessDays, threshold_days: t.staleDays },
    });
  }

  const enoughData = m.delivered >= t.minDelivered;
  if (!enoughData && metricStatus !== "missing") {
    flags.push({
      code: "low_volume",
      severity: "info",
      reason: `Only ${m.delivered} delivered emails (need ${t.minDelivered} before judging reply performance).`,
      data: { delivered: m.delivered, threshold: t.minDelivered },
    });
  }
  if (enoughData && m.replyRateCI && m.replyRateCI.high < t.poorReplyRatePct) {
    flags.push({
      code: "low_reply",
      severity: "warn",
      reason: `Reply rate ${m.replyRatePct}% (${m.replied}/${m.delivered}); even the optimistic bound of the 95% interval (${m.replyRateCI.high}%) is below ${t.poorReplyRatePct}%.`,
      data: { reply_rate_pct: m.replyRatePct, ci_high_pct: m.replyRateCI.high, threshold_pct: t.poorReplyRatePct },
    });
  }
  if (m.classifiedReplies >= t.minClassifiedReplies && m.positiveReplies !== null) {
    const share = m.positiveReplies / m.classifiedReplies;
    if (share < t.minPositiveShare) {
      flags.push({
        code: "poor_reply_quality",
        severity: "warn",
        reason: `Only ${m.positiveReplies} of ${m.classifiedReplies} classified replies are positive (${Math.round(share * 100)}% < ${t.minPositiveShare * 100}%).`,
        data: { positive: m.positiveReplies, classified: m.classifiedReplies, share: round(share) },
      });
    }
  }
  const dropoff = stepDropoff(snap.step_metrics);
  const anyReplyingStep = dropoff.some((s) => s.replied > 0);
  for (const s of dropoff) {
    if (anyReplyingStep && s.sent >= t.deadStepMinSends && s.replied === 0) {
      flags.push({
        code: "dead_step",
        severity: "warn",
        reason: `Step ${s.step_id} sent ${s.sent} emails with zero replies while another step in the sequence gets replies.`,
        data: { step_id: s.step_id, sent: s.sent, threshold_sends: t.deadStepMinSends },
      });
    }
  }

  // Grade rubric (see plan §5). Risk flags dominate.
  let grade: Grade;
  let verdict: string;
  const risk = flags.filter((f) => f.severity === "risk");
  if (risk.length) {
    grade = "F";
    verdict = `Failing because of ${risk.map((f) => f.code).join(", ")}: fix infrastructure/setup before touching copy.`;
  } else if (!enoughData) {
    grade = "N/A";
    verdict = `Not enough data yet (${m.delivered} delivered < ${t.minDelivered}).`;
  } else if (m.positiveReplyRatePct !== null && m.positiveReplyRatePct >= t.goodPositiveReplyRatePct) {
    grade = "A";
    verdict = `Positive-reply rate ${m.positiveReplyRatePct}% meets the ${t.goodPositiveReplyRatePct}% bar with no risk flags.`;
  } else if ((m.replyRatePct ?? 0) >= t.goodReplyRatePct) {
    grade = "B";
    verdict = `Reply rate ${m.replyRatePct}% is at or above ${t.goodReplyRatePct}%${m.positiveReplies === null ? " (reply quality not yet classified)" : ""}.`;
  } else if ((m.replyRatePct ?? 0) >= t.poorReplyRatePct) {
    grade = "C";
    verdict = `Reply rate ${m.replyRatePct}% is between ${t.poorReplyRatePct}% and ${t.goodReplyRatePct}%.`;
  } else {
    grade = "D";
    verdict = `Reply rate ${m.replyRatePct}% is below ${t.poorReplyRatePct}% on ${m.delivered} delivered emails.`;
  }

  return {
    campaign_id: snap.campaign.id,
    name: snap.campaign.name,
    status,
    grade,
    verdict,
    flags,
    metrics: m,
    step_dropoff: dropoff,
    simulated: Boolean(snap.simulated || snap.metrics?.simulated),
    evaluated_at: now.toISOString(),
  };
}

/** Sort order for the grade table: worst first, but N/A after real grades. */
export const gradeRank: Record<Grade, number> = { F: 0, D: 1, C: 2, B: 3, A: 4, "N/A": 5 };
