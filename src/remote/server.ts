import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

const token = process.env.EDITKIN_REMOTE_TOKEN;
const queuePath = process.env.EDITKIN_REMOTE_QUEUE;
const snapshotPath = process.env.EDITKIN_REMOTE_SNAPSHOT;
const devicesPath = process.env.EDITKIN_REMOTE_DEVICES;
const trustedDevicesPath = process.env.EDITKIN_REMOTE_TRUSTED_DEVICES;
const relayWebSocketUrl = process.env.EDITKIN_REMOTE_RELAY_WS_URL;
const relayRoom = process.env.EDITKIN_REMOTE_RELAY_ROOM;
const relaySecret = process.env.EDITKIN_REMOTE_RELAY_SECRET;
const healthProbeId = process.env.EDITKIN_REMOTE_HEALTH_PROBE_ID;
const port = Number(process.env.EDITKIN_REMOTE_PORT ?? 0);
const parentPid = Number(process.env.EDITKIN_REMOTE_PARENT_PID ?? 0);
if (!token || token.length < 12 || !queuePath || !snapshotPath || !devicesPath || !trustedDevicesPath || !healthProbeId || !/^[a-f0-9]{32}$/.test(healthProbeId) || !Number.isInteger(port) || port <= 0) {
  throw new Error("Editkin Remote 缺少安全啟動參數");
}
const remoteToken = token;
const remoteQueuePath = queuePath;
const remoteSnapshotPath = snapshotPath;
const remoteDevicesPath = devicesPath;
const remoteTrustedDevicesPath = trustedDevicesPath;
const remoteHealthProbeId = healthProbeId;
const pairingExpiresAt = Date.now() + 10 * 60_000;
const activeWindowMs = 12_000;
const sessionLifetimeMs = 12 * 60 * 60_000;
const pairRateWindowMs = 60_000;
const pairRateLimit = 10;
const maxRelayEnvelopeBytes = 32_768;

interface RemoteSession {
  credentialHash: string;
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
}

interface TrustedDevice {
  id: string;
  name: string;
  credentialHash: string;
  pairedAt: string;
  lastSeen: string;
}

interface TrustedDeviceStore {
  schemaVersion: 1;
  devices: TrustedDevice[];
}

const sessions = new Map<string, RemoteSession>();
const relaySessions = new Map<string, RemoteSession>();
const recent = new Map<string, number>();
const pairAttempts = new Map<string, { count: number; startedAt: number }>();
let relaySocket: WebSocket | undefined;
let relayRetryMs = 500;
const pageStyle = String.raw`
  :root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif;background:#08090d;color:#f7f7fb}*{box-sizing:border-box}html{min-height:100%;background:#08090d}body{margin:0;min-height:100vh;min-height:100dvh;padding:max(18px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:radial-gradient(circle at 80% 0,#173143 0,transparent 35%),#08090d}.shell{max-width:620px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.brand{font-weight:800;font-size:24px;white-space:nowrap}.brand i{font-style:normal;color:#59d9ff}.online{font-size:12px;min-height:44px;padding:7px 10px;border:1px solid #295063;border-radius:99px;color:#75e7a6;display:flex;align-items:center;text-align:center}.card{margin-top:16px;padding:16px;border:1px solid #252832;border-radius:18px;background:#111319cc;box-shadow:0 20px 60px #0008}h1{font-size:22px;margin:0 0 7px}.meta{color:#9ca3b1;font-size:13px}.time{font-variant-numeric:tabular-nums;color:#59d9ff;font-size:32px;font-weight:700;margin-top:14px}.preview{display:none;width:100%;max-height:55vh;max-height:55dvh;aspect-ratio:16/9;object-fit:contain;background:#000;border-radius:13px;margin-top:14px}.preview.audio{height:64px;aspect-ratio:auto}.quick{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}button,textarea,input{font:inherit;font-size:16px}button{min-height:48px;border:1px solid #303541;border-radius:13px;background:#1a1e27;color:#fff;font-weight:650;padding:8px 10px}button:active{transform:scale(.98);background:#253341}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid #fff;outline-offset:2px}.primary{background:#59d9ff;color:#061016;border-color:#59d9ff;width:100%;margin-top:10px}textarea{width:100%;min-height:110px;resize:vertical;border:1px solid #303541;border-radius:13px;background:#0b0d12;color:#fff;padding:13px;outline:none}.status{min-height:20px;margin-top:10px;color:#9ca3b1;font-size:13px}.caption-row{display:grid;grid-template-columns:90px minmax(0,1fr);gap:9px;margin-top:10px}.caption-row input{min-width:0;min-height:48px;border:1px solid #303541;border-radius:11px;background:#0b0d12;color:#fff;padding:11px}.hint{font-size:12px;color:#8e96a6;margin-top:12px;line-height:1.5}@media(max-width:370px){body{padding-inline:max(12px,env(safe-area-inset-left))}.card{padding:14px}.brand{font-size:21px}.online{font-size:11px}.quick{gap:8px}}@media(max-height:500px) and (orientation:landscape){body{padding-block:10px}.shell{max-width:820px}.card{margin-top:10px}.preview{max-height:46dvh}.quick{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}button:active{transform:none}}
  `;
