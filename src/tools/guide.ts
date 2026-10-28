// The prompt for AI agents: how vault tools work and the mandatory workflow
// (survey, ask the user, write an implementation plan, wait for approval, implement, validate).
// The prompt is generic on purpose: it names no vault, folder, tag, server or tool of the user,
// so it works on any computer. The agent finds those out with list_vault_tools and list_secrets.
// The prompt is the template guide/setup.<lang>.md; %GUIDE% is the shared reference
// (guide/guide.<lang>.md) and %REQUEST% the user's request, when there is one.

import en from "./guide/guide.en.md";
import pt from "./guide/guide.pt.md";
import setupEn from "./guide/setup.en.md";
import setupPt from "./guide/setup.pt.md";
import { ToolError } from "./types";

export type GuideLanguage = "en" | "pt";

export interface GuideTopic {
  slug: string;
  title: string;
  content: string;
}

const TEMPLATES: Record<GuideLanguage, string> = { en: setupEn, pt: setupPt };

const REQUEST_TITLE: Record<GuideLanguage, string> = { en: "## The user's request", pt: "## Pedido do usuário" };

/** The files may come with Windows line endings (git autocrlf); the prompt always uses \n. */
const lf = (text: string) => text.replace(/\r\n?/g, "\n");

export function buildGuide(lang: GuideLanguage, request?: string): string {
  const text = request?.trim();
  const requestSection = text ? `${REQUEST_TITLE[lang]}\n\n${text}\n\n` : "";
  return (
    lf(TEMPLATES[lang])
      .split("%GUIDE%\n").join(`${lf(lang === "pt" ? pt : en).trimEnd()}\n\n`)
      .split("%REQUEST%\n").join(requestSection)
      .trimEnd() + "\n"
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function parseTopicsFromMarkdown(markdown: string): GuideTopic[] {
  const lines = lf(markdown).split("\n");
  const topics: GuideTopic[] = [];
  let currentSlug = "";
  let currentTitle = "";
  let currentLines: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    if (currentSlug) {
      topics.push({
        slug: currentSlug,
        title: currentTitle,
        content: currentLines.join("\n").trimEnd() + "\n",
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (currentSlug) {
        currentLines.push(line);
      }
      continue;
    }

    if (!inCodeFence && line.startsWith("## ")) {
      flush();
      const rawHeader = line.slice(3).trim();
      const anchorMatch = rawHeader.match(/\{#([a-z0-9-]+)\}/i) || rawHeader.match(/<!--\s*slug:\s*([a-z0-9-]+)\s*-->/i);
      const titleWithoutAnchor = anchorMatch ? rawHeader.replace(anchorMatch[0], "").trim() : rawHeader;
      currentTitle = titleWithoutAnchor.replace(/^\d+\.\s*/, "").trim();
      currentSlug = anchorMatch ? anchorMatch[1].toLowerCase() : slugify(currentTitle);
      currentLines.push(line);
      continue;
    }

    if (currentSlug) {
      currentLines.push(line);
    }
  }

  flush();
  return topics;
}

/** Lists all guide topics parsed from the '## ' section headers. */
export function guideTopics(lang: GuideLanguage): GuideTopic[] {
  return parseTopicsFromMarkdown(buildGuide(lang));
}

/** Returns the content of a single guide topic by its slug, or throws an error listing valid slugs. */
export function guideTopic(lang: GuideLanguage, slug: string): string {
  const normalized = slug.trim().toLowerCase();
  const topics = guideTopics(lang);
  const found = topics.find((t) => t.slug === normalized);
  if (!found) {
    const valid = topics.map((t) => t.slug).join(", ");
    throw new ToolError("invalid_argument", `Unknown guide topic "${slug}". Valid topics: ${valid}`);
  }
  return found.content;
}

/** Generates a short index (under ~1,500 characters) with title, slug and reading instructions. */
export function guideIndex(lang: GuideLanguage): string {
  const topics = guideTopics(lang);
  const header = lang === "pt" ? "# Guia de Autoria de Ferramentas" : "# Tool Authoring Guide";
  const lines = [
    header,
    "",
    "Pass topic: <slug> to read a section.",
    "",
    ...topics.map((t) => `- **${t.title}** (\`${t.slug}\`)`),
  ];
  return lines.join("\n") + "\n";
}
