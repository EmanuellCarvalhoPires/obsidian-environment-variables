// The prompts for AI agents: how vault tools work and the mandatory workflow
// (survey, ask the user, write an implementation plan, wait for approval, implement, validate).
// The prompts are generic on purpose: they name no vault, folder, tag, server or tool of the user,
// so they work on any computer. The agent finds those out with list_vault_tools and list_secrets.
// Each prompt is a template in guide/<mode>.<lang>.md; %GUIDE% is the shared reference
// (guide/guide.<lang>.md) and %REQUEST% the user's request, when there is one.

import en from "./guide/guide.en.md";
import pt from "./guide/guide.pt.md";
import multipleEn from "./guide/multiple.en.md";
import multiplePt from "./guide/multiple.pt.md";
import setupEn from "./guide/setup.en.md";
import setupPt from "./guide/setup.pt.md";
import singleEn from "./guide/single.en.md";
import singlePt from "./guide/single.pt.md";

export type GuideLanguage = "en" | "pt";

/** Which prompt: set up the MCP environment, add one tool, or add several tools. */
export type GuideMode = "setup" | "single" | "multiple";

export const GUIDE_MODES: GuideMode[] = ["setup", "single", "multiple"];

const TEMPLATES: Record<GuideMode, Record<GuideLanguage, string>> = {
  setup: { en: setupEn, pt: setupPt },
  single: { en: singleEn, pt: singlePt },
  multiple: { en: multipleEn, pt: multiplePt },
};

const REQUEST_TITLE: Record<GuideLanguage, string> = { en: "## The user's request", pt: "## Pedido do usuário" };

export function isGuideMode(value: unknown): value is GuideMode {
  return typeof value === "string" && (GUIDE_MODES as string[]).includes(value);
}

/** The files may come with Windows line endings (git autocrlf); the prompt always uses \n. */
const lf = (text: string) => text.replace(/\r\n?/g, "\n");

export function buildGuide(lang: GuideLanguage, request?: string, mode: GuideMode = "setup"): string {
  const text = request?.trim();
  const requestSection = text ? `${REQUEST_TITLE[lang]}\n\n${text}\n\n` : "";
  return (
    lf(TEMPLATES[mode][lang])
      .split("%GUIDE%\n").join(`${lf(lang === "pt" ? pt : en).trimEnd()}\n\n`)
      .split("%REQUEST%\n").join(requestSection)
      .trimEnd() + "\n"
  );
}