const pageScript = String.raw`
  const params=new URLSearchParams(location.hash.replace(/^#/,''));const bootstrapToken=params.get('token');const q=id=>document.getElementById(id);let previewKey='';
  function deviceName(){const ua=navigator.userAgent;if(/iPhone/i.test(ua))return 'iPhone';if(/iPad/i.test(ua))return 'iPad';if(/Android/i.test(ua))return 'Android 手機';return '手機瀏覽器'}
  function deviceId(){try{let id=localStorage.getItem('editkin-device-id');if(!id){id=crypto.randomUUID?.()||('device-'+Date.now()+'-'+Math.random().toString(16).slice(2));localStorage.setItem('editkin-device-id',id)}return id}catch{return 'device-'+Date.now()+'-'+Math.random().toString(16).slice(2)}}
  async function pair(){if(!bootstrapToken)return false;const r=await fetch('/api/pair',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token:bootstrapToken,deviceId:deviceId(),name:deviceName()})});if(r.ok){history.replaceState({},'',location.pathname);return true}return false}
  async function command(instruction){q('status').textContent='傳送中…';const r=await fetch('/api/command',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({instruction})});const j=await r.json();q('status').textContent=r.ok?'已送到桌機：'+instruction:(j.error||'失敗')}
  async function refresh(){try{const r=await fetch('/api/status',{credentials:'same-origin'});if(!r.ok)throw 0;const s=await r.json();q('online').textContent='● '+(s.deviceName||'手機')+' 已連線 · 永久綁定';q('name').textContent=s.projectName||'Editkin 專案';q('meta').textContent=(s.resolution||'')+' · '+(s.fps||'')+' fps · '+(s.trackCount||0)+' tracks';q('time').textContent=s.playheadLabel||'00:00.00';const nextKey=s.previewAvailable?(s.previewId||'preview')+':'+(s.previewKind||'video'):'';if(nextKey!==previewKey){['previewVideo','previewImage','previewAudio'].forEach(id=>{q(id).pause?.();q(id).removeAttribute('src');q(id).style.display='none'});previewKey=nextKey;if(nextKey){const id=s.previewKind==='image'?'previewImage':s.previewKind==='audio'?'previewAudio':'previewVideo';q(id).src='/api/preview?v='+encodeURIComponent(nextKey);q(id).style.display='block'}}}catch{q('online').textContent='等待桌機上線';q('status').textContent='這台手機已記住 Editkin；桌機 Remote 啟動後會自動重連。若桌機已撤銷此裝置，才需要重新掃描。'}}
  document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>command(b.dataset.command));q('send').onclick=()=>{const v=q('instruction').value.trim();if(v)command(v)};q('caption').onclick=()=>{const t=q('captionTime').value||'0';const v=q('captionText').value.trim();if(v)command('在 '+t+' 秒加字幕：'+v)};(async()=>{await pair();await refresh();setInterval(refresh,1000)})();
`;
const contentHash = (value: string) => createHash("sha256").update(value).digest("base64");
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'sha256-${contentHash(pageScript)}'; style-src 'sha256-${contentHash(pageStyle)}'; media-src 'self'; connect-src 'self'; img-src 'self' data:`,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType = "application/json; charset=utf-8",
  extraHeaders: Record<string, string> = {},
) {
  response.writeHead(status, { ...securityHeaders, ...extraHeaders, "content-type": contentType, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function bootstrapAuthorized(candidate: unknown): boolean {
  if (Date.now() > pairingExpiresAt || typeof candidate !== "string") return false;
  const supplied = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(remoteToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function pairRateAllowed(key: string, now: number): boolean {
  const current = pairAttempts.get(key);
  if (!current || now - current.startedAt >= pairRateWindowMs) {
    pairAttempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  current.count += 1;
  return current.count <= pairRateLimit;
}

function lanPairRateAllowed(request: IncomingMessage, now: number): boolean {
  return pairRateAllowed(`lan:${clientAddress(request)}`, now);
}

function requestOriginAllowed(request: IncomingMessage): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string" || !host || /[\r\n]/.test(host)) return false;
  const forwarded = Array.isArray(request.headers["x-forwarded-proto"])
    ? request.headers["x-forwarded-proto"][0] : request.headers["x-forwarded-proto"];
  const protocol = forwarded === "https" || Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted) ? "https" : "http";
  return origin === `${protocol}://${host}`;
}

