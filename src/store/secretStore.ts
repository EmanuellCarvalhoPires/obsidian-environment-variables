import { decryptVault, deriveKey, DerivedKey, DEFAULT_KDF, encryptPayload, KdfParams, kdfProvider } from "../crypto/vaultFile";
import { SECRET_NAME_PATTERN, SecretRecord, VaultPayload } from "./types";

/** Where the encrypted file lives. The plugin uses the vault adapter; tests use memory. */
export interface VaultIO {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

export class VaultLockedError extends Error {
  constructor() {
    super("The vault is locked. Unlock it in Obsidian (Environment Variables panel).");
    this.name = "VaultLockedError";
  }
}

export const MIN_PASSWORD_LENGTH = 12;

export type SecretInput = Omit<SecretRecord, "id" | "createdAt" | "updatedAt" | "lastUsedAt">;

type Listener = () => void;

export class SecretStore {
  private derived: DerivedKey | null = null;
  private secrets: SecretRecord[] = [];
  private listeners = new Set<Listener>();

  /**
   * @param kdf KDF used for new vaults and password changes (existing files keep theirs until then).
   * @param kdfParams Override the KDF defaults (tests use a low PBKDF2 iteration count).
   */
  constructor(
    private readonly io: VaultIO,
    private readonly kdfParams?: KdfParams,
    private readonly kdf: string = DEFAULT_KDF,
  ) {}

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  get isUnlocked(): boolean {
    return this.derived !== null;
  }

  async exists(): Promise<boolean> {
    return (await this.io.read()) !== null;
  }

  async create(password: string): Promise<void> {
    if (await this.exists()) throw new Error("A vault already exists.");
    assertPassword(password);
    this.derived = await deriveKey(password, this.kdfOptions());
    this.secrets = [];
    await this.persist();
    this.emit();
  }

  async unlock(password: string): Promise<void> {
    const text = await this.io.read();
    if (text === null) throw new Error("No vault exists yet.");
    const { payload, derived, needsUpgrade } = await decryptVault<VaultPayload>(text, password);
    this.derived = derived;
    this.secrets = Array.isArray(payload.secrets) ? payload.secrets : [];
    // Re-save older files in the current format (same key, new header bound to the ciphertext).
    if (needsUpgrade) await this.persist();
    this.emit();
  }

  /**
   * Drops the key and wipes the in-memory records.
   * JavaScript strings are immutable, so the old value strings cannot be overwritten in place:
   * this removes every reference the plugin holds (records, array slots, the key) so they can be
   * garbage-collected, and blanks the fields of record objects other code may still reference.
   * Decrypted and encrypted plaintext buffers are zeroed in vaultFile.ts.
   */
  lock(): void {
    if (!this.derived) return;
    this.derived = null;
    for (const s of this.secrets) {
      s.value = "";
      s.username = undefined;
      s.description = "";
      s.allowedHosts.length = 0;
    }
    this.secrets.length = 0;
    this.secrets = [];
    this.emit();
  }

  async changePassword(current: string, next: string): Promise<void> {
    const text = await this.io.read();
    if (text === null) throw new Error("No vault exists yet.");
    await decryptVault<VaultPayload>(text, current); // throws WrongPasswordError
    assertPassword(next);
    this.derived = await deriveKey(next, this.kdfOptions());
    await this.persist();
    this.emit();
  }

  list(): SecretRecord[] {
    this.assertUnlocked();
    return [...this.secrets].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Names only; empty when locked. Used by the editor autocomplete. */
  names(): string[] {
    return this.isUnlocked ? this.secrets.map((s) => s.name).sort() : [];
  }

  get(name: string): SecretRecord | undefined {
    this.assertUnlocked();
    return this.secrets.find((s) => s.name === name);
  }

  async add(input: SecretInput): Promise<SecretRecord> {
    this.assertUnlocked();
    validateInput(input);
    if (this.secrets.some((s) => s.name === input.name)) throw new Error(`A variable named ${input.name} already exists.`);
    const now = new Date().toISOString();
    const record: SecretRecord = { ...input, id: newId(), createdAt: now, updatedAt: now };
    this.secrets.push(record);
    await this.persist();
    this.emit();
    return record;
  }

  /** Updates a secret. Omit `value` in the patch to keep the current value. */
  async update(id: string, patch: Partial<SecretInput>): Promise<SecretRecord> {
    this.assertUnlocked();
    const index = this.secrets.findIndex((s) => s.id === id);
    if (index < 0) throw new Error("Variable not found.");
    const current = this.secrets[index];
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: SecretRecord = { ...current, ...defined, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    validateInput(next);
    if (this.secrets.some((s) => s.id !== id && s.name === next.name)) throw new Error(`A variable named ${next.name} already exists.`);
    this.secrets[index] = next;
    if (current.value !== next.value) current.value = ""; // drop the old value from the replaced record
    await this.persist();
    this.emit();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.assertUnlocked();
    for (const s of this.secrets) if (s.id === id) s.value = "";
    this.secrets = this.secrets.filter((s) => s.id !== id);
    await this.persist();
    this.emit();
  }

  async markUsed(names: string[]): Promise<void> {
    if (!this.isUnlocked || names.length === 0) return;
    const now = new Date().toISOString();
    for (const s of this.secrets) if (names.includes(s.name)) s.lastUsedAt = now;
    await this.persist();
  }

  /** Name of the KDF protecting the open vault, e.g. "PBKDF2-SHA256". */
  get kdfName(): string | null {
    return this.derived?.kdf.name ?? null;
  }

  private kdfOptions(): { kdf: string; params?: KdfParams } {
    kdfProvider(this.kdf); // fail early if the configured KDF is not registered
    return { kdf: this.kdf, params: this.kdfParams };
  }

  private assertUnlocked(): void {
    if (!this.derived) throw new VaultLockedError();
  }

  private async persist(): Promise<void> {
    if (!this.derived) throw new VaultLockedError();
    const payload: VaultPayload = { secrets: this.secrets };
    await this.io.write(await encryptPayload(payload, this.derived));
  }
}

export function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The master password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

/** 0 (weak) to 4 (strong). A simple heuristic for the UI meter. */
export function passwordStrength(password: string): number {
  if (password.length < MIN_PASSWORD_LENGTH) return 0;
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^A-Za-z0-9]/.test(password)) classes++;
  let score = classes >= 3 ? 2 : 1;
  if (password.length >= 16) score++;
  if (password.length >= 20 && classes >= 3) score++;
  return Math.min(score, 4);
}

function validateInput(input: SecretInput): void {
  if (!SECRET_NAME_PATTERN.test(input.name)) {
    throw new Error("Name must start with a letter or underscore and contain only letters, digits and underscore (max 64).");
  }
  if (!input.value) throw new Error("The value cannot be empty.");
  if (input.type === "basic" && !input.username) throw new Error("The basic type needs a username or e-mail.");
}

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
