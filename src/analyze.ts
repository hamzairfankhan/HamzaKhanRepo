/**
 * The judgment stage. Claude reads what the rules cannot: the actual email copy,
 * the replies, and the org's own brand/messaging/audience rules, and returns
 * typed, evidence-backed proposals. The schema is the contract: a proposal
 * without evidence, target ids, or a before/after cannot be produced.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { bundleFromWorkspaceDocs, loadFallbackContext, truncateBundle, type ContextBundle } from "./context.js";
import type { Evaluation } from "./evaluate.js";
import { learningsForPrompt, type Ledger, type Proposal, type Tier } from "./ledger.js";
import type { CampaignSnapshot, ReplyClass } from "./types.js";
import fs from "node:fs";
import path from "node:path";

export const ReplyClassSchema = z.enum(["positive", "objection", "not_now", "ooo", "unsubscribe", "wrong_person", "bounce_notice"]);

export const ProposalSchema = z.object({
  type: z.enum(["rewrite_step_copy", "change_subject", "change_step_timing", "remove_dead_step", "pause_for_deliverability", "narrow_audience", "add_reply_branch"]),
  title: z.string().describe("Short imperative title, e.g. 'Cut step 1 to under 90 words and lead with the pain'"),
  target: z.object({
    document_id: z.string().nullable().describe("The campaign document to change (e.g. the 'emails' doc) or null"),
    step_id: z.string().nullable().describe("The sequence step this concerns (e.g. step_1) or null"),
    sequence_id: z.string().nullable(),
  }),
  before: z.string().describe("Exact current text or setting being changed (quote it)"),
  after: z.string().describe("Exact proposed replacement text or setting"),
  rationale: z.string().describe("2-3 sentences; every claim must map to an evidence item"),
  evidence: z
    .array(
      z.object({
        kind: z.enum(["metric", "reply", "context_rule", "step_metric", "flag"]),
        text: z.string(),
      }),
    )
    .min(1),
  expected_metric: z.enum(["reply_rate", "positive_reply_rate", "bounce_rate", "step_reply_rate", "deliverability"]),
  expected_direction: z.enum(["up", "down"]),
  confidence: z.number().min(0).max(1),
});

export const AnalysisSchema = z.object({
  reply_classification: z.array(
    z.object({ thread_id: z.string(), class: ReplyClassSchema, quote: z.string().describe("The phrase that decided the class") }),
  ),
  diagnosis: z.string().describe("2-4 sentences. Each sentence cites a number, a flag, a quoted reply or a context rule."),
  proposals: z.array(ProposalSchema).max(5),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const SYSTEM_PREAMBLE = `You are Campaign Autopilot, an outbound-campaign analyst for a B2B revenue team using graph8.
You receive a deterministic evaluation (grade, flags with the exact numbers that fired them), the email copy that is actually being sent, the sequence structure, per-step metrics, and recent replies.
Your job: (1) classify each reply; (2) diagnose the most likely root cause of under-performance, citing numbers and quotes; (3) propose at most 5 concrete, applicable changes.

Rules:
- Infrastructure first: if there is a high_bounce, deliverability_risk or no_sequence flag, the first proposal must address it (pause_for_deliverability or a setup fix), because copy changes cannot help while sends bounce or nothing is sending.
- Every proposal must quote the exact current text in "before" and give the complete replacement in "after". For rewrite_step_copy, "after" is the full email body (and subject line on the first line as "Subject: ..."), respecting the step's max_words constraint and every rule in the <brand> and compliance context.
- Cite evidence. A proposal with no metric, reply, flag or context_rule evidence is invalid.
- Do not invent metrics. If data is thin (low_volume), say so and keep confidence <= 0.4.
- Prefer the smallest change that tests one hypothesis, so its effect can be measured on the next cycle.
- Learnings from previously measured changes are provided; prefer proposal types that improved before, avoid ones that made things worse in similar campaigns.`;

export function loadContext(): ContextBundle {
  const wsPath = path.join(config.dataDir, "workspace_context.json");
  if (fs.existsSync(wsPath)) {
    const docs = JSON.parse(fs.readFileSync(wsPath, "utf8")) as Array<{ category?: string | null; title: string; content?: string | null }>;
    const b = bundleFromWorkspaceDocs(docs);
    if (b) return truncateBundle(b);
  }
  return truncateBundle(loadFallbackContext());
}

export function buildSystemPrompt(ctx: ContextBundle, ledger: Ledger): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  return [
    { type: "text", text: SYSTEM_PREAMBLE },
    {
      type: "text",
      text: `<org_context source="${ctx.source}">\n${ctx.text || "(no org context available; rely on general B2B cold-email best practice and say so in the rationale)"}\n</org_context>`,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: `<learnings_from_measured_changes>\n${learningsForPrompt(ledger)}\n</learnings_from_measured_changes>` },
  ];
}

export function buildCampaignMessage(snap: CampaignSnapshot, ev: Evaluation): string {
  const docs = (snap.full?.documents ?? []).filter((d) => ["emails", "email_prompt", "step_catalog", "campaign_brief", "messaging_objections"].includes(d.file_type));
  const docText = docs.map((d) => `<document id="${d.id}" type="${d.file_type}" name="${d.display_name}">\n${d.content.slice(0, 9000)}\n</document>`).join("\n\n");
  const seq = snap.full?.sequence?.steps ?? [];
  const catalog = snap.full?.step_catalog?.steps ?? {};
  const seqText = seq
    .map((s) => {
      const c = catalog[s.step_id];
      return `${s.step_id}: day ${s.day}, stop_on_reply=${s.stop_on_reply}${c ? `, name="${c.name}", channel=${c.channel}, cta=${c.cta_type ?? "-"}, max_words=${c.constraints?.max_words ?? "-"}` : ""}`;
    })
    .join("\n");
  const replies = snap.replies
    .slice(0, 30)
    .map((r) => `<reply thread_id="${r.id}" from="${r.contact?.name ?? "?"} <${r.contact?.email ?? "?"}>" title="${r.contact?.title ?? ""}">${(r.preview ?? r.subject ?? "").slice(0, 500)}</reply>`)
    .join("\n");
  const linked = snap.full?.linked_sequences?.map((s) => s.sequence_id ?? s.id).filter(Boolean).join(",") ?? "";
  return [
    `<campaign id="${snap.campaign.id}" name="${snap.campaign.name}" status="${snap.campaign.status}" linked_sequence_ids="${linked}"${ev.simulated ? ' simulated="true"' : ""}>`,
    `goal: ${snap.campaign.goal ?? "-"}\ntarget_persona: ${snap.campaign.target_persona ?? "-"}\nprimary_hook: ${snap.campaign.primary_hook ?? "-"}`,
    `<evaluation>\n${JSON.stringify({ grade: ev.grade, verdict: ev.verdict, metrics: ev.metrics, flags: ev.flags, step_dropoff: ev.step_dropoff }, null, 1)}\n</evaluation>`,
    `<sequence>\n${seqText || "(no sequence attached)"}\n</sequence>`,
    docText ? `<documents>\n${docText}\n</documents>` : "<documents>(no campaign documents available)</documents>",
    `<replies count="${snap.replies.length}">\n${replies || "(no replies in window)"}\n</replies>`,
    `</campaign>`,
    `Analyze this campaign. Return reply classifications, a diagnosis, and up to 5 proposals following the rules.`,
  ].join("\n\n");
}

export interface AnalyzeResult {
  analysis: Analysis;
  replyClasses: Record<string, ReplyClass>;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
}

export async function analyzeCampaign(snap: CampaignSnapshot, ev: Evaluation, ledger: Ledger, ctx = loadContext()): Promise<AnalyzeResult> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: config.anthropicModel,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(AnalysisSchema) },
    system: buildSystemPrompt(ctx, ledger),
    messages: [{ role: "user", content: buildCampaignMessage(snap, ev) }],
  });
  if (response.stop_reason === "refusal") throw new Error(`Model refused: ${response.stop_details?.explanation ?? "no explanation"}`);
  const analysis = response.parsed_output;
  if (!analysis) throw new Error("Model output did not match the analysis schema");
  const replyClasses = Object.fromEntries(analysis.reply_classification.map((r) => [r.thread_id, r.class]));
  const u = response.usage;
  return {
    analysis,
    replyClasses,
    usage: { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 },
  };
}

/** Map a proposal type to the API operation it will use, so the tier is graph8's, not ours. */
export function operationForProposal(type: Proposal["type"]): { operationId: string; tierFallback: Tier } {
  switch (type) {
    case "rewrite_step_copy":
    case "change_subject":
    case "add_reply_branch":
      return { operationId: "update_campaign_document_campaigns__campaign_id__documents__document_id__put", tierFallback: "external" };
    case "change_step_timing":
    case "remove_dead_step":
      return { operationId: "update_campaign_step_campaigns__campaign_id__sequence_steps__step_id__put", tierFallback: "external" };
    case "pause_for_deliverability":
      return { operationId: "pause_sequence_sequences__sequence_id__pause_post", tierFallback: "external" };
    case "narrow_audience":
      return { operationId: "attach_audience_to_campaign_campaigns__campaign_id__audience_put", tierFallback: "external" };
  }
}
