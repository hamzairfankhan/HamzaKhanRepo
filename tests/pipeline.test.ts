import { describe, expect, it } from "vitest";
import { patchEmailsDocument } from "../src/apply.js";
import { addProposals, autoApprovable, decide, transition, type Ledger, type Proposal } from "../src/ledger.js";
import { judge } from "../src/measure.js";
import { loadFallbackContext } from "../src/context.js";

const draft = (over: Partial<Proposal> = {}): Omit<Proposal, "id" | "created_at" | "status"> => ({
  campaign_id: "c1",
  campaign_name: "Test",
  type: "rewrite_step_copy",
  title: "Shorten step 1",
  target: { document_id: "d1", step_id: "step_1" },
  before: "old",
  after: "new",
  rationale: "because",
  evidence: [{ kind: "metric", text: "reply_rate=0.08%" }],
  expected_metric: "reply_rate",
  expected_direction: "up",
  confidence: 0.9,
  tier: "external",
  ...over,
});

describe("ledger", () => {
  it("enforces the state machine and the autopilot gate", () => {
    const l: Ledger = { version: 1, proposals: [], learnings: [] };
    const [p] = addProposals(l, [draft()]);
    expect(p.status).toBe("pending");
    expect(autoApprovable(p)).toBe(false); // external tier never auto-approves
    const [w] = addProposals(l, [draft({ tier: "write", confidence: 0.85 })]);
    expect(autoApprovable(w)).toBe(true);
    expect(() => transition(p, "applied")).toThrow(); // pending -> applied is illegal
    decide(l, p.id, true, "human");
    expect(p.status).toBe("approved");
    transition(p, "applied", { applied_at: "now" });
    expect(() => decide(l, p.id, false, "human")).toThrow();
  });
});

describe("patchEmailsDocument", () => {
  it("replaces exact and whitespace-normalised spans", () => {
    const doc = "Subject: Hi\n\nHello   there,\nold body here.\n\n-- end";
    expect(patchEmailsDocument(doc, "old body here.", "new body.").content).toContain("new body.");
    const r = patchEmailsDocument(doc, "Hello there, old body here.", "Hi. New body.");
    expect(r.how).toBe("normalised");
    expect(r.content).toBe("Subject: Hi\n\nHi. New body.\n\n-- end");
    expect(() => patchEmailsDocument(doc, "not present", "x")).toThrow();
  });
});

describe("measure.judge", () => {
  const p = draft() as Proposal;
  it("withholds a verdict on thin data", () => {
    expect(judge(p, { value: 0.5, n: 1000 }, { value: 0.6, n: 1050 }).verdict).toBe("insufficient_data");
  });
  it("detects improvement from the marginal rate since the change", () => {
    // before: 5/1000 = 0.5%; after: 5 + 30 replies on 1000 new sends = 3.0% marginal
    const j = judge(p, { value: 0.5, n: 1000 }, { value: 1.75, n: 2000 });
    expect(j.verdict).toBe("improved");
  });
  it("detects no change when the interval still covers the baseline", () => {
    const j = judge(p, { value: 2.0, n: 1000 }, { value: 2.0, n: 1200 });
    expect(j.verdict).toBe("no_change");
  });
});

describe("context", () => {
  it("loads org context from the reference docs when no condensed markdown exists", () => {
    const b = loadFallbackContext("/nonexistent");
    expect(["fallback", "none"]).toContain(b.source);
    if (b.source === "fallback") expect(b.sections.brand).toContain("Compliance");
  });
});
