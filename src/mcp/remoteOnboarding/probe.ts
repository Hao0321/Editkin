import { request as httpsRequest } from "node:https";
import { MAX_RESPONSE_BYTES, PROBE_TIMEOUT_MS } from "./constants";
import { type FetchLike } from "./types";

async function responsePrefix(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (bytes < MAX_RESPONSE_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.includes("Editkin Remote")) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function responseHasExpectedMarker(body: string, expectedProbeId?: string): boolean {
  if (!expectedProbeId) return body.includes("Editkin Remote");
  try {
    const payload = JSON.parse(body) as { schema?: unknown; probeId?: unknown };
    return payload.schema === "editkin.remote-health/v1" && payload.probeId === expectedProbeId;
  } catch { return false; }
}

export async function probeWithFetch(target: string, fetchImpl: FetchLike, expectedProbeId?: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json,text/html", "cache-control": "no-cache", connection: "close" },
      signal: controller.signal,
    });
    const body = response.status === 200 ? await responsePrefix(response) : "";
    return { ok: responseHasExpectedMarker(body, expectedProbeId), latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) };
  } catch {
    return { ok: false, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probePinnedHttps(target: string, pinnedAddress: string, expectedProbeId?: string): Promise<{ ok: boolean; latencyMs: number }> {
  const url = new URL(target);
  const started = performance.now();
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe({ ok, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) });
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: pinnedAddress,
      port: url.port ? Number.parseInt(url.port, 10) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        host: url.host,
        accept: "application/json,text/html",
        "cache-control": "no-cache",
        connection: "close",
      },
    }, (response) => {
      let body = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Remote probe response exceeded limit"));
          return;
        }
        body += chunk;
      });
      response.on("end", () => finish(response.statusCode === 200 && responseHasExpectedMarker(body, expectedProbeId)));
    });
    request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy(new Error("Remote probe timed out")));
    request.once("error", () => finish(false));
    request.end();
  });
}
