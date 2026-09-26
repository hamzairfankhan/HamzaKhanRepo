import { describe, expect, it } from "vitest";
import { evaluate, wilson } from "../src/evaluate.js";
import type { CampaignSnapshot } from "../src/types.js";

const base = (over: Partial<CampaignSnapshot> & { em?: Partial<NonNullable<CampaignSnapshot["metrics"]>["email_metrics"]> ; status?: string; metricStatus?: any }): CampaignSnapshot => ({
  collected_at: "2026-09-26T12:00:00Z",
  campaign: { id: "c1", name: "Test", status: over.status ?? "active" },
  full: null,
  metrics: {
    campaign_id: "c1",
    name: "Test",
    status: over.status ?? "active",
    is_running: true,
    sequence_count: 1,
    days: 90,
    email_metrics: over.em === undefined ? null : { sent: 0, delivered: 0, opened: null, replied: 0, bounced: 0, ...over.em },
    metrics_available: true,
    metric_status: over.metricStatus ?? "available",
    send_receipts: { dispatched: 0, succeeded: 0, last_dispatched_at: "2026-09-25T12:00:00Z" },
    reconciliation: { rollup_sent: 0, receipt_dispatched: 0, receipt_succeeded: 0, receipt_last_dispatched_at: null, discrepancy: false, note: "" },
  },
  step_metrics: [],
  replies: [],
  deliverability_risk: { degraded: false, reasons: [] },
  ...over,
});

const now = new Date("2026-09-26T12:00:00Z");

describe("wilson", () => {
  it("returns null for n=0 and a sane interval otherwise", () => {
    expect(wilson(0, 0)).toBeNull();
    const ci = wilson(17, 20758)!;
    expect(ci.low).toBeGreaterThan(0.04);
    expect(ci.high).toBeLessThan(0.14);
  });
});

describe("evaluate", () => {
  it("fails an active campaign with no sequence", () => {
    const e = evaluate(base({ metricStatus: "missing" }), { now });
    expect(e.grade).toBe("F");
    expect(e.flags.map((f) => f.code)).toContain("no_sequence");
  });

  it("withholds a grade on low volume", () => {
    const e = evaluate(base({ em: { sent: 40, delivered: 40, replied: 3 } }), { now });
    expect(e.grade).toBe("N/A");
    expect(e.flags.map((f) => f.code)).toContain("low_volume");
  });

  it("grades the real PLG campaign numbers as D with low_reply (bounce 2.06% is under the 3% ceiling)", () => {
    const e = evaluate(base({ em: { sent: 21194, delivered: 20758, replied: 17, bounced: 436 } }), { now });
    expect(e.grade).toBe("D");
    expect(e.flags.map((f) => f.code)).toContain("low_reply");
    expect(e.flags.map((f) => f.code)).not.toContain("high_bounce");
    expect(e.metrics.replyRatePct).toBeCloseTo(0.08, 2);
  });

  it("fails on high bounce", () => {
    const e = evaluate(base({ em: { sent: 1000, delivered: 900, replied: 30, bounced: 100 } }), { now });
    expect(e.grade).toBe("F");
    expect(e.flags[0].data.bounce_rate_pct).toBe(10);
  });

  it("gives A when positive-reply rate clears the bar", () => {
    const replies = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}` }));
    const classes = Object.fromEntries(replies.map((r, i) => [r.id, i < 10 ? "positive" : "ooo"] as const));
    const e = evaluate(base({ em: { sent: 800, delivered: 800, replied: 12 }, replies }), { now, replyClasses: classes as any });
    expect(e.grade).toBe("A");
    expect(e.metrics.positiveReplyRatePct).toBe(1.25);
  });

  it("flags poor reply quality when most replies are unsubscribes", () => {
    const replies = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }));
    const classes = Object.fromEntries(replies.map((r, i) => [r.id, i < 1 ? "positive" : "unsubscribe"] as const));
    const e = evaluate(base({ em: { sent: 500, delivered: 500, replied: 10 }, replies }), { now, replyClasses: classes as any });
    expect(e.flags.map((f) => f.code)).toContain("poor_reply_quality");
  });

  it("flags a dead step and staleness", () => {
    const snap = base({ em: { sent: 1000, delivered: 1000, replied: 12 } });
    snap.step_metrics = [
      { step_id: "step_1", sent: 500, replied: 12 },
      { step_id: "step_2", sent: 300, replied: 0 },
    ];
    snap.metrics!.send_receipts!.last_dispatched_at = "2026-09-01T00:00:00Z";
    const e = evaluate(snap, { now });
    const codes = e.flags.map((f) => f.code);
    expect(codes).toContain("dead_step");
    expect(codes).toContain("stale");
    expect(e.grade).toBe("C");
  });
});
