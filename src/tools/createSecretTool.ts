// env_criar_secret: lets an AI agent ask the USER to create a secret.
// The agent only suggests a name, a type, hosts and a description. The user types the value in the
// same form as the panel's "New variable" (SecretModal, create-only mode), so the value never passes
// through the agent, the audit log or the activity feed. The tool only creates: it never changes or
// overwrites a secret or a value. It answers with a short status line and nothing else.

import { AuditLog } from "../audit/auditLog";
import { HubCallContext, HubTool, HubToolResult } from "../ecosystem/moduleConnector";
import { isValidPattern } from "../secrets/hosts";
import { SECRET_NAME_PATTERN, SecretType } from "../store/types";

export const CREATE_SECRET_TOOL_NAME = "env_criar_secret";

/** How long the screen waits for the user before it closes by itself. */
export const CREATE_SECRET_TIMEOUT_MS = 5 * 60 * 1000;

const SUGGESTION_TYPES: SecretType[] = ["token", "basic", "bearer", "header", "env"];
const ALLOWED_ARGUMENTS = new Set(["nome_sugerido", "tipo_sugerido", "dominios_sugeridos", "descricao"]);
const MAX_SUGGESTED_HOSTS = 10;
const MAX_DESCRIPTION_LENGTH = 300;

export const CREATE_SECRET_TOOL = {
  name: CREATE_SECRET_TOOL_NAME,
  title: "Ask the user to create a secret",
  description:
    "Opens, in Obsidian, the screen where the USER creates a secret (the same form as New variable). " +
    "You only suggest the name, the type, the hosts and a description: the user types the value, and you never receive it. " +
    "This tool only creates: it never changes or overwrites an existing secret or value, and the suggestions never turn on Full access or Any host. " +
    "It waits up to 5 minutes and returns only 'Secret NAME criada', 'cancelado' or 'expirado'. " +
    "Then use the name in {{secret:NAME}} placeholders. Call list_secrets first: if the name already exists, pick another one.",
  inputSchema: {
    type: "object" as const,
    properties: {
      nome_sugerido: { type: "string", description: "Suggested name, e.g. JIRA_ACME. Letters, digits and underscore." },
      tipo_sugerido: { type: "string", enum: SUGGESTION_TYPES, description: "Suggested type of the secret. Default: token." },
      dominios_sugeridos: {
        type: "array",
        items: { type: "string" },
        description: "Hosts where the secret may be sent, e.g. [\"acme.atlassian.net\"]. Use the exact API host, never a wildcard on a public suffix.",
      },
      descricao: { type: "string", description: "What the secret is for, shown to the user." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

/** What the form starts with. Full access and Any host are never part of it: they stay off. */
export interface CreateSecretPrefill {
  name: string;
  type: SecretType;
  description: string;
  allowedHosts: string[];
}

/** An open form: `result` is the name of the secret created, or null when the user closed it without saving. */
export interface CreateSecretScreen {
  result: Promise<string | null>;
  close(): void;
}

export interface CreateSecretDeps {
  isUnlocked(): boolean;
  /** Opens the create-only form (SecretModal) with the suggestions. */
  openScreen(prefill: CreateSecretPrefill): CreateSecretScreen;
  /** Hosts saved by the guided set-up, used when the agent suggests none. They are only a starting point in the form. */
  suggestedHosts?: () => string[];
  audit?: AuditLog;
  timeoutMs?: number;
}

export interface CreateSecretCall {
  /** Name of the AI client, for the audit log. */
  client: string;
  /** Aborts when the client cancels the call or disconnects. */
  signal?: AbortSignal;
}

/**
 * The tool as AI Ecosystem registers it. It stays visible while the module waits for its set-up skill,
 * because that skill uses it.
 */
export function createSecretHubTool(deps: CreateSecretDeps & { clientName(ctx: HubCallContext): string; onCall?(): void }): HubTool {
  return {
    ...CREATE_SECRET_TOOL,
    availableDuringSetup: true,
    handler: (args, ctx) => {
      deps.onCall?.();
      return runCreateSecretTool(args, { client: deps.clientName(ctx), signal: ctx.signal }, deps);
    },
  };
}

export async function runCreateSecretTool(args: Record<string, unknown>, call: CreateSecretCall, deps: CreateSecretDeps): Promise<HubToolResult> {
  const { audit } = deps;
  const log = (outcome: "ok" | "denied" | "locked" | "error", secrets: string[], detail: string) =>
    audit?.add({ client: call.client, action: "create", tool: CREATE_SECRET_TOOL_NAME, target: "secret", secrets, outcome, detail });

  const parsed = parseArguments(args);
  if (typeof parsed === "string") {
    log("error", [], "invalid arguments");
    return failure(parsed);
  }

  if (!deps.isUnlocked()) {
    log("locked", [], "vault locked");
    return failure("The secret vault is locked. Ask the user to unlock it in Obsidian (Environment Keys panel), then call this tool again.");
  }
  if (call.signal?.aborted) {
    log("denied", [], "cancelado");
    return text("cancelado");
  }

  const prefill = parsed.allowedHosts.length > 0 ? parsed : { ...parsed, allowedHosts: cleanHosts(deps.suggestedHosts?.() ?? []) };
  const screen = deps.openScreen(prefill);
  const outcome = await waitForUser(screen, call.signal, deps.timeoutMs ?? CREATE_SECRET_TIMEOUT_MS);
  if (outcome.status === "created") {
    log("ok", [outcome.name], "criada");
    return text(`Secret ${outcome.name} criada`);
  }
  log("denied", [], outcome.status);
  return text(outcome.status);
}

type UserOutcome = { status: "created"; name: string } | { status: "cancelado" | "expirado" };

/** First of: the user saves, the user closes the form, the client aborts the call, the time runs out. */
function waitForUser(screen: CreateSecretScreen, signal: AbortSignal | undefined, timeoutMs: number): Promise<UserOutcome> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    const finish = (outcome: UserOutcome, closeScreen: boolean) => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (closeScreen) screen.close();
      resolve(outcome);
    };
    const onAbort = () => finish({ status: "cancelado" }, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => finish({ status: "expirado" }, true), timeoutMs);
    screen.result.then(
      (name) => finish(name === null ? { status: "cancelado" } : { status: "created", name }, false),
      () => finish({ status: "cancelado" }, false),
    );
  });
}

