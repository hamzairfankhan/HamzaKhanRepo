/**
 * Runtime configuration. Every threshold used by the evaluator lives here so an
 * explanation can cite the exact number that fired a flag.
 */
import "dotenv/config";
import path from "node:path";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : Number(v);
};

export const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

export const config = {
  g8ApiKey: process.env.G8_API_KEY ?? "",
  g8ApiUrl: process.env.G8_API_URL ?? "https://be.graph8.com",
  anthropicModel: process.env.AUTOPILOT_MODEL ?? "claude-opus-5",
  autopilotMode: (process.env.AUTOPILOT_MODE ?? "manual") as "manual" | "tiered",
  dataDir: path.join(REPO_ROOT, "data"),
  contextDir: path.join(REPO_ROOT, "docs", "context"),

  thresholds: {
    /** Below this many delivered emails we withhold a grade ("not enough data"). */
    minDelivered: num("AUTOPILOT_MIN_DELIVERED", 100),
    /** reply_rate (replied / delivered), in percent. */
    goodReplyRatePct: num("AUTOPILOT_GOOD_REPLY_PCT", 2.0),
    poorReplyRatePct: num("AUTOPILOT_POOR_REPLY_PCT", 0.5),
    /** positive replies / delivered, in percent; the north-star for grade A. */
    goodPositiveReplyRatePct: num("AUTOPILOT_GOOD_POSITIVE_PCT", 1.0),
    /** bounced / sent, in percent. Above this a domain starts losing reputation. */
    maxBounceRatePct: num("AUTOPILOT_MAX_BOUNCE_PCT", 3.0),
    /** Days without a dispatched email while status is active. */
    staleDays: num("AUTOPILOT_STALE_DAYS", 14),
    /** Share of classified replies that are positive, below which reply quality is poor. */
    minPositiveShare: num("AUTOPILOT_MIN_POSITIVE_SHARE", 0.2),
    minClassifiedReplies: num("AUTOPILOT_MIN_CLASSIFIED", 5),
    /** A step with at least this many sends and zero replies is "dead" if another step replies. */
    deadStepMinSends: num("AUTOPILOT_DEAD_STEP_SENDS", 200),
    /** Autopilot (tiered mode) auto-applies write-tier proposals at or above this confidence. */
    autoApplyConfidence: num("AUTOPILOT_AUTO_CONFIDENCE", 0.8),
  },
} as const;

export type Thresholds = typeof config.thresholds;
