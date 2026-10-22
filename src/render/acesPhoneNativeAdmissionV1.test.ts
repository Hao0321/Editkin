import { expect, it } from "vitest";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { buildAces2DisplayVideoRenderRequest } from "./aces2SdrVideo";
import { buildGpuRenderGraph } from "./gpuCompositor";

it("refuses the fixed old scene-linear native output for the new BT.1886 recipe", () => {
  const p = createPhoneProjectV1(); p.colorManagement!.mode = "aces2";
  expect(() => buildAces2DisplayVideoRenderRequest(p)).toThrow(/BT.1886.*not implemented/);
});
it("declines native GPU phone output instead of dropping the new display recipe", () => {
  const p = createPhoneProjectV1(); p.colorManagement!.mode = "aces2";
  expect(buildGpuRenderGraph(p, 0)).toBeUndefined();
});