/** The suggestions as form values, or the message to refuse the call. */
function parseArguments(args: Record<string, unknown>): CreateSecretPrefill | string {
  const unknown = Object.keys(args ?? {}).filter((k) => !ALLOWED_ARGUMENTS.has(k));
  if (unknown.length > 0) {
    if (unknown.some((k) => /^(valor|value|secret|token|senha|password)$/i.test(k))) {
      return "This tool never receives the value: the user types it in the screen. Call it again without it, with only nome_sugerido, tipo_sugerido, dominios_sugeridos and descricao.";
    }
    return `Unknown argument: ${unknown.join(", ")}. Accepted: nome_sugerido, tipo_sugerido, dominios_sugeridos, descricao.`;
  }

  const { nome_sugerido: name, tipo_sugerido: type, dominios_sugeridos: hosts, descricao: description } = args;
  if (name !== undefined && typeof name !== "string") return "nome_sugerido must be a string.";
  if (type !== undefined && !SUGGESTION_TYPES.includes(type as SecretType)) return `tipo_sugerido must be one of: ${SUGGESTION_TYPES.join(", ")}.`;
  if (hosts !== undefined && (!Array.isArray(hosts) || hosts.some((h) => typeof h !== "string"))) return "dominios_sugeridos must be a list of strings.";
  if (description !== undefined && typeof description !== "string") return "descricao must be a string.";

  return {
    name: cleanName(name ?? ""),
    type: (type as SecretType | undefined) ?? "token",
    description: (description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH),
    allowedHosts: cleanHosts((hosts as string[] | undefined) ?? []),
  };
}

/** Uppercase letters, digits and underscore; empty when nothing usable is left. */
function cleanName(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  const named = /^[A-Z_]/.test(cleaned) ? cleaned : `SECRET_${cleaned}`;
  const candidate = named.slice(0, 64);
  return SECRET_NAME_PATTERN.test(candidate) ? candidate : "";
}

/** Valid host patterns only (a wildcard on a public suffix is dropped), without duplicates. */
function cleanHosts(hosts: string[]): string[] {
  const out: string[] = [];
  for (const raw of hosts) {
    const host = raw.trim();
    if (host && isValidPattern(host) && !out.includes(host)) out.push(host);
    if (out.length >= MAX_SUGGESTED_HOSTS) break;
  }
  return out;
}

function text(message: string): HubToolResult {
  return { content: [{ type: "text", text: message }] };
}

function failure(message: string): HubToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
