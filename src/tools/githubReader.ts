// Real GithubReader: reads a public repo's raw files over HTTP. Used to fetch downloadable
// MCP packages (see mcpCatalog.ts). Uses requestUrl(), never fetch(), so it works the same
// way on desktop and mobile and is not subject to the page's CORS policy.

import { requestUrl } from "obsidian";
import { GithubReader } from "./mcpCatalog";

/** Reads raw files from `baseUrl` (e.g. a raw.githubusercontent.com/<user>/<repo>/<branch> URL). */
export class HttpGithubReader implements GithubReader {
  constructor(private readonly baseUrl: string) {}

  async fetchText(path: string): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/${path}`;
    const response = await requestUrl({ url, throw: false });
    if (response.status < 200 || response.status >= 300) throw new Error(`${response.status} fetching ${path}`);
    return response.text;
  }
}
