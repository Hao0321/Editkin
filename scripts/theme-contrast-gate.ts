import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { evaluateThemeContrast, evaluateThemeParity, type ThemeCssSource } from "../src/ui/themeContrast";

const root = resolve(import.meta.dirname, "..");
const themePath = resolve(root, "src/ui/theme.css");

async function cssSources(directory: string): Promise<ThemeCssSource[]> {
  const result: ThemeCssSource[] = [];
  const visit = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const target = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".css")) {
        result.push({ path: relative(root, target).replaceAll("\\", "/"), css: await readFile(target, "utf8") });
      }
    }
  };
  await visit(directory);
  return result;
}

const themeCss = await readFile(themePath, "utf8");
const sources = await cssSources(resolve(root, "src"));
const parity = evaluateThemeParity(themeCss, sources);
const contrast = evaluateThemeContrast(themeCss);

if (process.argv.includes("--self-test")) {
  const layoutRejected = !evaluateThemeParity(`${themeCss}\n:root[data-theme="sky"] { visibility: hidden; }`).passed;
  const lowContrastRejected = !evaluateThemeContrast(themeCss.replace("--muted: #5b6678", "--muted: #d8dee8")).passed;
  const mixedAccentRejected = !evaluateThemeParity(themeCss.replace("--accent-2: #175cd3", "--accent-2: #7c3aed")).passed;
  const gradientRejected = !evaluateThemeParity(themeCss.replace("--accent-shadow: rgba(17,24,39,.12)", "--accent-shadow: linear-gradient(#175cd3,#7c3aed)")).passed;
  const missingTokenRejected = !evaluateThemeParity(themeCss.replace("--disabled-line: #7c8796;", "")).passed;
  const green = parity.passed && contrast.passed && layoutRejected && lowContrastRejected
    && mixedAccentRejected && gradientRejected && missingTokenRejected;
  process.stdout.write(`${JSON.stringify({
    status: green ? "GREEN" : "FAIL",
    positiveControl: { parity: parity.passed, contrast: contrast.passed },
    negativeControls: { layoutRejected, lowContrastRejected, mixedAccentRejected, gradientRejected, missingTokenRejected },
  })}\n`);
  if (!green) process.exitCode = 1;
} else {
  const status = parity.passed && contrast.passed ? "GREEN_THEME_CONTRAST_PARITY" : "FAIL";
  const report = {
    schema: "editkin.theme-contrast-parity/v1",
    status,
    checks: {
      contrast: contrast.passed,
      tokenOnlyThemeSelectors: parity.passed,
      sharedDomLayoutFeatureContract: parity.passed,
    },
    parity,
    contrast,
    claimBoundary: "Source-enforced token parity and WCAG contrast floors; does not replace rendered assistive-technology or human visual review.",
  };
  const reportPath = resolve(root, ".rd/benchmarks/editkin-theme-contrast/report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status, report: reportPath })}\n`);
  if (status === "FAIL") process.exitCode = 1;
}
