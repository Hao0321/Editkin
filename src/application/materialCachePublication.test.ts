import { afterEach, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";
import { publishMaterialCache } from "./materialEvidenceCache";

const error = (code: string) => Object.assign(new Error(code), { code });
function operations() { return { rename: vi.fn(async (_a: PathLike, _b: PathLike) => {}), read: vi.fn(async (_path: string, _id: string) => undefined as never), wait: vi.fn(async (_ms: number) => {}) }; }
afterEach(() => vi.useRealTimers());
it.each(["EPERM", "EBUSY"])("retries a transient %s without deleting/replacing evidence", async code => {
  const ops = operations(); ops.rename.mockRejectedValueOnce(error(code));
  await expect(publishMaterialCache("owned-stage", "owned-final", "id", ops)).resolves.toBeUndefined();
  expect(ops.rename).toHaveBeenCalledTimes(2); expect(ops.read).toHaveBeenCalledTimes(2); expect(ops.wait).toHaveBeenCalledWith(50);
});
it("retains permanent denial and bounds delays to 750ms", async () => {
  const ops = operations(), refusal = error("EPERM"); ops.rename.mockRejectedValue(refusal);
  await expect(publishMaterialCache("stage", "final", "id", ops)).rejects.toBe(refusal);
  expect(ops.rename).toHaveBeenCalledTimes(5); expect(ops.wait.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBeLessThanOrEqual(750);
});
it.each(["EIO", "ENOENT", "EACCES"])("does not retry or hide real %s errors", async code => {
  const ops = operations(), refusal = error(code); ops.rename.mockRejectedValue(refusal);
  await expect(publishMaterialCache("stage", "final", "id", ops)).rejects.toBe(refusal);
  expect(ops.rename).toHaveBeenCalledTimes(1); expect(ops.wait).not.toHaveBeenCalled();
});
it("uses an already verified complete winner without attempting rename", async () => {
  const ops = operations(), winner = { marker: "verified fixture" }; ops.read.mockResolvedValueOnce(winner as never);
  await expect(publishMaterialCache("stage", "final", "id", ops)).resolves.toBe(winner); expect(ops.rename).not.toHaveBeenCalled();
});
it("revalidates a concurrent winner after rename denial", async () => {
  const ops = operations(), winner = { marker: "verified fixture" }; ops.rename.mockRejectedValueOnce(error("EEXIST")); ops.read.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce(winner as never);
  await expect(publishMaterialCache("stage", "final", "id", ops)).resolves.toBe(winner); expect(ops.wait).not.toHaveBeenCalled(); expect(ops.read).toHaveBeenCalledTimes(2);
});
it("never replaces an existing partial or corrupted directory", async () => {
  const ops = operations(); ops.read.mockRejectedValueOnce(error("invalid-existing-manifest"));
  await expect(publishMaterialCache("stage", "final", "id", ops)).rejects.toThrow("invalid-existing-manifest"); expect(ops.rename).not.toHaveBeenCalled();
});
it("does not retry over a corrupt concurrent winner", async () => {
  const ops = operations(); ops.rename.mockRejectedValueOnce(error("EPERM")); ops.read.mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(error("corrupt-winner"));
  await expect(publishMaterialCache("stage", "final", "id", ops)).rejects.toThrow("corrupt-winner"); expect(ops.wait).not.toHaveBeenCalled();
});
