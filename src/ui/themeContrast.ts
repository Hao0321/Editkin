import { EDITOR_THEMES, type EditorTheme } from "./theme";

export const REQUIRED_THEME_TOKENS = Object.freeze([
  "--bg",
  "--surface",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--ink",
  "--soft",
  "--muted",
  "--line",
  "--line-strong",
  "--accent",
  "--accent-2",
  "--accent-ink",
  "--accent-soft",
  "--accent-shadow",
  "--hot",
  "--success",
  "--warning",
  "--danger",
  "--focus-ring",
  "--disabled-bg",
  "--disabled-ink",
  "--disabled-line",
  "--preview-bg",
  "--grid",
  "--shadow",
] as const);

export interface ThemeCssSource {
  path: string;
  css: string;
}

export interface ThemeFinding {
  code: string;
  theme?: EditorTheme;
  detail: string;
}

interface ThemeBlock {
  selector: string;
  declarations: Record<string, string>;
}

export interface ThemeParityResult {
  passed: boolean;
  findings: ThemeFinding[];
  blockCounts: Record<EditorTheme, number>;
  tokenNames: Record<EditorTheme, string[]>;
}

export interface ThemeContrastMeasurement {
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  minimum: number;
  passed: boolean;
}

export interface ThemeContrastResult {
  passed: boolean;
  findings: ThemeFinding[];
  measurements: Record<EditorTheme, ThemeContrastMeasurement[]>;
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of body.split(";")) {
    const separator = raw.indexOf(":");
    if (separator < 0) continue;
    const property = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    if (property && value) result[property] = value;
  }
  return result;
}

export function parseThemeBlocks(css: string): Record<EditorTheme, ThemeBlock[]> {
  const blocks: Record<EditorTheme, ThemeBlock[]> = { sky: [], candy: [], volt: [] };
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1].trim();
    for (const theme of EDITOR_THEMES) {
      if (new RegExp(`:root\\[data-theme=["']${theme}["']\\]`, "u").test(selector)) {
        blocks[theme].push({ selector, declarations: declarations(match[2]) });
      }
    }
  }
  return blocks;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function themedSelectorMembers(selector: string): string[] {
  return selector.split(",").map((value) => value.trim()).filter(Boolean);
}

function expectedThemeSelector(theme: EditorTheme): string {
  return `:root[data-theme="${theme}"]`;
}

function hexRgb(value: string): [number, number, number] | undefined {
  const match = /^#([a-f\d]{6})$/iu.exec(value.trim());
  if (!match) return undefined;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16)) as [number, number, number];
}

function rgba(value: string): [number, number, number, number] | undefined {
  const match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0(?:\.\d+)?|\.\d+|1(?:\.0+)?)\s*\)$/iu.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function relativeLuminance(value: string): number | undefined {
  const rgb = hexRgb(value);
  if (!rgb) return undefined;
  const linear = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number | undefined {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === undefined || backgroundLuminance === undefined) return undefined;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function hueAndSaturation(value: string): { hue: number; saturation: number; lightness: number } | undefined {
  const rgb = hexRgb(value);
  if (!rgb) return undefined;
  const [red, green, blue] = rgb.map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = maximum === red
    ? ((green - blue) / delta) % 6
    : maximum === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, saturation, lightness };
}

