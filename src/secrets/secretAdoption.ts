import { AuditLog } from "../audit/auditLog";
import { AIEcosystemAPI } from "../ecosystem/moduleConnector";
import { findPlaceholders } from "./placeholders";
import { SecretVaultService } from "./secretVaultService";

export interface PlaintextSecretCandidate {
  field: string;
  suggestedName: string;
  allowedHosts: string[];
  value: string;
}

/**
 * Contract implemented by plugins (e.g. `telegram-ai-gateway`) that register a
 * `secret-holder:<moduleId>` service on the AI Ecosystem Service Bus so Environment Keys
 * can adopt plaintext tokens into the encrypted secret vault.
 */
export interface SecretHolderService {
  inspectPlaintextSecrets?: () => PlaintextSecretCandidate[] | Promise<PlaintextSecretCandidate[]>;
  listPlaintextSecrets?: () => PlaintextSecretCandidate[] | Promise<PlaintextSecretCandidate[]>;
  replaceWithPlaceholder(field: string, placeholder: string): Promise<void>;
}

export type SecretHolder = SecretHolderService;

export interface AdoptedSecretNotice {
  ownerModuleId: string;
  field: string;
  secretName?: string;
  placeholder: string;
}

export interface SecretAdoptionCoordinatorOptions {
  service: SecretVaultService;
  audit?: AuditLog;
  isUnlocked?: () => boolean;
  onAdopted?: (adopted: AdoptedSecretNotice) => void;
}

export const SECRET_HOLDER_PREFIX = "secret-holder:";

const DEFAULT_KNOWN_HOLDER_SERVICES = [
  "secret-holder:telegram-ai-gateway",
];

/**
 * Watches `secret-holder:<id>` services on the AI Ecosystem Service Bus and migrates
 * any plaintext tokens into the encrypted vault as soon as the vault is unlocked.
 */
export class SecretAdoptionCoordinator {
  private readonly trackedServices = new Set<string>(DEFAULT_KNOWN_HOLDER_SERVICES);

  constructor(private readonly options: SecretAdoptionCoordinatorOptions) {}

  private isUnlocked(): boolean {
    if (this.options.isUnlocked) return this.options.isUnlocked();
    return !this.options.service.isLocked();
  }

  /** Inspects a single `secret-holder:<id>` service and adopts any plaintext tokens if the vault is unlocked. */
  async inspectService(api: Pick<AIEcosystemAPI, "getService">, serviceName: string): Promise<number> {
    if (!serviceName.startsWith(SECRET_HOLDER_PREFIX)) return 0;
    this.trackedServices.add(serviceName);
    if (!this.isUnlocked()) return 0;

    const holder = api.getService<SecretHolderService>(serviceName);
    if (!holder || typeof holder.replaceWithPlaceholder !== "function") return 0;
    const listFn = holder.inspectPlaintextSecrets ?? holder.listPlaintextSecrets;
    if (typeof listFn !== "function") return 0;

    const ownerModuleId = serviceName.slice(SECRET_HOLDER_PREFIX.length) || "external-plugin";
    let items: PlaintextSecretCandidate[];
    try {
      items = await listFn.call(holder);
    } catch {
      return 0;
    }
    if (!Array.isArray(items)) return 0;

    let count = 0;
    for (const item of items) {
      if (!this.isUnlocked()) break;
      const rawValue = typeof item?.value === "string" ? item.value.trim() : "";
      if (!rawValue) continue;
      const existingPlaceholders = findPlaceholders(rawValue);
      if (existingPlaceholders.length > 0 && existingPlaceholders[0].raw === rawValue) continue;

      try {
        const { placeholder } = await this.options.service.adoptPlaintextSecret({
          ownerModuleId,
          field: item.field,
          suggestedName: item.suggestedName,
          allowedHosts: Array.isArray(item.allowedHosts) ? item.allowedHosts : [],
          value: rawValue,
        });
        await holder.replaceWithPlaceholder(item.field, placeholder);
        count++;
        this.options.onAdopted?.({
          ownerModuleId,
          field: item.field,
          placeholder,
        });
      } catch {
        // Continue with remaining items if one adoption fails.
      }
    }
    return count;
  }

  /** Scans all known `secret-holder:*` services and adopts plaintext secrets if the vault is unlocked. */
  async scanAll(api: Pick<AIEcosystemAPI, "getService">, discoveredServices: string[] = []): Promise<number> {
    for (const extra of discoveredServices) {
      if (extra.startsWith(SECRET_HOLDER_PREFIX)) {
        this.trackedServices.add(extra);
      }
    }
    if (!this.isUnlocked()) return 0;
    let total = 0;
    for (const serviceName of [...this.trackedServices]) {
      total += await this.inspectService(api, serviceName);
    }
    return total;
  }
}
