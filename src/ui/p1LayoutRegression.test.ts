import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// Source guards for measured desktop defects; not a substitute for rendered geometry.
function value(file: string, selector: string, property: string): string | undefined {
  let result: string | undefined;
  const css = postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  for (const node of css.nodes) if (node.type === "rule" && node.selector === selector) node.walkDecls(property, d => { result = d.value.replace(/\s+/g, ""); });
  return result;
}
describe("P1 measured layout regressions", () => {
  it("lets the timeline row fit its actual toolbar height", () => {
    expect(value("./timelineDirectManipulation.css", ".timeline-shell", "grid-template-rows")).toBe("autominmax(0,1fr)");
  });
  it("keeps compact music text horizontal despite the legacy two-column button", () => {
    expect(value("./creativeLibraryBrowser.css", ".visual-library .auto-music-button.compact", "display")).toBe("inline-flex");
    expect(value("./creativeLibraryBrowser.css", ".visual-library .auto-music-button.compact", "white-space")).toBe("nowrap");
  });
  it("uses compact inline counters in the dock", () => {
    expect(value("./directorConsole.css", ".director-dock .director-summary", "grid-template-columns")).toBe("repeat(3,minmax(0,1fr))");
    expect(value("./directorConsole.css", ".director-dock .director-summary div", "padding")).toBe("0");
  });
});
