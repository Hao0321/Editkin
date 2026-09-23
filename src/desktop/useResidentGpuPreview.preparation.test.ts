import { afterEach, describe, expect, it, vi } from "vitest";
const memo = vi.hoisted(() => ({ entries: [] as Array<{ deps: unknown[]; value: unknown }>, index: 0 }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, () => {}],
  useEffect: () => {},
  useMemo: (build: () => unknown, deps: unknown[]) => {
    const index = memo.index++, prior = memo.entries[index];
    if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i]))) memo.entries[index] = { deps, value: build() };
    return memo.entries[index].value;
  },
}));
import { createDemoProject } from "../domain/demo";
import * as preparation from "./residentGpuGraphPreparation";
import { useResidentGpuPreview } from "./useResidentGpuPreview";
afterEach(() => { vi.restoreAllMocks(); memo.entries = []; memo.index = 0; });
describe("resident graph hook compilation boundary", () => {
  it("compiles once across playhead and surface changes, then invalidates on project changes", () => {
    const compile = vi.spyOn(preparation, "prepareResidentGpuGraphs");
    let project = createDemoProject();
    const render = (time: number, enabled = true) => { memo.index = 0; useResidentGpuPreview(project, time, enabled, { x: 0, y: 0, width: 960, height: 540, revision: time }); };
    for (let frame = 0; frame < 120; frame++) render(frame / 30);
    expect(compile).toHaveBeenCalledTimes(1);
    project = structuredClone(project); render(4); expect(compile).toHaveBeenCalledTimes(2);
    project.revision++; render(4.1); expect(compile).toHaveBeenCalledTimes(3);
    render(4.2, false); expect(compile).toHaveBeenCalledTimes(3);
    render(4.3); expect(compile).toHaveBeenCalledTimes(4);
  });
});