export function evaluateThemeParity(themeCss: string, sources: ThemeCssSource[] = []): ThemeParityResult {
  const findings: ThemeFinding[] = [];
  const blocks = parseThemeBlocks(themeCss);
  const blockCounts = Object.fromEntries(EDITOR_THEMES.map((theme) => [theme, blocks[theme].length])) as Record<EditorTheme, number>;
  const tokenNames = Object.fromEntries(EDITOR_THEMES.map((theme) => [
    theme,
    Object.keys(blocks[theme][0]?.declarations ?? {}).filter((property) => property.startsWith("--")).sort(),
  ])) as Record<EditorTheme, string[]>;

  for (const source of sources) {
    if (/\[data-theme(?:=|\])/u.test(source.css) && normalizedPath(source.path) !== "src/ui/theme.css") {
      findings.push({ code: "theme-selector-outside-token-file", detail: normalizedPath(source.path) });
    }
  }

  for (const theme of EDITOR_THEMES) {
    if (blocks[theme].length !== 1) {
      findings.push({ code: "theme-block-count", theme, detail: `expected 1, received ${blocks[theme].length}` });
    }
    for (const candidate of blocks[theme]) {
      const members = themedSelectorMembers(candidate.selector);
      const expected = expectedThemeSelector(theme);
      if (!members.includes(expected) || members.some((member) => member !== expected && !(theme === "sky" && member === ":root"))) {
        findings.push({ code: "theme-selector-scope", theme, detail: candidate.selector });
      }
      for (const property of Object.keys(candidate.declarations)) {
        if (property !== "color-scheme" && !property.startsWith("--")) {
          findings.push({ code: "theme-layout-or-function-declaration", theme, detail: property });
        }
      }
      for (const [property, value] of Object.entries(candidate.declarations)) {
        if (/gradient\(|drop-shadow\(|filter\(/iu.test(value)) {
          findings.push({ code: "theme-gradient-or-glow", theme, detail: `${property}:${value}` });
        }
      }
    }
    const block = blocks[theme][0];
    if (!block) continue;
    const expectedScheme = "light";
    if (block.declarations["color-scheme"] !== expectedScheme) {
      findings.push({ code: "color-scheme", theme, detail: block.declarations["color-scheme"] ?? "missing" });
    }
    const names = tokenNames[theme];
    for (const required of REQUIRED_THEME_TOKENS) {
      if (!names.includes(required)) findings.push({ code: "missing-theme-token", theme, detail: required });
    }
    const extra = names.filter((name) => !REQUIRED_THEME_TOKENS.includes(name as (typeof REQUIRED_THEME_TOKENS)[number]));
    if (extra.length) findings.push({ code: "unexpected-theme-token", theme, detail: extra.join(",") });
    const { "--accent": accent, "--accent-2": accent2, "--hot": hot, "--focus-ring": focus } = block.declarations;
    if (!accent || accent !== accent2 || accent !== hot || accent !== focus) {
      findings.push({ code: "multiple-theme-accents", theme, detail: [accent, accent2, hot, focus].join(",") });
    }
    const accentColor = hueAndSaturation(accent ?? "");
    const hueAccepted = theme === "sky"
      ? Boolean(accentColor && accentColor.hue >= 205 && accentColor.hue <= 225)
      : theme === "candy"
        ? Boolean(accentColor && accentColor.hue >= 330 && accentColor.hue <= 350)
        : Boolean(accentColor && accentColor.hue >= 80 && accentColor.hue <= 115 && accentColor.saturation <= 0.55);
    if (!hueAccepted) findings.push({ code: "accent-family", theme, detail: accent ?? "missing" });
    const accentShadow = rgba(block.declarations["--accent-shadow"] ?? "");
    if (!accentShadow || Math.max(...accentShadow.slice(0, 3)) - Math.min(...accentShadow.slice(0, 3)) > 24
      || accentShadow[3] > (theme === "volt" ? 0.3 : 0.14)) {
      findings.push({ code: "colored-or-excessive-accent-glow", theme, detail: block.declarations["--accent-shadow"] ?? "missing" });
    }
    if (theme !== "volt") {
      for (const surfaceToken of ["--bg", "--surface", "--surface-1", "--surface-2", "--surface-3"]) {
        const value = block.declarations[surfaceToken] ?? "";
        const rgb = hexRgb(value);
        const luminance = relativeLuminance(value);
        if (!rgb || luminance === undefined || luminance < 0.8 || Math.max(...rgb) - Math.min(...rgb) > 20) {
          findings.push({ code: "light-surface-not-near-white", theme, detail: `${surfaceToken}:${value}` });
        }
      }
    }
  }

  const baselineTokens = JSON.stringify(tokenNames.sky);
  for (const theme of EDITOR_THEMES.filter((value) => value !== "sky")) {
    if (JSON.stringify(tokenNames[theme]) !== baselineTokens) {
      findings.push({ code: "theme-token-parity", theme, detail: "token names differ from sky" });
    }
  }

  return { passed: findings.length === 0, findings, blockCounts, tokenNames };
}

const CONTRAST_PAIRS = Object.freeze([
  ["ink/surface", "--ink", "--surface", 4.5],
  ["soft/surface", "--soft", "--surface", 4.5],
  ["muted/surface", "--muted", "--surface", 4.5],
  ["ink/surface-2", "--ink", "--surface-2", 4.5],
  ["muted/surface-2", "--muted", "--surface-2", 4.5],
  ["accent/surface", "--accent", "--surface", 4.5],
  ["accent/accent-soft", "--accent", "--accent-soft", 4.5],
  ["accent-ink/accent", "--accent-ink", "--accent", 4.5],
  ["success/surface", "--success", "--surface", 4.5],
  ["warning/surface", "--warning", "--surface", 4.5],
  ["danger/surface", "--danger", "--surface", 4.5],
  ["focus/surface", "--focus-ring", "--surface", 3],
  ["line-strong/surface", "--line-strong", "--surface", 3],
  ["disabled-ink/disabled-bg", "--disabled-ink", "--disabled-bg", 3],
  ["disabled-line/disabled-bg", "--disabled-line", "--disabled-bg", 3],
] as const);

export function evaluateThemeContrast(themeCss: string): ThemeContrastResult {
  const findings: ThemeFinding[] = [];
  const blocks = parseThemeBlocks(themeCss);
  const measurements: Record<EditorTheme, ThemeContrastMeasurement[]> = { sky: [], candy: [], volt: [] };
  for (const theme of EDITOR_THEMES) {
    const tokens = blocks[theme][0]?.declarations ?? {};
    for (const [pair, foregroundToken, backgroundToken, minimum] of CONTRAST_PAIRS) {
      const foreground = tokens[foregroundToken] ?? "missing";
      const background = tokens[backgroundToken] ?? "missing";
      const ratio = contrastRatio(foreground, background);
      const passed = ratio !== undefined && ratio >= minimum;
      measurements[theme].push({ pair, foreground, background, ratio: ratio ?? 0, minimum, passed });
      if (!passed) findings.push({ code: "contrast", theme, detail: `${pair}:${(ratio ?? 0).toFixed(3)}<${minimum}` });
    }
  }
  return { passed: findings.length === 0, findings, measurements };
}
