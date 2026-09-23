import { SecretStore, VaultIO } from "../src/store/secretStore";
import { SecretInput } from "../src/store/secretStore";

export class MemoryIO implements VaultIO {
  content: string | null = null;
  async read() {
    return this.content;
  }
  async write(c: string) {
    this.content = c;
  }
}

export const PASSWORD = "correct horse battery staple";

export async function unlockedStore(): Promise<{ store: SecretStore; io: MemoryIO }> {
  const io = new MemoryIO();
  const store = new SecretStore(io, { iterations: 1000 });
  await store.create(PASSWORD);
  return { store, io };
}

export function secretInput(overrides: Partial<SecretInput> = {}): SecretInput {
  return {
    name: "JIRA_ACME",
    type: "basic",
    username: "bot@acme.com",
    value: "ATATT3xFfGF0-super-secret-token-value",
    description: "Jira ACME",
    allowedHosts: ["acme.atlassian.net"],
    allowHttpLocalhost: false,
    placement: { headers: true, url: false, body: false },
    approval: "never",
    ...overrides,
  };
}
