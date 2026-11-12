// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { existsSync, lstatSync, readFileSync, mkdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export type GatewayModel = { id: string; name: string; context: number; output: number };
export type GatewayConfiguration = { baseURL: string; models: GatewayModel[] };

export function normalizeGatewayURL(value: string): string {
  if (typeof value !== "string" || value.length > 1000 || /[\x00-\x20]|%2e|\.\./iu.test(value)) throw Error("OmniRoute 位址格式不符");
  const url = new URL(value);
  const host = url.hostname;
  const loopbackHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!url.hostname || url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost))) throw Error("OmniRoute 位址須為 HTTPS 或本機 loopback HTTP，不能夾帶金鑰");
  const path = url.pathname.replace(/\/+$/u, "");
  if (/\/v1\/v1$/u.test(path)) throw Error("OmniRoute 位址重複 /v1");
  url.pathname = path.endsWith("/v1") ? path : path + "/v1";
  return url.toString().replace(/\/$/u, "");
}

function validModelId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._:/-]{0,239}$/iu.test(id)
    && !id.split("/").some(part => [".", "..", "__proto__", "constructor", "prototype"].includes(part));
}
function positiveLimit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
export function gatewayModelCatalog(payload: any): { models: GatewayModel[]; excludedCount: number } {
  if (!Array.isArray(payload?.data) || payload.data.length > 4096) throw Error("OmniRoute 模型清單格式不符");
  const models = new Map<string, GatewayModel>(); let excludedCount = 0;
  const blocked = new Set<string>(payload.data.filter((model: any) => validModelId(model?.id) && model?.capabilities?.tool_calling !== true).map((model: any) => model.id));
  for (const model of payload.data) {
    if (!validModelId(model?.id) || model?.capabilities?.tool_calling !== true || blocked.has(model.id)) { excludedCount++; continue; }
    if (models.has(model.id)) continue;
    if (models.size >= 2048) throw Error("OmniRoute 工具模型清單超過上限，請先在閘道篩選");
    // IDs remain byte-exact (including cc/cx/gc/gemini prefixes); arbitrary gateway metadata is discarded.
    models.set(model.id, { id: model.id, name: model.id, context: positiveLimit(model.context_length ?? model.context_window, 32000, 2_000_000),
      output: positiveLimit(model.max_output_tokens, 4096, 128_000) });
  }
  if (!models.size) throw Error("OmniRoute 沒有明確支援工具呼叫的模型，請先設定可剪輯模型");
  return { models: [...models.values()], excludedCount };
}

function assertPath(path: string, create = false) {
  if (!isAbsolute(path) || basename(path) !== "omniroute.opencode.json" || basename(dirname(path)) !== "agent-providers") throw Error("OmniRoute 設定路徑不符");
  if (create) mkdirSync(dirname(path), { recursive: true });
  if (existsSync(dirname(path)) && (!lstatSync(dirname(path)).isDirectory() || lstatSync(dirname(path)).isSymbolicLink())) throw Error("OmniRoute 設定不能使用連結路徑");
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1_048_576)) throw Error("OmniRoute 設定檔不符");
}
function providerDocument(config: GatewayConfiguration) {
  return { $schema: "https://opencode.ai/config.json", provider: { omniroute: { npm: "@ai-sdk/openai-compatible", name: "OmniRoute",
    options: { baseURL: config.baseURL }, models: Object.fromEntries(config.models.map(model => [model.id, { name: model.name, limit: { context: model.context, output: model.output } }])) } } };
}
export function readGatewayConfiguration(path?: string): GatewayConfiguration | undefined {
  if (!path) return undefined;
  assertPath(path); if (!existsSync(path)) return undefined;
  try {
    const document = JSON.parse(readFileSync(path, "utf8")), provider = document?.provider?.omniroute;
    if (document.$schema !== "https://opencode.ai/config.json" || Object.keys(document).some(key => !["$schema", "provider"].includes(key))
      || Object.keys(document.provider).some(key => key !== "omniroute") || provider.npm !== "@ai-sdk/openai-compatible"
      || Object.keys(provider).some(key => !["npm", "name", "options", "models"].includes(key)) || Object.keys(provider.options).some(key => key !== "baseURL")) throw Error();
    const baseURL = normalizeGatewayURL(provider.options.baseURL), entries = Object.entries(provider.models);
    if (!entries.length || entries.length > 2048) throw Error();
    const models = entries.map(([id, raw]) => { const model = raw as any;
      if (!validModelId(id) || model.name !== id || Object.keys(model).some(key => !["name", "limit"].includes(key))) throw Error();
      return { id, name: id, context: positiveLimit(model.limit?.context, 32000, 2_000_000), output: positiveLimit(model.limit?.output, 4096, 128_000) };
    });
    return { baseURL, models };
  } catch { throw Error("OmniRoute 設定無效，請重新設定連線"); }
}
export function writeGatewayConfiguration(path: string, config: GatewayConfiguration) {
  assertPath(path, true); const temporary = join(dirname(path), `omniroute-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600); writeFileSync(descriptor, JSON.stringify(providerDocument(config))); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } finally { if (descriptor !== undefined) closeSync(descriptor); if (existsSync(temporary)) unlinkSync(temporary); }
}
export function removeGatewayConfiguration(path: string) { assertPath(path); if (existsSync(path)) unlinkSync(path); }

export async function discoverGatewayModels(baseURL: string, apiKey?: string) {
  const normalizedBaseURL = normalizeGatewayURL(baseURL);
  let response: Response;
  try { response = await fetch(normalizedBaseURL + "/models", { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw Error("OmniRoute 未連線，請先啟動閘道並確認位址"); }
  if (!response.ok) { await response.body?.cancel(); throw Error(`OmniRoute 模型清單讀取失敗（HTTP ${response.status}），請確認閘道與金鑰`); }
  if (Number(response.headers.get("content-length")) > 8_388_608) { await response.body?.cancel(); throw Error("OmniRoute 模型清單過大"); }
  const reader = response.body?.getReader(); if (!reader) throw Error("OmniRoute 模型清單是空的");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > 8_388_608) { await reader.cancel(); throw Error("OmniRoute 模型清單過大"); } chunks.push(value); } }
  catch { throw Error("OmniRoute 模型清單未完整讀取，原設定保留"); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Error("OmniRoute 回覆不是模型清單"); }
  return gatewayModelCatalog(payload);
}
