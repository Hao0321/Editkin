import { expect, it, vi } from "vitest";
import { withRenderLifetime } from "./renderLifetime";
const fixture = vi.hoisted(() => ({ controller: new AbortController(), reason: new Error("hardware probe cancelled") }));
vi.mock("./ffmpegMedia", async importOriginal => ({ ...await importOriginal<typeof import("./ffmpegMedia")>(), runProcess: vi.fn(async () => {
  fixture.controller.abort(fixture.reason); throw fixture.reason;
}) }));
import { chooseEncoder } from "./ffmpegComposite";

it("propagates cancellation from a started hardware probe instead of selecting CPU fallback", async () => {
  if (!["win32", "darwin"].includes(process.platform)) return;
  await expect(withRenderLifetime({ signal: fixture.controller.signal }, () => chooseEncoder("owned-probe", true, 1_000, false))).rejects.toBe(fixture.reason);
});