function jsonMutationAllowed(request: IncomingMessage): boolean {
  return requestOriginAllowed(request)
    && String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

function credentialHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validTrustedDevice(value: unknown): value is TrustedDevice {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TrustedDevice>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 100
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 60
    && typeof item.credentialHash === "string" && /^[0-9a-f]{64}$/.test(item.credentialHash)
    && typeof item.pairedAt === "string" && Number.isFinite(Date.parse(item.pairedAt))
    && typeof item.lastSeen === "string" && Number.isFinite(Date.parse(item.lastSeen));
}

async function readTrustedDevices(): Promise<TrustedDeviceStore> {
  try {
    const parsed = JSON.parse(await readFile(remoteTrustedDevicesPath, "utf8")) as Partial<TrustedDeviceStore>;
    const devices = Array.isArray(parsed.devices) ? parsed.devices.filter(validTrustedDevice) : [];
    return { schemaVersion: 1, devices: devices.slice(0, 20) };
  } catch {
    return { schemaVersion: 1, devices: [] };
  }
}

async function writeTrustedDevices(store: TrustedDeviceStore): Promise<void> {
  const temporary = `${remoteTrustedDevicesPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(join(remoteTrustedDevicesPath, ".."), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(store)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, remoteTrustedDevicesPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeDeviceStatus() {
  const now = Date.now();
  const trusted = await readTrustedDevices();
  const devices = trusted.devices.map((device) => {
    const session = sessions.get(device.credentialHash);
    const connected = Boolean(session && now - session.lastSeen <= activeWindowMs);
    return {
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeen: connected && session ? new Date(session.lastSeen).toISOString() : device.lastSeen,
      connected,
    };
  });
  await writeFile(remoteDevicesPath, `${JSON.stringify({ connectedCount: devices.filter((device) => device.connected).length, trustedCount: devices.length, devices, pairingExpiresAt: new Date(pairingExpiresAt).toISOString() })}\n`, "utf8");
}

function pruneState(now: number) {
  for (const [sessionId, session] of sessions) if (now - session.lastSeen > sessionLifetimeMs) sessions.delete(sessionId);
  for (const [clientId, session] of relaySessions) if (now - session.lastSeen > sessionLifetimeMs) relaySessions.delete(clientId);
  for (const [address, lastCommand] of recent) if (now - lastCommand > 60_000) recent.delete(address);
  for (const [address, attempt] of pairAttempts) if (now - attempt.startedAt > pairRateWindowMs) pairAttempts.delete(address);
}

async function enqueueCommand(instruction: string, receivedAt: number) {
  const random = randomBytes(10).toString("hex");
  const id = `remote-${receivedAt}-${random}`;
  const base = `${String(receivedAt).padStart(13, "0")}-${random}`;
  const temporary = join(remoteQueuePath, `${base}.tmp`);
  const completed = join(remoteQueuePath, `${base}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify({ id, instruction, receivedAt: new Date(receivedAt).toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, completed);
    return id;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pairRelayDevice(input: { token?: unknown; deviceId?: unknown; name?: unknown }) {
  if (!bootstrapAuthorized(input.token)) throw new Error("PAIRING_DENIED");
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim().slice(0, 100) : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "手機";
  if (!deviceId) throw new Error("DEVICE_ID_REQUIRED");
  const trusted = await readTrustedDevices();
  for (const [hash, session] of sessions) if (session.deviceId === deviceId) sessions.delete(hash);
  trusted.devices = trusted.devices.filter((device) => device.id !== deviceId);
  if (trusted.devices.length >= 20) throw new Error("DEVICE_LIMIT");
  const credential = randomBytes(32).toString("base64url");
  const hash = credentialHash(credential);
  const now = Date.now();
  const pairedAt = new Date(now).toISOString();
  trusted.devices.push({ id: deviceId, name: name || "手機", credentialHash: hash, pairedAt, lastSeen: pairedAt });
  await writeTrustedDevices(trusted);
  sessions.set(hash, { credentialHash: hash, deviceId, name: name || "手機", pairedAt: now, lastSeen: now });
  await writeDeviceStatus();
  return { credential, deviceName: name || "手機" };
}

async function authenticateRelayDevice(credential: unknown, deviceId: unknown, clientId: string): Promise<RemoteSession | undefined> {
  if (typeof deviceId !== "string") return undefined;
  if (typeof credential !== "string" || credential.length < 32 || credential.length > 100) {
    const remembered = relaySessions.get(clientId);
    if (!remembered || remembered.deviceId !== deviceId) return undefined;
    const trusted = await readTrustedDevices();
    if (!trusted.devices.some((item) => item.id === remembered.deviceId && item.credentialHash === remembered.credentialHash)) {
      relaySessions.delete(clientId);
      return undefined;
    }
    remembered.lastSeen = Date.now();
    sessions.set(remembered.credentialHash, remembered);
    await writeDeviceStatus();
    return remembered;
  }
  const hash = credentialHash(credential);
  const trusted = await readTrustedDevices();
  const device = trusted.devices.find((item) => item.id === deviceId && item.credentialHash === hash);
  if (!device) return undefined;
  const now = Date.now();
  const session = { credentialHash: hash, deviceId: device.id, name: device.name, pairedAt: Date.parse(device.pairedAt), lastSeen: now };
  sessions.set(hash, session);
  relaySessions.set(clientId, session);
  if (now - Date.parse(device.lastSeen) >= 60_000) {
    device.lastSeen = new Date(now).toISOString();
    await writeTrustedDevices(trusted);
  }
  await writeDeviceStatus();
  return session;
}

function sendRelay(clientId: string, payload: Record<string, unknown>) {
  if (relaySocket?.readyState === WebSocket.OPEN) relaySocket.send(JSON.stringify({ type: "desktop-response", clientId, payload }));
}

type RelayPayload = { type: "pair" | "status" | "command"; token?: unknown; deviceId?: unknown; name?: unknown; credential?: unknown; instruction?: unknown };
type RelayEnvelope = { type: "mobile-message"; clientId: string; payload: RelayPayload };
type RelayUpstreamEnvelope = RelayEnvelope | { type: "relay-ready" };

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRelayClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
}

function parseRelayEnvelope(raw: unknown): RelayUpstreamEnvelope | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxRelayEnvelopeBytes) return undefined;
  let candidate: unknown;
  try { candidate = JSON.parse(raw); } catch { return undefined; }
  if (!plainObject(candidate)) return undefined;
  if (candidate.type === "relay-ready") return { type: "relay-ready" };
  if (candidate.type !== "mobile-message" || !validRelayClientId(candidate.clientId) || !plainObject(candidate.payload)) return undefined;
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

async function handleRelayMessage(raw: unknown): Promise<boolean> {
  const envelope = parseRelayEnvelope(raw);
  if (!envelope) return false;
  if (envelope.type === "relay-ready") return true;
  const payload = envelope.payload;
  try {
    if (payload.type === "pair") {
      const now = Date.now();
      pruneState(now);
      if (!pairRateAllowed(`relay:${envelope.clientId}`, now)) throw new Error("PAIRING_RATE_LIMITED");
      const paired = await pairRelayDevice(payload);
      sendRelay(envelope.clientId, { type: "paired", permanent: true, ...paired });
      return true;
    }
    const session = await authenticateRelayDevice(payload.credential, payload.deviceId, envelope.clientId);
    if (!session) {
      sendRelay(envelope.clientId, { type: "unauthorized", error: "裝置憑證已失效，請重新掃碼" });
      return true;
    }
    if (payload.type === "status") {
      const current = await snapshot();
      const { previewPath: _privatePath, ...safe } = current;
      sendRelay(envelope.clientId, { type: "status", ...safe, deviceName: session.name, permanentlyPaired: true, previewAvailable: false, transport: "cloud-relay" });
      return true;
    }
    if (payload.type === "command") {
      const instruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";
      if (!instruction || instruction.length > 1_000) {
        sendRelay(envelope.clientId, { type: "error", error: "指令長度不合法" });
        return true;
      }
      const key = `relay:${envelope.clientId}`;
      const now = Date.now();
      if (now - (recent.get(key) ?? 0) < 150) {
        sendRelay(envelope.clientId, { type: "error", error: "操作太快，請稍候" });
        return true;
      }
      recent.set(key, now);
      const commandId = await enqueueCommand(instruction, now);
      sendRelay(envelope.clientId, { type: "accepted", commandId, instruction });
      return true;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "REMOTE_ERROR";
    sendRelay(envelope.clientId, { type: "error", error: code === "PAIRING_DENIED" ? "配對碼無效或已過期" : code === "PAIRING_RATE_LIMITED" ? "配對嘗試過多，請稍後再試" : code === "DEVICE_LIMIT" ? "已達永久綁定裝置上限" : "Remote request failed" });
    return true;
  }
  return false;
}

function connectRelay() {
  if (!relayWebSocketUrl || !relayRoom || !relaySecret) return;
  const socket = new WebSocket(relayWebSocketUrl);
  relaySocket = socket;
  socket.addEventListener("open", () => {
    relayRetryMs = 500;
    socket.send(JSON.stringify({ type: "desktop-auth", room: relayRoom, secret: relaySecret }));
  });
  socket.addEventListener("message", (event) => {
    void handleRelayMessage(event.data).then((accepted) => {
      if (!accepted && socket.readyState === WebSocket.OPEN) socket.close(4008, "invalid relay envelope");
    }).catch(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close(4011, "relay handling failed");
    });
  });
  socket.addEventListener("close", () => {
    if (relaySocket === socket) relaySocket = undefined;
    const delay = relayRetryMs;
    relayRetryMs = Math.min(15_000, relayRetryMs * 2);
    setTimeout(connectRelay, delay).unref();
  });
  socket.addEventListener("error", () => socket.close());
}

async function authenticate(request: IncomingMessage, url: URL): Promise<boolean> {
  void url;
  const credential = cookies(request).editkin_remote_device;
  if (!credential || credential.length < 32 || credential.length > 100) return false;
  const hash = credentialHash(credential);
  const trusted = await readTrustedDevices();
  const device = trusted.devices.find((item) => item.credentialHash === hash);
  if (!device) return false;
  const now = Date.now();
  const existing = sessions.get(hash);
  sessions.set(hash, {
    credentialHash: hash,
    deviceId: device.id,
    name: device.name,
    pairedAt: Date.parse(device.pairedAt),
    lastSeen: now,
  });
  if (!existing || now - Date.parse(device.lastSeen) >= 60_000) {
    device.lastSeen = new Date(now).toISOString();
    await writeTrustedDevices(trusted);
  }
  await writeDeviceStatus();
  return true;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 32_768) throw new Error("命令超過 32 KiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function snapshot(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(remoteSnapshotPath, "utf8")) as Record<string, unknown>;
}

async function servePreview(request: IncomingMessage, response: ServerResponse) {
  const current = await snapshot();
  const path = typeof current.previewPath === "string" ? current.previewPath : undefined;
  if (!path) return send(response, 404, JSON.stringify({ error: "目前沒有可預覽素材" }));
  const contentTypes: Record<string, string> = {
    ".aac": "audio/aac", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".mp4": current.previewKind === "audio" ? "audio/mp4" : "video/mp4", ".png": "image/png", ".wav": "audio/wav", ".webm": "video/webm", ".webp": "image/webp",
  };
  const contentType = contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
  const info = await stat(path);
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = Math.min(range?.[2] ? Number(range[2]) : info.size - 1, info.size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
    response.writeHead(416, { ...securityHeaders, "content-range": `bytes */${info.size}` });
    return response.end();
  }
  response.writeHead(range ? 206 : 200, {
    ...securityHeaders,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${info.size}`,
    "content-type": contentType,
  });
  createReadStream(path, { start, end }).pipe(response);
}

const page = String.raw`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#08090d">
<title>Editkin Remote</title><style>${pageStyle}</style></head><body><main class="shell"><div class="top"><div class="brand"><i>E</i> Editkin</div><div class="online" id="online" role="status" aria-live="polite">安全配對中</div></div><section class="card"><h1 id="name">讀取專案…</h1><div class="meta" id="meta"></div><div class="time" id="time">00:00.00</div><video class="preview" id="previewVideo" controls playsinline></video><img class="preview" id="previewImage" alt="目前素材預覽"><audio class="preview audio" id="previewAudio" controls></audio><div class="quick"><button data-command="復原">↶ 復原</button><button data-command="重做">↷ 重做</button><button data-command="在目前播放頭分割">✂ 分割選取</button><button data-command="壓緊空隙">⇥ 壓緊空隙</button><button data-command="智慧去停頓">✂ 智慧去停頓</button><button data-command="自動字幕">▣ 自動上字幕</button><button data-command="自動分鏡">▤ 自動分鏡</button><button data-command="智慧成片">✦ 智慧成片</button></div></section><section class="card"><textarea id="instruction" aria-label="剪輯指令" placeholder="直接說：智慧成片\n或：自動字幕"></textarea><button class="primary" id="send">送出剪輯指令</button><div class="caption-row"><input id="captionTime" aria-label="字幕時間（秒）" inputmode="decimal" placeholder="秒數"><input id="captionText" aria-label="字幕文字" placeholder="字幕文字"></div><button id="caption" class="primary">加入字幕</button><div class="status" id="status" role="status" aria-live="polite"></div><div class="hint">第一次掃碼會永久綁定這台裝置；QR 的一次性憑證會立刻從網址移除。之後桌機 Remote 上線即可自動重連，素材與 GPU 輸出仍留在桌機。</div></section></main><script>${pageScript}</script></body></html>`;

await mkdir(remoteQueuePath, { recursive: true });
await writeDeviceStatus();
connectRelay();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://editkin.local");
    if (url.pathname === "/" && request.method === "GET") return send(response, 200, page, "text/html; charset=utf-8");
    if (url.pathname === "/api/health" && request.method === "GET") return send(response, 200, JSON.stringify({ schema: "editkin.remote-health/v1", probeId: remoteHealthProbeId }), "application/json; charset=utf-8", { "cache-control": "no-store" });
    if (url.pathname === "/api/pair" && request.method === "POST") {
      if (!jsonMutationAllowed(request)) return send(response, 403, JSON.stringify({ error: "拒絕跨來源配對要求" }));
      const now = Date.now();
      pruneState(now);
      if (!lanPairRateAllowed(request, now)) return send(response, 429, JSON.stringify({ error: "配對嘗試過多，請稍後再試" }));
      const input = JSON.parse(await body(request)) as { token?: unknown; deviceId?: unknown; name?: unknown };
      if (!bootstrapAuthorized(input.token)) return send(response, 401, JSON.stringify({ error: "配對碼無效或已過期" }));
      const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim().slice(0, 100) : "";
      const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "手機";
      if (!deviceId) return send(response, 400, JSON.stringify({ error: "缺少裝置識別碼" }));
      const trusted = await readTrustedDevices();
      for (const [hash, session] of sessions) if (session.deviceId === deviceId) sessions.delete(hash);
      trusted.devices = trusted.devices.filter((device) => device.id !== deviceId);
      if (trusted.devices.length >= 20) return send(response, 429, JSON.stringify({ error: "已達永久綁定裝置上限" }));
      const deviceCredential = randomBytes(32).toString("base64url");
      const hash = credentialHash(deviceCredential);
      const pairedAt = new Date(now).toISOString();
      trusted.devices.push({ id: deviceId, name: name || "手機", credentialHash: hash, pairedAt, lastSeen: pairedAt });
      await writeTrustedDevices(trusted);
      sessions.set(hash, { credentialHash: hash, deviceId, name: name || "手機", pairedAt: now, lastSeen: now });
      await writeDeviceStatus();
      const forwardedProtocol = Array.isArray(request.headers["x-forwarded-proto"])
        ? request.headers["x-forwarded-proto"][0] : request.headers["x-forwarded-proto"];
      const secure = forwardedProtocol === "https" || Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
      return send(response, 201, JSON.stringify({ paired: true, permanent: true, deviceName: name || "手機" }), undefined, {
        "set-cookie": `editkin_remote_device=${encodeURIComponent(deviceCredential)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000${secure ? "; Secure" : ""}`,
      });
    }
    if (!await authenticate(request, url)) return send(response, 401, JSON.stringify({ error: "工作階段無效，請重新配對" }));
    if (url.pathname === "/api/status" && request.method === "GET") {
      const current = await snapshot();
      const { previewPath: _privatePath, ...safe } = current;
      const credential = cookies(request).editkin_remote_device;
      const session = credential ? sessions.get(credentialHash(credential)) : undefined;
      return send(response, 200, JSON.stringify({ ...safe, deviceName: session?.name, permanentlyPaired: true, previewAvailable: typeof current.previewPath === "string" }));
    }
    if (url.pathname === "/api/preview" && request.method === "GET") return await servePreview(request, response);
    if (url.pathname === "/api/command" && request.method === "POST") {
      if (!jsonMutationAllowed(request)) return send(response, 403, JSON.stringify({ error: "拒絕跨來源控制要求" }));
      const ip = clientAddress(request);
      const now = Date.now();
      pruneState(now);
      if (now - (recent.get(ip) ?? 0) < 150) return send(response, 429, JSON.stringify({ error: "操作太快，請稍候" }));
      recent.set(ip, now);
      const input = JSON.parse(await body(request)) as { instruction?: unknown };
      const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
      if (!instruction || instruction.length > 1_000) return send(response, 400, JSON.stringify({ error: "指令長度不合法" }));
      const commandId = await enqueueCommand(instruction, now);
      return send(response, 202, JSON.stringify({ accepted: true, commandId }));
    }
    const known = new Map([["/", "GET"], ["/api/health", "GET"], ["/api/pair", "POST"], ["/api/status", "GET"], ["/api/preview", "GET"], ["/api/command", "POST"]]);
    const allowed = known.get(url.pathname);
    if (allowed) return send(response, 405, JSON.stringify({ error: "Method not allowed" }), undefined, { allow: allowed });
    return send(response, 404, JSON.stringify({ error: "Not found" }));
  } catch {
    process.stderr.write("Editkin Remote request failed\n");
    return send(response, 500, JSON.stringify({ error: "Remote request failed" }));
  }
});
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

const deviceTimer = setInterval(() => void writeDeviceStatus(), 3_000);
let parentTimer: NodeJS.Timeout | undefined;
if (Number.isInteger(parentPid) && parentPid > 0) {
  parentTimer = setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch { clearInterval(deviceTimer); if (parentTimer) clearInterval(parentTimer); server.close(() => process.exit(0)); }
  }, 2_000);
}
server.listen(port, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ status: "READY", port })}\n`));
process.on("SIGTERM", () => { clearInterval(deviceTimer); if (parentTimer) clearInterval(parentTimer); server.close(() => process.exit(0)); });
