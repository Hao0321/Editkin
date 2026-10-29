import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { timelineTransitionLinearShaderV1 } from "./timelineTransitionMixV1";

it("native paired texture pass uses exactly the frontend canonical WGSL byte source", async () => {
  const actual = await readFile(resolve("spikes/gpu-compositor/src/timeline_transition_v1.wgsl"));
  expect(actual).toEqual(Buffer.from(timelineTransitionLinearShaderV1(), "utf8"));
});
