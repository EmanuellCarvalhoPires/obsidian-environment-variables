import * as http from "http";
import * as https from "https";

export interface TransportRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  /**
   * Called for every redirect before it is followed. "stop" returns the 3xx response as is.
   * The broker revalidates the destination against each secret's allowed hosts and path prefixes.
   */
  redirectDecision: (next: URL, status: number) => "follow" | "stop";
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

export interface TransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "text" | "omitted";
  bodyBytes: number;
  truncated: boolean;
  finalUrl: string;
  redirects: number;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|problem\+json|[\w.+-]*\+json|[\w.+-]*\+xml))/i;

/**
 * Node http/https transport with manual redirects. A redirect is followed only when
 * `redirectDecision` allows it, so a secret never reaches a destination it is not allowed for.
 */
export const nodeTransport: Transport = async (req) => {
  let url = req.url;
  let method = req.method;
  let body = req.body;
  let headers = { ...req.headers };
  for (let redirects = 0; ; redirects++) {
    const res = await sendOnce(method, url, headers, body, req.timeoutMs, req.maxResponseBytes);
    const location = res.headers["location"];
    if (res.status >= 300 && res.status < 400 && location && res.status !== 304) {
      const stop = () => ({ ...res, finalUrl: url.toString(), redirects });
      if (redirects >= req.maxRedirects) return stop();
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return stop();
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") return stop();
      if (url.protocol === "https:" && next.protocol === "http:") return stop();
      if (next.username || next.password) return stop();
      if (req.redirectDecision(next, res.status) === "stop") return stop();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = dropHeaders(headers, ["content-type", "content-length"]);
      }
      url = next;
      continue;
    }
    return { ...res, finalUrl: url.toString(), redirects };
  }
};

function dropHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));
}

function sendOnce(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<Omit<TransportResponse, "finalUrl" | "redirects">> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
    const outHeaders: Record<string, string | number> = { ...headers };
    if (payload && !Object.keys(outHeaders).some((k) => k.toLowerCase() === "content-length")) {
      outHeaders["Content-Length"] = payload.length;
    }
    const request = lib.request(url, { method, headers: outHeaders, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        const contentType = flat["content-type"] ?? "";
        const buffer = Buffer.concat(chunks);
        const isText = contentType === "" || TEXT_TYPES.test(contentType);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers: flat,
          body: isText ? buffer.toString("utf8") : "",
          bodyEncoding: isText ? "text" : "omitted",
          bodyBytes: size,
          truncated,
        });
      };
      res.on("end", finish);
      res.on("error", (err) => (done ? undefined : reject(err)));
    });
    request.on("timeout", () => request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
