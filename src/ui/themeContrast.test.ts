import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_PARITY_CONTRACT } from "./theme";
import { evaluateThemeContrast, evaluateThemeParity, type ThemeCssSource } from "./themeContrast";

const themePath = fileURLToPath(new URL("./theme.css", import.meta.url));
const sourceRoot = dirname(dirname(themePath));
const themeCss = readFileSync(themePath, "utf8");

function cssSources(root: string): ThemeCssSource[] {
  const result: ThemeCssSource[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".css")) {
        result.push({ path: `src/${relative(sourceRoot, path).replaceAll("\\", "/")}`, css: readFileSync(path, "utf8") });
      }
    }
  };
  visit(root);
  return result;
}

describe("theme contrast and parity contract", () => {
  it("keeps every theme token-only with the same DOM, feature and layout contract", () => {
    expect(THEME_PARITY_CONTRACT).toMatchObject({
      mechanism: "root-data-theme-css-custom-properties-only",
      sharedDom: true,
      sharedFeatures: true,
      sharedLayout: true,
      sharedSpacing: true,
      sharedBreakpoints: true,
    });
    expect(evaluateThemeParity(themeCss, cssSources(sourceRoot))).toMatchObject({ passed: true, findings: [] });
  });

  it("meets text, accent, focus, boundary and disabled contrast floors", () => {
    const result = evaluateThemeContrast(themeCss);
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
    expect(Object.values(result.measurements).flat().every((measurement) => measurement.passed)).toBe(true);
  });

  it("calibrates layout, low-contrast and mixed-accent negative controls", () => {
    const layoutMutation = `${themeCss}\n:root[data-theme="candy"] { display: none; }`;
    const lowContrastMutation = themeCss.replace("--muted: #5b6678", "--muted: #cbd5e1");
    const mixedAccentMutation = themeCss.replace("--accent-2: #175cd3", "--accent-2: #7c3aed");
    expect(evaluateThemeParity(layoutMutation).findings.some((finding) => finding.code === "theme-layout-or-function-declaration")).toBe(true);
    expect(evaluateThemeContrast(lowContrastMutation).passed).toBe(false);
    expect(evaluateThemeParity(mixedAccentMutation).findings.some((finding) => finding.code === "multiple-theme-accents")).toBe(true);
  });
});
