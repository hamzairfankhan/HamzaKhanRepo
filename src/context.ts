/**
 * Org context that grounds the analyzer: brand voice and compliance rules,
 * messaging, audience/personas, offer and proof.
 *
 * Source order: the demo workspace's own GTM context documents (via the API)
 * when present, otherwise the condensed docs in docs/context/*.md. The result
 * is a stable string so the Anthropic prompt cache can reuse it across campaigns.
 */
import fs from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "./config.js";

export interface ContextBundle {
  source: "workspace" | "fallback" | "none";
  text: string;
  sections: Record<string, string>;
}

const ORDER = ["brand", "messaging", "audience", "offer", "market", "campaign_brief"];

/** Raw reference docs (reference/context/<category>.json) when no condensed markdown exists. */
function loadReferenceContextJson(): Record<string, string> {
  const dir = path.join(REPO_ROOT, "reference", "context");
  const sections: Record<string, string> = {};
  if (!fs.existsSync(dir)) return sections;
  for (const name of ["brand", "messaging", "audience", "offer", "market", "campaign"]) {
    const p = path.join(dir, `${name}.json`);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { result?: { documents?: Array<{ title: string; content?: string | null }> } };
    const docs = j.result?.documents ?? [];
    // Cap each document so every doc in a category (e.g. Compliance Rules next to Brand Voice) survives truncation.
    const perDoc = 5_000;
    const text = docs
      .filter((d) => d.content)
      .map((d) => {
        const body = (d.content ?? "").trim();
        return `### ${d.title}\n${body.length > perDoc ? body.slice(0, perDoc) + "\n[...truncated]" : body}`;
      })
      .join("\n\n");
    if (text) sections[name === "campaign" ? "campaign_brief" : name] = text;
  }
  return sections;
}

export function loadFallbackContext(dir = config.contextDir): ContextBundle {
  let sections: Record<string, string> = {};
  if (fs.existsSync(dir)) {
    for (const name of ORDER) {
      const p = path.join(dir, `${name}.md`);
      if (fs.existsSync(p)) sections[name] = fs.readFileSync(p, "utf8");
    }
  }
  if (!Object.keys(sections).length) sections = loadReferenceContextJson();
  const text = ORDER.filter((k) => sections[k]).map((k) => `<${k}>\n${sections[k].trim()}\n</${k}>`).join("\n\n");
  return { source: Object.keys(sections).length ? "fallback" : "none", text, sections };
}

/** Build a bundle from workspace documents fetched by the client (title + content). */
export function bundleFromWorkspaceDocs(docs: Array<{ category?: string | null; title: string; content?: string | null }>): ContextBundle | null {
  const byCat: Record<string, string[]> = {};
  for (const d of docs) {
    if (!d.content) continue;
    const cat = (d.category ?? "other").toLowerCase();
    (byCat[cat] ??= []).push(`### ${d.title}\n${d.content.trim()}`);
  }
  const keys = Object.keys(byCat);
  if (!keys.length) return null;
  const sections = Object.fromEntries(keys.map((k) => [k, byCat[k].join("\n\n")]));
  const text = keys.map((k) => `<${k}>\n${sections[k]}\n</${k}>`).join("\n\n");
  return { source: "workspace", text, sections };
}

/** Keep the prompt bounded; long docs are truncated per section, not dropped. */
export function truncateBundle(b: ContextBundle, maxCharsPerSection = 30_000): ContextBundle {
  const sections = Object.fromEntries(
    Object.entries(b.sections).map(([k, v]) => [k, v.length > maxCharsPerSection ? v.slice(0, maxCharsPerSection) + "\n[...truncated]" : v]),
  );
  const text = Object.keys(sections).map((k) => `<${k}>\n${sections[k]}\n</${k}>`).join("\n\n");
  return { ...b, sections, text };
}
