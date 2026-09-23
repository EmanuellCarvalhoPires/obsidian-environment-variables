// Encrypted vault file format (vault.enc).
//
// Version 1 (0.1.0, read-only now): AES-256-GCM, key from PBKDF2-SHA256, no associated data.
// Version 2 (current): same cipher, but
//   - the KDF is named and parameterized through a registry, so memory-hard KDFs
//     (Argon2id via WebAssembly) can be added without changing the file format;
//   - the header (format, version, KDF name/params/salt, cipher, IV) is bound to the
//     ciphertext as AES-GCM associated data, so any edit to the header is detected as
//     tampering. This matters most for future KDFs whose parameters might not all feed
//     into the key.
// Version 1 files are upgraded to version 2 on the next save.
//
// Only the Web Crypto API is used, so the same code runs in Obsidian and in Node tests.

export const VAULT_FORMAT = "environment-variables-vault";
export const VAULT_VERSION = 2;
export const SUPPORTED_VERSIONS = [1, 2];

export type KdfParams = Record<string, number | string>;

/** A key-derivation function that produces an AES-256-GCM key. */
export interface KdfProvider {
  /** Identifier stored in the file, e.g. "PBKDF2-SHA256" or "Argon2id". */
  readonly name: string;
  defaultParams(): KdfParams;
  /** Rejects parameters that are unknown or too weak, before any work is done. */
  validate(params: KdfParams): void;
  deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, params: KdfParams): Promise<CryptoKey>;
}

export interface KdfDescriptor {
  name: string;
  salt: string;
  params: KdfParams;
}

export interface VaultEnvelopeV1 {
  format: typeof VAULT_FORMAT;
  version: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
}

export interface VaultEnvelopeV2 {
  format: typeof VAULT_FORMAT;
  version: 2;
  kdf: KdfDescriptor;
  cipher: { name: "AES-256-GCM"; iv: string };
  data: string;
}

export type VaultEnvelope = VaultEnvelopeV1 | VaultEnvelopeV2;

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong master password or corrupted vault file.");
    this.name = "WrongPasswordError";
  }
}

export class InvalidVaultFileError extends Error {
  constructor(detail: string) {
    super(`Invalid vault file: ${detail}`);
    this.name = "InvalidVaultFileError";
  }
}

export class UnsupportedKdfError extends Error {
  constructor(name: string) {
    super(
      `This vault uses the key-derivation function "${name}", which this version of the plugin does not support. Update the plugin to open it.`,
    );
    this.name = "UnsupportedKdfError";
  }
}

export interface DerivedKey {
  key: CryptoKey;
  kdf: KdfDescriptor;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = crypto;
  if (!c?.subtle) throw new Error("Web Crypto API is not available.");
  return c.subtle;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- KDF registry ----------

export const PBKDF2_MIN_ITERATIONS = 100_000;
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;

export const pbkdf2Sha256: KdfProvider = {
  name: "PBKDF2-SHA256",
  defaultParams: () => ({ iterations: PBKDF2_DEFAULT_ITERATIONS }),
  validate(params) {
    const it = params.iterations;
    if (typeof it !== "number" || !Number.isInteger(it) || it < 1 || it > 10_000_000) {
      throw new InvalidVaultFileError("invalid PBKDF2 iterations");
    }
    const unknown = Object.keys(params).filter((k) => k !== "iterations");
    if (unknown.length) throw new InvalidVaultFileError(`unknown PBKDF2 parameters: ${unknown.join(", ")}`);
  },
  async deriveKey(password, salt, params) {
    const baseKey = await subtle().importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: params.iterations as number },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  },
};

const kdfRegistry = new Map<string, KdfProvider>([[pbkdf2Sha256.name, pbkdf2Sha256]]);

/**
 * Registers another KDF. Intended for a memory-hard KDF such as Argon2id compiled to
 * WebAssembly, e.g. `registerKdf(argon2idProvider)` with params { memoryKiB, iterations, parallelism }.
 * Its deriveKey must return a non-extractable AES-GCM key, e.g. through
 * `crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"])`.
 */
export function registerKdf(provider: KdfProvider): void {
  kdfRegistry.set(provider.name, provider);
}

export function kdfProvider(name: string): KdfProvider {
  const provider = kdfRegistry.get(name);
  if (!provider) throw new UnsupportedKdfError(name);
  return provider;
}

export function availableKdfs(): string[] {
  return [...kdfRegistry.keys()];
}

export const DEFAULT_KDF = pbkdf2Sha256.name;

