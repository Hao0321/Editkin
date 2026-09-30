import { describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_BYTES } from "./constants";
import { probeWithFetch } from "./probe";

const probeId = "a".repeat(32);
const healthy = () => new Response(JSON.stringify({ schema: "editkin.remote-health/v1", probeId }), { status: 200 });

describe("remote onboarding probe transport", () => {
  it("issues a redirect-refusing, uncached GET and accepts only the exact challenge", async () => {
    const fetchImpl = vi.fn(async () => healthy());
    expect((await probeWithFetch("https://remote.example.com/api/health", fetchImpl, probeId)).ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect((await probeWithFetch("https://remote.example.com/api/health", async () => healthy(), "b".repeat(32))).ok).toBe(false);
    const wrongSchema = new Response(JSON.stringify({ schema: "other", probeId }), { status: 200 });
    expect((await probeWithFetch("https://remote.example.com/api/health", async () => wrongSchema, probeId)).ok).toBe(false);
  });

  it("does not read a body from non-200 responses and reports network failure as not ok", async () => {
    const rejected = new Response(JSON.stringify({ schema: "editkin.remote-health/v1", probeId }), { status: 503 });
    expect((await probeWithFetch("https://remote.example.com", async () => rejected, probeId)).ok).toBe(false);
    const failed = await probeWithFetch("https://remote.example.com", async () => { throw new Error("offline"); }, probeId);
    expect(failed.ok).toBe(false);
    expect(failed.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("without a challenge only accepts the Editkin Remote marker and stops reading at the byte cap", async () => {
    expect((await probeWithFetch("https://relay.example.com", async () => new Response("<h1>Editkin Remote</h1>", { status: 200 }))).ok).toBe(true);
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new Uint8Array(MAX_RESPONSE_BYTES / 2).fill(0x61);
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const result = await probeWithFetch("https://relay.example.com", async () => new Response(body, { status: 200 }));
    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + MAX_RESPONSE_BYTES / 2);
  });
});
