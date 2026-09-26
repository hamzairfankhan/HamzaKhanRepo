/**
 * Thin, typed wrappers over the graph8 SDK's generated `g8.api` client.
 *
 * Every function here maps to one published Developer API operation. We keep the
 * operationId visible so `apply` can record the exact call and so the tier
 * (read / write / billable / external / destructive) comes from graph8's own
 * contract metadata rather than from our guess.
 */
import { g8, type ApiOperationId, type ApiOperationInfo, type G8Contract } from "@graph8/sdk";
import { config } from "../config.js";
import type { CampaignFull, CampaignMetrics, CampaignSummary, InboxThread } from "../types.js";
import type { Tier } from "../ledger.js";

let initialised = false;

export function initG8(): void {
  if (initialised) return;
  if (!config.g8ApiKey) {
    throw new Error(
      "G8_API_KEY is not set. Create one in the hackathon workspace (app.graph8.com → Settings → MCP & API → API) and put it in .env or the environment secrets.",
    );
  }
  g8.init({ apiKey: config.g8ApiKey, apiUrl: config.g8ApiUrl });
  initialised = true;
}

export function opInfo(id: ApiOperationId): ApiOperationInfo {
  initG8();
  return g8.api.operation(id);
}

export function tierOf(id: ApiOperationId): Tier {
  const t = opInfo(id).tier;
  return (t as Tier | null) ?? "unknown";
}