// ---------- key derivation ----------

export async function deriveKey(
  password: string,
  options: { kdf?: string; params?: KdfParams; salt?: Uint8Array<ArrayBuffer> } = {},
): Promise<DerivedKey> {
  const provider = kdfProvider(options.kdf ?? DEFAULT_KDF);
  const params = options.params ?? provider.defaultParams();
  provider.validate(params);
  const salt = options.salt ?? randomBytes(16);
  const key = await provider.deriveKey(password, salt, params);
  return { key, kdf: { name: provider.name, salt: toBase64(salt), params } };
}

// ---------- associated data ----------

/** Deterministic serialization of the header fields bound to the ciphertext. */
function associatedData(version: number, kdf: KdfDescriptor, iv: string): Uint8Array<ArrayBuffer> {
  const params = Object.keys(kdf.params)
    .sort()
    .map((k) => [k, kdf.params[k]]);
  const header = JSON.stringify([VAULT_FORMAT, version, kdf.name, kdf.salt, params, "AES-256-GCM", iv]);
  return encoder.encode(header);
}

// ---------- encrypt / decrypt ----------

/** Always writes the current version. */
export async function encryptPayload(payload: unknown, derived: DerivedKey): Promise<string> {
  const iv = toBase64(randomBytes(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  try {
    const ciphertext = new Uint8Array(
      await subtle().encrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: associatedData(VAULT_VERSION, derived.kdf, iv) }, derived.key, plaintext),
    );
    const envelope: VaultEnvelopeV2 = {
      format: VAULT_FORMAT,
      version: 2,
      kdf: derived.kdf,
      cipher: { name: "AES-256-GCM", iv },
      data: toBase64(ciphertext),
    };
    return JSON.stringify(envelope, null, 2);
  } finally {
    plaintext.fill(0);
  }
}

export function parseEnvelope(fileText: string): VaultEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new InvalidVaultFileError("not JSON");
  }
  const env = parsed as VaultEnvelope;
  if (env?.format !== VAULT_FORMAT) throw new InvalidVaultFileError("unknown format");
  if (!SUPPORTED_VERSIONS.includes(env.version)) {
    throw new InvalidVaultFileError(`unsupported version ${String((env as { version?: unknown }).version)}. Update the plugin to open it.`);
  }
  if (env.version === 1) {
    if (env.kdf?.name !== "PBKDF2" || env.kdf.hash !== "SHA-256" || env.cipher?.name !== "AES-GCM") {
      throw new InvalidVaultFileError("unsupported algorithm");
    }
  } else if (env.cipher?.name !== "AES-256-GCM" || typeof env.kdf?.name !== "string" || typeof env.kdf.salt !== "string") {
    throw new InvalidVaultFileError("unsupported algorithm");
  }
  return env;
}

export interface DecryptedVault<T> {
  payload: T;
  derived: DerivedKey;
  /** The file was written in an older version and should be saved again. */
  needsUpgrade: boolean;
}

export async function decryptVault<T>(fileText: string, password: string): Promise<DecryptedVault<T>> {
  const env = parseEnvelope(fileText);
  let derived: DerivedKey;
  let params: AesGcmParams;
  if (env.version === 1) {
    derived = await deriveKey(password, { kdf: pbkdf2Sha256.name, params: { iterations: env.kdf.iterations }, salt: fromBase64(env.kdf.salt) });
    params = { name: "AES-GCM", iv: fromBase64(env.cipher.iv) };
  } else {
    derived = await deriveKey(password, { kdf: env.kdf.name, params: env.kdf.params, salt: fromBase64(env.kdf.salt) });
    params = { name: "AES-GCM", iv: fromBase64(env.cipher.iv), additionalData: associatedData(env.version, env.kdf, env.cipher.iv) };
  }
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await subtle().decrypt(params, derived.key, fromBase64(env.data)));
  } catch {
    throw new WrongPasswordError();
  }
  try {
    return { payload: JSON.parse(decoder.decode(plaintext)) as T, derived, needsUpgrade: env.version < VAULT_VERSION };
  } finally {
    plaintext.fill(0);
  }
}

/** Short description for the settings screen, e.g. "v2 · PBKDF2-SHA256 (iterations 600000)". */
export function describeVault(fileText: string): string {
  const env = parseEnvelope(fileText);
  if (env.version === 1) return `v1 · PBKDF2-SHA256 (iterations ${env.kdf.iterations})`;
  const params = Object.entries(env.kdf.params)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `v${env.version} · ${env.kdf.name} (${params})`;
}
