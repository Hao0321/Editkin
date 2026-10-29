import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productionTemplateShortDeps } from "./templateShortTools";
import { workspaceRoot } from "./storage";
import { multiShortDiskNeed } from "../application/multiSourceShortRecipeV2";

describe("Short output-drive disk preflight", () => {
  it("checks the output workspace drive despite OS TEMP being on another disk", () => {
    const deps = productionTemplateShortDeps({ TEMP: "C:\\Users\\Example\\Temp", TMP: "C:\\Temp" });
    expect(deps.tempDirectory()).toBe(resolve(workspaceRoot()));
  });
  it("keeps explicit render workspace selection in the same preflight", () => {
    expect(productionTemplateShortDeps({ EDITKIN_RENDER_WORK_ROOT: "E:\\OwnedRender" }).tempDirectory()).toBe("E:\\OwnedRender");
  });
  it("combines 20-40s temporary and delivery allocations on the actual output drive", () => {
    const twenty = multiShortDiskNeed(600), forty = multiShortDiskNeed(1200);
    expect(twenty.workspace).toBe("beside-output");
    expect(twenty.combinedBytes).toBe(twenty.temporaryBytes + twenty.outputBytes);
    expect(forty.combinedBytes).toBeGreaterThan(twenty.combinedBytes);
    expect(() => multiShortDiskNeed(450)).toThrow();
    expect(() => multiShortDiskNeed(1201)).toThrow();
  });
});
