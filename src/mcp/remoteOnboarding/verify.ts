import { lookup } from "node:dns/promises";
import { RELAY_PROBE_ROOM, VERIFICATION_SCHEMA } from "./constants";
import { type FetchLike, type LookupLike, type RemoteRouteVerification } from "./types";
import { privateAddress } from "./network";
import { readJson, remoteSetupPaths, writeJsonAtomic } from "./stateFiles";
import { activeRuntime, parseConfig, sameRuntimeInstance } from "./receipts";
import { probePinnedHttps, probeWithFetch } from "./probe";

export async function verifyRemoteAccess(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
  lookupImpl: LookupLike = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  const paths = remoteSetupPaths(environment);
  const config = parseConfig(await readJson(paths.config));
  const hostname = new URL(config.origin).hostname;
  const addresses = await lookupImpl(hostname);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Remote origin DNS 指向本機或私人網段；已拒絕 MCP 網路探測");
  }
  const runtime = config.transport === "https-tunnel"
    ? activeRuntime(await readJson(paths.runtime), config)
    : undefined;
  if (config.transport === "https-tunnel" && !runtime) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    reason: "找不到目前這次 Editkin Remote 的本機 challenge；請先在 Editkin 明確同意費用並重新啟動 Remote",
  };
  const target = config.transport === "cloud-relay"
    ? `${config.origin}/r/${RELAY_PROBE_ROOM}`
    : `${config.origin}/api/health`;
  const pinnedAddress = [...addresses].map(({ address }) => address).sort()[0];
  const probe = (runtimeProbeId?: string) => fetchImpl
    ? probeWithFetch(target, fetchImpl, runtimeProbeId)
    : probePinnedHttps(target, pinnedAddress, runtimeProbeId);
  const first = await probe(runtime?.probeId);
  const second = first.ok ? await probe(runtime?.probeId) : { ok: false, latencyMs: 0 };
  if (!first.ok || !second.ok) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    observed: { firstConnectionSucceeded: first.ok, secondIndependentConnectionSucceeded: second.ok, latencyMs: [first.latencyMs, second.latencyMs] },
    reason: config.transport === "https-tunnel"
      ? "未觀測到可公開存取的 Editkin Remote；請先在 Editkin 重新啟動 Remote，確認 tunnel 指向固定連接埠後再試"
      : "未觀測到相容的 Editkin HTTPS/WSS relay 頁面；不得把部署視為完成",
  };
  const sorted = [first.latencyMs, second.latencyMs].sort((left, right) => left - right);
  const observedLatency = {
    latencyMs: [first.latencyMs, second.latencyMs] as [number, number],
    latencyP50Ms: Math.round(((sorted[0] + sorted[1]) / 2) * 10) / 10,
    jitterMs: Math.round(Math.abs(first.latencyMs - second.latencyMs) * 10) / 10,
  };
  if (config.transport === "cloud-relay") return {
    schema: VERIFICATION_SCHEMA,
    status: "PARTIAL" as const,
    verified: false,
    providerEndpointVerified: true,
    ...observedLatency,
    reason: "只觀測到相容 relay 的公開 HTTPS landing；尚未證明桌機 WSS、手機配對或斷線重連，不能標記 Remote 完成",
    nextAction: "在 Editkin 啟動 Remote 並用真手機跨網路配對；最終狀態仍以本機 UI 的在線裝置為準" as const,
  };
  const currentConfig = parseConfig(await readJson(paths.config));
  const currentRuntime = activeRuntime(await readJson(paths.runtime), currentConfig);
  if (currentConfig.configurationId !== config.configurationId || !runtime || !currentRuntime
    || !sameRuntimeInstance(runtime, currentRuntime)) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    reason: "Editkin Remote runtime 在探測期間已更換或停止；已拒絕簽發 stale verification receipt",
  };
  const verifiedAtMs = Math.max(Date.now(), runtime.startedAtMs + 1);
  const receipt: RemoteRouteVerification = {
    schema: VERIFICATION_SCHEMA,
    configurationId: config.configurationId,
    status: "PARTIAL",
    verified: false,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    verifiedAtMs,
    probeId: runtime.probeId,
    runtimeInstanceId: runtime.runtimeInstanceId,
    processId: runtime.processId,
    startedAtMs: runtime.startedAtMs,
    endpointKind: "editkin-tunnel",
    successfulTlsConnections: 2,
    ...observedLatency,
    routeEvidence: "two-pinned-independent-tls-connections-succeeded",
    reconnectVerified: false,
    requiresActiveMobileProof: true,
  };
  await writeJsonAtomic(paths.verification, receipt);
  return {
    ...receipt,
    reason: "已量測兩次全新、DNS pinning 的 TLS 路由，但尚未觀測真手機配對、斷線與重連，所以不宣稱端到端完成",
    nextAction: "請用真手機跨網路配對並在 Editkin 確認在線；手機重新連線證據尚未自動收集" as const,
  };
}
