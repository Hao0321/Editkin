/**
 * Boundary contract for Editkin Remote: what may arrive from a relay, which
 * relay URLs are acceptable, and exactly which project metadata may leave the
 * desktop. Kept free of I/O and process state so every rule is unit-testable.
 */

export const MAX_RELAY_ENVELOPE_BYTES = 32_768;

export type RelayPayload = {
  type: "pair" | "status" | "command";
  token?: unknown;
  deviceId?: unknown;
  name?: unknown;
  credential?: unknown;
  instruction?: unknown;
};
export type RelayEnvelope = { type: "mobile-message"; clientId: string; payload: RelayPayload };
export type RelayUpstreamEnvelope = RelayEnvelope | { type: "relay-ready" };

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRelayEnvelope(raw: unknown): RelayUpstreamEnvelope | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RELAY_ENVELOPE_BYTES) return undefined;
  let candidate: unknown;
  try { candidate = JSON.parse(raw); } catch { return undefined; }
  if (!plainObject(candidate)) return undefined;
  if (candidate.type === "relay-ready") return { type: "relay-ready" };
  if (candidate.type !== "mobile-message" || typeof candidate.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(candidate.clientId) || !plainObject(candidate.payload)) return undefined;
  const payload = candidate.payload;
  const deviceIdValid = typeof payload.deviceId === "string" && payload.deviceId.trim().length > 0 && payload.deviceId.length <= 100;
  const credentialValid = payload.credential === undefined || (typeof payload.credential === "string" && payload.credential.length <= 100);
  if (payload.type === "pair") {
    if (typeof payload.token !== "string" || payload.token.length > 256 || !deviceIdValid || (payload.name !== undefined && (typeof payload.name !== "string" || payload.name.length > 60))) return undefined;
  } else if (payload.type === "status") {
    if (!deviceIdValid || !credentialValid) return undefined;
  } else if (payload.type === "command") {
    if (!deviceIdValid || !credentialValid || typeof payload.instruction !== "string" || !payload.instruction.trim() || payload.instruction.length > 1_000) return undefined;
  } else return undefined;
  return candidate as RelayEnvelope;
}

/**
 * The relay is a user-supplied third party. Require TLS, no embedded
 * credentials, query or fragment, and the exact `/ws/<room>` path the desktop
 * derives from its own room identity. Plain `ws:` is accepted only for a
 * loopback relay (local development and smoke tests).
 */
export function assertRelayWebSocketUrl(value: string, room: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Editkin Remote relay URL 不合法"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) throw new Error("Editkin Remote relay 必須使用 wss://");
  if (url.username || url.password || url.search || url.hash) throw new Error("Editkin Remote relay URL 不得包含帳密、query 或 fragment");
  if (!/^[a-f0-9]{32}$/.test(room) || url.pathname !== `/ws/${room}`) throw new Error("Editkin Remote relay 路徑必須是 /ws/<room>");
  return url;
}

export interface RemoteStatus {
  projectName?: string;
  resolution?: string;
  fps?: number;
  trackCount?: number;
  playhead?: number;
  playheadLabel?: string;
  status?: string;
  previewId?: string;
  previewKind?: "image" | "audio" | "video";
}

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);
const count = (value: unknown, max: number): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined);
const finite = (value: unknown, max: number): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined);

/**
 * Explicit outbound data contract. Fields absent here (for example
 * `previewPath`, or anything a future snapshot adds) never leave the desktop.
 * A field that fails validation is omitted rather than forwarded.
 *
 * Metadata sent to a cloud relay: project name, canvas size, frame rate, track
 * count, playhead time and label, and the desktop status text. Preview media,
 * its id and kind, and local file paths are LAN-only.
 */
export function projectRemoteStatus(snapshot: unknown, target: "lan" | "relay"): RemoteStatus {
  const source = plainObject(snapshot) ? snapshot : {};
  const resolution = typeof source.resolution === "string" && /^\d{1,5}×\d{1,5}$/.test(source.resolution) ? source.resolution : undefined;
  const status: RemoteStatus = {
    projectName: text(source.projectName, 200),
    resolution,
    fps: finite(source.fps, 1_000),
    trackCount: count(source.trackCount, 10_000),
    playhead: finite(source.playhead, 1e9),
    playheadLabel: text(source.playheadLabel, 32),
    status: text(source.status, 500),
  };
  if (target === "lan") {
    status.previewId = text(source.previewId, 200);
    status.previewKind = source.previewKind === "image" || source.previewKind === "audio" || source.previewKind === "video" ? source.previewKind : undefined;
  }
  return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined)) as RemoteStatus;
}
