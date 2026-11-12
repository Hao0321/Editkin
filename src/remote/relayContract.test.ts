import { describe, expect, it } from "vitest";
import { assertRelayWebSocketUrl, MAX_RELAY_ENVELOPE_BYTES, parseRelayEnvelope, projectRemoteStatus } from "./relayContract";

const room = "a".repeat(32);
const envelope = (payload: unknown, clientId: unknown = "client-1") => JSON.stringify({ type: "mobile-message", clientId, payload });
const plainWebSocketUrl = (authorityAndPath: string) => ["ws", authorityAndPath].join("://");

describe("relay envelope parsing", () => {
  it("accepts well-formed pair, status and command messages", () => {
    expect(parseRelayEnvelope(envelope({ type: "pair", token: "t", deviceId: "d", name: "phone" }))).toBeTruthy();
    expect(parseRelayEnvelope(envelope({ type: "status", deviceId: "d", credential: "c" }))).toBeTruthy();
    expect(parseRelayEnvelope(envelope({ type: "command", deviceId: "d", instruction: "undo" }))).toBeTruthy();
    expect(parseRelayEnvelope(JSON.stringify({ type: "relay-ready" }))).toEqual({ type: "relay-ready" });
  });

  it.each([
    ["not a string", 42],
    ["binary data", new ArrayBuffer(4)],
    ["invalid JSON", "{"],
    ["JSON array", "[]"],
    ["unknown envelope type", JSON.stringify({ type: "desktop-auth" })],
    ["client id with slash", envelope({ type: "status", deviceId: "d" }, "a/b")],
    ["client id too long", envelope({ type: "status", deviceId: "d" }, "a".repeat(101))],
    ["unknown payload type", envelope({ type: "admin", deviceId: "d" })],
    ["pair without token", envelope({ type: "pair", deviceId: "d" })],
    ["pair token too long", envelope({ type: "pair", token: "t".repeat(257), deviceId: "d" })],
    ["pair name too long", envelope({ type: "pair", token: "t", deviceId: "d", name: "n".repeat(61) })],
    ["status without device", envelope({ type: "status" })],
    ["blank device id", envelope({ type: "status", deviceId: "   " })],
    ["device id too long", envelope({ type: "status", deviceId: "d".repeat(101) })],
    ["credential wrong type", envelope({ type: "status", deviceId: "d", credential: 1 })],
    ["command blank", envelope({ type: "command", deviceId: "d", instruction: "  " })],
    ["command too long", envelope({ type: "command", deviceId: "d", instruction: "x".repeat(1_001) })],
    ["non-object payload", envelope("status")],
  ])("rejects %s", (_name, raw) => {
    expect(parseRelayEnvelope(raw)).toBeUndefined();
  });

  it("rejects an envelope over the byte limit even when it is valid JSON", () => {
    const padded = envelope({ type: "status", deviceId: "d", credential: "c" }).replace("client-1", "x".repeat(10));
    expect(parseRelayEnvelope(padded)).toBeTruthy();
    const oversized = JSON.stringify({ type: "relay-ready", padding: "p".repeat(MAX_RELAY_ENVELOPE_BYTES) });
    expect(parseRelayEnvelope(oversized)).toBeUndefined();
  });
});

describe("relay URL restrictions", () => {
  it("accepts wss for the exact room path and loopback ws for local development", () => {
    expect(assertRelayWebSocketUrl(`wss://relay.example.com/ws/${room}`, room).protocol).toBe("wss:");
    expect(assertRelayWebSocketUrl(plainWebSocketUrl(`127.0.0.1:8787/ws/${room}`), room).hostname).toBe("127.0.0.1");
    expect(assertRelayWebSocketUrl(plainWebSocketUrl(`localhost/ws/${room}`), room)).toBeTruthy();
  });

  it.each([
    ["plain ws to a remote host", plainWebSocketUrl(`relay.example.com/ws/${room}`)],
    ["http scheme", `https://relay.example.com/ws/${room}`],
    ["embedded credentials", `wss://user:pass@relay.example.com/ws/${room}`],
    ["query string", `wss://relay.example.com/ws/${room}?x=1`],
    ["fragment", `wss://relay.example.com/ws/${room}#x`],
    ["another room", `wss://relay.example.com/ws/${"b".repeat(32)}`],
    ["extra path", `wss://relay.example.com/other/ws/${room}`],
    ["trailing slash", `wss://relay.example.com/ws/${room}/`],
    ["not a URL", "relay"],
  ])("rejects %s", (_name, url) => {
    expect(() => assertRelayWebSocketUrl(url, room)).toThrow();
  });

  it("rejects a malformed room identity", () => {
    expect(() => assertRelayWebSocketUrl("wss://relay.example.com/ws/room", "room")).toThrow();
  });
});

describe("outbound status contract", () => {
  const snapshot = {
    projectName: "My film", resolution: "1920×1080", fps: 30, trackCount: 3, playhead: 12.5, playheadLabel: "00:12.50", status: "ready",
    previewId: "asset-1", previewKind: "video", previewPath: "/Users/someone/private/clip.mp4",
    secretPath: "/etc/secret", nested: { token: "abc" },
  };

  it("sends only allowlisted metadata to a cloud relay and never preview identity or paths", () => {
    const relay = projectRemoteStatus(snapshot, "relay");
    expect(Object.keys(relay).sort()).toEqual(["fps", "playhead", "playheadLabel", "projectName", "resolution", "status", "trackCount"]);
    expect(JSON.stringify(relay)).not.toMatch(/Users|secret|token|asset-1/);
  });

  it("adds only the preview id and kind on the LAN, still never a path or unknown field", () => {
    const lan = projectRemoteStatus(snapshot, "lan");
    expect(lan.previewId).toBe("asset-1");
    expect(lan.previewKind).toBe("video");
    expect(Object.keys(lan)).not.toContain("previewPath");
    expect(Object.keys(lan)).not.toContain("secretPath");
  });

  it("omits fields that fail validation instead of forwarding them", () => {
    const bad = projectRemoteStatus({
      projectName: "x".repeat(201), resolution: "big", fps: -1, trackCount: 1.5, playhead: Number.NaN, playheadLabel: 5, status: { a: 1 }, previewKind: "script",
    }, "lan");
    expect(bad).toEqual({});
  });

  it("tolerates a missing or non-object snapshot", () => {
    expect(projectRemoteStatus(undefined, "relay")).toEqual({});
    expect(projectRemoteStatus([], "relay")).toEqual({});
  });
});