/** Retry on transient failures; the SDK already retries some, this covers the rest. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const status = (e as { status?: number }).status;
      if (status && status < 500 && status !== 429) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

// ------------------------------------------------------------------ reads

export const OPS = {
  listCampaigns: "list_campaigns_campaigns_get",
  getCampaignFull: "get_campaign_full_campaigns__campaign_id__full_get",
  getCampaignMetrics: "get_campaign_metrics_campaigns__campaign_id__metrics_get",
  getEmailByStep: "get_email_by_step_analytics_outbound_email_metrics_by_step_get",
  listInbox: "list_inbox_inbox_get",
  getSafeToSend: "get_safe_to_send_deliverability_safe_to_send_get",
  listDegradedMailboxes: "list_degraded_mailboxes_deliverability_degraded_get",
  getSequencesHealth: "get_sequences_health_deliverability_sequences_health_get",
  updateCampaignDocument: "update_campaign_document_campaigns__campaign_id__documents__document_id__put",
  updateCampaignStep: "update_campaign_step_campaigns__campaign_id__sequence_steps__step_id__put",
  updateCampaignSequence: "update_campaign_sequence_campaigns__campaign_id__sequence_put",
  pauseSequence: "pause_sequence_sequences__sequence_id__pause_post",
} as const satisfies Record<string, ApiOperationId>;

export async function listCampaigns(): Promise<CampaignSummary[]> {
  initG8();
  const out: CampaignSummary[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await withRetry(() => g8.api.gtmCampaigns.listCampaigns({ query: { page, limit: 50 } }));
    const rows = (res.data ?? []) as unknown as CampaignSummary[];
    out.push(...rows);
    const more = (res as { has_next?: boolean }).has_next ?? (res.pagination as { has_next?: boolean } | null | undefined)?.has_next;
    if (!more || rows.length === 0) break;
  }
  return out;
}

export async function getCampaignFull(campaignId: string): Promise<CampaignFull> {
  initG8();
  const res = await withRetry(() => g8.api.gtmCampaigns.getCampaignFull({ path: { campaign_id: campaignId } }));
  return res.data as unknown as CampaignFull;
}

export async function getCampaignMetrics(campaignId: string, days = 90): Promise<CampaignMetrics> {
  initG8();
  const res = await withRetry(() => g8.api.gtmCampaigns.getCampaignMetrics({ path: { campaign_id: campaignId }, query: { days } }));
  return res.data as unknown as CampaignMetrics;
}

export async function getEmailByStep(sequenceId?: string, days = 90): Promise<Record<string, unknown>> {
  initG8();
  const res = await withRetry(() => g8.api.analytics.getEmailByStep({ query: { days, sequence_id: sequenceId ?? null } }));
  return res.data as Record<string, unknown>;
}

export async function listInbox(params: { sequenceId?: string; pageSize?: number } = {}): Promise<InboxThread[]> {
  initG8();
  const res = await withRetry(() =>
    g8.api.inbox.listInbox({ query: { channel: "email", sequence_id: params.sequenceId ?? null, page: 1, page_size: params.pageSize ?? 100 } }),
  );
  return (res.data ?? []) as unknown as InboxThread[];
}

export async function getDeliverability(): Promise<{ safe: unknown; degraded: unknown; sequencesHealth: unknown }> {
  initG8();
  const settle = async <T,>(p: Promise<T>): Promise<T | { error: string }> =>
    p.catch((e: unknown) => ({ error: String((e as Error).message ?? e) }));
  const [safe, degraded, sequencesHealth] = await Promise.all([
    settle(g8.api.deliverability.getSafeToSend().then((r) => r.data)),
    settle(g8.api.deliverability.listDegradedMailboxes().then((r) => r.data)),
    settle(g8.api.deliverability.getSequencesHealth().then((r) => r.data)),
  ]);
  return { safe, degraded, sequencesHealth };
}

export async function getGlobalContextDocs(): Promise<Array<{ category?: string | null; title: string; content?: string | null }>> {
  initG8();
  // The gtmContext namespace has many document endpoints; the list endpoint returns every doc with content.
  const api = g8.api as unknown as { gtmContext: Record<string, (i?: unknown) => Promise<{ data: unknown }>> };
  const fn = api.gtmContext.listGlobalContextDocuments ?? api.gtmContext.listContextDocuments ?? api.gtmContext.listDocuments;
  if (!fn) return [];
  const res = await fn({ query: { include_content: true, limit: 50 } });
  const data = res.data as { documents?: unknown[] } | unknown[];
  const docs = Array.isArray(data) ? data : (data.documents ?? []);
  return docs as Array<{ category?: string | null; title: string; content?: string | null }>;
}

// ------------------------------------------------------------------ writes (only via apply.ts)

export async function updateCampaignDocument(campaignId: string, documentId: string, body: G8Contract.CampaignDocumentUpdateRequest) {
  initG8();
  return g8.api.gtmCampaigns.updateCampaignDocument({ path: { campaign_id: campaignId, document_id: documentId }, body });
}

export async function updateCampaignStep(campaignId: string, stepId: string, body: G8Contract.UpdateStepRequest) {
  initG8();
  return g8.api.gtmCampaigns.updateCampaignStep({ path: { campaign_id: campaignId, step_id: stepId }, body });
}

export async function pauseSequence(sequenceId: string) {
  initG8();
  return g8.api.call(OPS.pauseSequence, { path: { sequence_id: sequenceId } } as never);
}

// ------------------------------------------------------------------ seeding an empty demo workspace

export async function createCampaign(body: G8Contract.developer_api__interfaces__v1__gtm_campaigns_router__CampaignCreateRequest) {
  initG8();
  const res = await g8.api.gtmCampaigns.createCampaign({ body });
  return res.data as { id?: string; campaign_id?: string } & Record<string, unknown>;
}

export async function createCampaignStep(campaignId: string, body: G8Contract.CreateStepRequest) {
  initG8();
  return (await g8.api.gtmCampaigns.createCampaignStep({ path: { campaign_id: campaignId }, body })).data;
}

export async function createCampaignDocument(campaignId: string, body: G8Contract.CampaignDocumentCreateRequest) {
  initG8();
  return (await g8.api.gtmCampaigns.createCampaignDocument({ path: { campaign_id: campaignId }, body })).data;
}
