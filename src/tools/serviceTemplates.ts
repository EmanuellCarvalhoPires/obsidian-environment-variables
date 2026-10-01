// Instance (service note) templates bundled with the plugin: one per service the catalog's
// packages use. They are created once, the first time the plugin loads, so the user only has
// to duplicate one and fill it in. A template the user deletes is not created again.

import atlassianEn from "./templates/atlassian.en.md";
import atlassianPt from "./templates/atlassian.pt.md";
import bitbucketEn from "./templates/bitbucket.en.md";
import bitbucketPt from "./templates/bitbucket.pt.md";
import trelloEn from "./templates/trello.en.md";
import trelloPt from "./templates/trello.pt.md";
import { hasTag, VaultNote } from "./types";

export type TemplateLanguage = "en" | "pt";

export interface ServiceTemplate {
  id: string;
  /** The service_tag the tools pick an instance through. */
  serviceTag: string;
  fileName: string;
  content: Record<TemplateLanguage, string>;
}

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  { id: "atlassian", serviceTag: "atlassian/instance", fileName: "Atlassian Access - Template.md", content: { en: atlassianEn, pt: atlassianPt } },
  { id: "bitbucket", serviceTag: "bitbucket/workspace", fileName: "Bitbucket Access - Template.md", content: { en: bitbucketEn, pt: bitbucketPt } },
  { id: "trello", serviceTag: "trello/account", fileName: "Trello Access - Template.md", content: { en: trelloEn, pt: trelloPt } },
];

export function serviceTemplateFor(serviceTag: string): ServiceTemplate | undefined {
  return SERVICE_TEMPLATES.find((t) => t.serviceTag === serviceTag);
}

/**
 * The templates still to create: never created before, and the vault has no template note
 * (tag `template`) for that service yet. `notesOf` returns the notes with a given tag.
 */
export function templatesToCreate(created: string[], notesOf: (tag: string) => VaultNote[]): ServiceTemplate[] {
  return SERVICE_TEMPLATES.filter((t) => !created.includes(t.id) && !notesOf(t.serviceTag).some((n) => hasTag(n.tags, "template")));
}

/** The files may come with Windows line endings (git autocrlf); notes always use \n. */
export function templateText(template: ServiceTemplate, lang: TemplateLanguage): string {
  return template.content[lang].replace(/\r\n?/g, "\n");
}
