// Saves masked HTTP responses to files in the vault.

export interface ResponseWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  /** Folder for the saved files, built from Vault#configDir by the host. */
  dir?: string;
}

export const SAVED_RESPONSES_DIR = "plugins/environment-variables/respostas";

export interface SavedResponseResult {
  saved_to: string;
  bytes: number;
  top_keys: string[] | null;
}

export async function saveResponse(
  writer: ResponseWriter,
  maskedBody: string,
  id: string,
): Promise<SavedResponseResult> {
  const dir = writer.dir ?? SAVED_RESPONSES_DIR;
  const saved_to = `${dir}/${id}.json`;
  const bytes = new TextEncoder().encode(maskedBody).length;

  let top_keys: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(maskedBody);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      top_keys = Object.keys(parsed);
    }
  } catch {
    top_keys = null;
  }

  if (!(await writer.exists(dir))) {
    await writer.mkdir(dir);
  }

  await writer.write(saved_to, maskedBody);

  return { saved_to, bytes, top_keys };
}
