/**
 * Editkin Original Elements — Collection 01, the set Hao preferred on
 * 2026-10-03 (「坦白說這一版比較好看」), ported verbatim from the research source
 * `sozaiya-elements-20261003/pack.mjs` (editkin-elements-candidate/1: original
 * parameterized vector designs, no reference-site assets or code). Palettes,
 * copy limits, layout fitting and geometry are kept as authored; Editkin adds
 * the native adapter (motion/originalElementGraphics.ts) and Motion Language
 * choreography. Art Edition 02 stays a separate, retained source.
 */
export const ORIGINAL_ELEMENTS_VERSION = "editkin-elements-candidate/1" as const;

export interface OriginalElementTheme { name: string; primary: string; paper: string; ink: string; accent: string; grid: string }
export const ORIGINAL_ELEMENT_THEMES: Readonly<Record<"editkin" | "vermilion" | "midnight", Readonly<OriginalElementTheme>>> = Object.freeze({
  editkin: { name: "Editkin 藍白", primary: "#2457F5", paper: "#F4F4F0", ink: "#111316", accent: "#A7E8FA", grid: "#D4D6DC" },
  vermilion: { name: "朱紅 × 奶油", primary: "#B73235", paper: "#FFF3E5", ink: "#2B1B22", accent: "#FFC96B", grid: "#E6D2C5" },
  midnight: { name: "午夜 × 檸檬", primary: "#FAC64D", paper: "#161F35", ink: "#F5F6FC", accent: "#59DED1", grid: "#394658" },
});
export type OriginalElementThemeId = keyof typeof ORIGINAL_ELEMENT_THEMES;

export const ORIGINAL_ELEMENTS = Object.freeze([
  { id: "keyword-sticker", name: "重點字貼", use: "一句值得記住的主張", intent: "emphasis", title: "一起把想法做出來", detail: "你的能力，可以接上別人的能力", tag: "MAKE IT REAL", maxTitle: 24 },
  { id: "conversation-bubble", name: "對話泡泡", use: "真正的疑問或心聲", intent: "question", title: "有人想一起做嗎？", detail: "先讓別人知道，你想完成什麼。", tag: "LET’S TALK", maxTitle: 24 },
  { id: "field-note", name: "手記標籤", use: "有素材佐證的地点或觀察", intent: "observation", title: "創作的第一站", detail: "把沿途遇見的好點子記下來", tag: "FIELD NOTES", maxTitle: 28 },
  { id: "chapter-ticket", name: "章節票卡", use: "真正的段落交接", intent: "chapter", title: "先找到你的夥伴", detail: "從認識彼此，走到一起完成", tag: "NEXT CHAPTER", maxTitle: 28 },
  { id: "focus-bracket", name: "操作框選", use: "綁定看過的真實操作目標", intent: "ui-focus", title: "看這個選項", detail: "", tag: "LOOK HERE", maxTitle: 14 },
  { id: "reaction-seal", name: "反應貼紙", use: "旁白已有的驚喜或發現", intent: "reaction", title: "原來可以這樣！", detail: "想法，開始有了下一步", tag: "AHA!", maxTitle: 18 },
  { id: "step-path", name: "步驟連線", use: "解釋兩到三項真實關係", intent: "process", title: "讓能力接起來", detail: "能力／夥伴／一起做", tag: "CONNECT THE DOTS", maxTitle: 24 },
  { id: "recap-strip", name: "重點回顧", use: "收束已講過的重點", intent: "recap", title: "把下一步，真的做出來", detail: "找到夥伴／開始做／把作品發出去", tag: "TAKE IT WITH YOU", maxTitle: 28 },
] as const);
export type OriginalElementId = typeof ORIGINAL_ELEMENTS[number]["id"];

export interface OriginalElementTarget { x: number; y: number; w: number; h: number; sourceId: string; observed: boolean; visibleFrom: number; visibleTo: number }
export interface OriginalElementConfig {
  id: OriginalElementId; title: string; detail: string; tag: string;
  theme: OriginalElementThemeId; colors?: Partial<Omit<OriginalElementTheme, "name">>;
  aspect: "landscape" | "portrait"; mode: "scene" | "overlay"; duration: number; number: string;
  target: OriginalElementTarget | null; firstFrameReadable?: boolean; subtitleConflict?: boolean;
}

/** Synchronous physical measure: advance width and ink bounds at a size. */
export interface ElementMeasure {
  (text: string, size: number, family: string, weight: number): number;
  bounds(text: string, size: number, family: string, weight: number): { left: number; right: number; ascent: number; descent: number };
}

export type ElementShapeType = "rect" | "line" | "circle" | "path" | "text";
/** `role` names the design part (shadow, plate, stitch…) for choreography only; geometry stays in attrs. */
export interface ElementShape { type: ElementShapeType; attrs: Record<string, string | number>; group: string; role: string }
export interface ElementIr {
  version: typeof ORIGINAL_ELEMENTS_VERSION; config: OriginalElementConfig; width: number; height: number; subtitleBottomPx: number;
  theme: OriginalElementTheme & { onPrimary: string; onAccent: string }; shapes: ElementShape[];
  textZones: Array<{ x: number; y: number; w: number; h: number }>; holdSeconds: number;
  /** The research source's own single-group motion, kept for comparison. */
  sourceMotion: { entrySeconds: number; translateXPx: number; translateYPx: number; scaleFrom: number };
  sceneTransform: string;
}

export class OriginalElementError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const reject = (code: string, message: string): never => { throw new OriginalElementError(code, message); };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const n = (value: number) => Number(value.toFixed(3));
const isColor = (value: unknown) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
export const graphemes = (value: string) => [...segmenter.segment(value)].map(part => part.segment);

function luminance(hex: string): number {
  return [.2126, .7152, .0722].reduce((sum, weight, index) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return sum + weight * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  }, 0);
}
export function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
const onColor = (background: string) => contrast("#FFFFFF", background) > contrast("#111316", background) ? "#FFFFFF" : "#111316";

export function defaultOriginalElementConfig(id: OriginalElementId = "keyword-sticker"): OriginalElementConfig {
  const element = ORIGINAL_ELEMENTS.find(item => item.id === id) ?? reject("UNKNOWN_ELEMENT", "未知元件");
  return { id, title: element.title, detail: element.detail, tag: element.tag, theme: "editkin", aspect: "landscape", mode: "scene", duration: 8, number: "01",
    target: id === "focus-bracket" ? { x: .23, y: .30, w: .47, h: .25, sourceId: "design-fixture-not-real-ui", observed: true, visibleFrom: 0, visibleTo: 8 } : null };
}

export function validateOriginalElement(config: OriginalElementConfig) {
  const element = ORIGINAL_ELEMENTS.find(item => item.id === config.id) ?? reject("UNKNOWN_ELEMENT", "未知元件");
  if (!["landscape", "portrait"].includes(config.aspect)) reject("BAD_ASPECT", "只支援橫式或直式");
  if (!["scene", "overlay"].includes(config.mode)) reject("BAD_MODE", "只支援概念場景或透明元素");
  for (const key of ["title", "detail", "tag"] as const) if (typeof config[key] !== "string" || /[\u0000-\u001F\u007F]/.test(config[key])) reject("BAD_TEXT", "文字不可包含控制字元");
  if (!config.title.trim()) reject("EMPTY_TITLE", "請填入主標");
  if (graphemes(config.title).length > element.maxTitle) reject("TITLE_TOO_LONG", `這個元件主標最多 ${element.maxTitle} 字；請拆成下一幕。`);
  if (graphemes(config.detail).length > 44) reject("DETAIL_TOO_LONG", "支持句最多 44 字；請拆幕。");
  if (graphemes(config.tag).length > 24) reject("TAG_TOO_LONG", "標籤最多 24 字");
  if (typeof config.number !== "string" || !/^\d{2}$/.test(config.number)) reject("BAD_NUMBER", "章節號需兩位數");
  const base = ORIGINAL_ELEMENT_THEMES[config.theme] ?? reject("BAD_THEME", "未知配色");
  const theme = { ...base, ...config.colors };
  for (const key of ["primary", "paper", "ink", "accent", "grid"] as const) if (!isColor(theme[key])) reject("BAD_COLOR", "顏色請填 #RRGGBB");
  if (contrast(theme.ink, theme.paper) < 4.5) reject("LOW_TEXT_CONTRAST", "主文字與紙面對比不足，請調整配色。");
  const onPrimary = onColor(theme.primary), onAccent = onColor(theme.accent);
  if (contrast(theme.primary, theme.paper) < 3) reject("LOW_MARKER_CONTRAST", "主色與背景太接近，框選與線條會看不清楚。");
  if (contrast(onPrimary, theme.primary) < 4.5 || contrast(onAccent, theme.accent) < 4.5) reject("LOW_FILL_TEXT_CONTRAST", "色面上的文字對比不足，請調整主色或點綴色。");
  if (contrast(theme.primary, theme.paper) < 4.5) reject("LOW_TAG_CONTRAST", "小標的主色與紙面對比不足，請加深或改變配色。");
  if (config.id === "step-path" || config.id === "recap-strip") {
    const steps = config.detail.split("／").map(step => step.trim());
    if (steps.length !== 3 || steps.some(step => !step || graphemes(step).length > 9)) reject("BAD_STEPS", "請用「／」隔開三個重點，每個最多九字。");
  }
  const hold = Math.max(1.6, graphemes(config.title + config.detail).length / 7);
  if (!finite(config.duration) || config.duration < hold + .44 || config.duration > 20) reject("BAD_DURATION", `需至少 ${(hold + .44).toFixed(2)} 秒，最多 20 秒，才能完整讀完。`);
  if (config.id === "focus-bracket") {
    const b = config.target;
    if (!b || b.observed !== true || typeof b.sourceId !== "string" || !b.sourceId.trim()) reject("MISSING_TARGET", "框選必須先有看過的來源與目標框；不能猜位置。");
    if (!(["x", "y", "w", "h", "visibleFrom", "visibleTo"] as const).every(key => finite(b![key]))) reject("BAD_TARGET", "目標框或時間不是數值");
    const bottom = config.aspect === "landscape" ? 200 / 1080 : 320 / 1920;
    if (b!.x < .06 || b!.y < .12 || b!.w <= 0 || b!.h <= 0 || b!.x + b!.w > .94 || b!.y + b!.h > 1 - bottom - .02) reject("TARGET_OUT_OF_SAFE", "目標框超出安全區；請重新定位或改用另一個鏡頭。");
    if (b!.visibleFrom !== 0 || b!.visibleTo < config.duration) reject("TARGET_DISAPPEARS", "捲動或換頁前框選必須退場或重定位。");
  }
  if (config.subtitleConflict === true) reject("SUBTITLE_CONFLICT", "元素會碰到字幕；先重新安排位置。");
  if (config.firstFrameReadable !== undefined && typeof config.firstFrameReadable !== "boolean") reject("BAD_FIRST_FRAME", "首幀選項必須是布林值");
  return { element, theme: { ...theme, onPrimary, onAccent }, hold };
}

function breakLines(text: string, maxWidth: number, size: number, measure: ElementMeasure, family = "Noto Sans TC", weight = 900): string[] {
  const lines: string[] = []; let line = "";
  for (const ch of graphemes(text)) { if (measure(line + ch, size, family, weight) > maxWidth && line) { lines.push(line); line = ch; } else line += ch; }
  if (line) lines.push(line); return lines;
}
function balanceLines(text: string, lines: string[], maxWidth: number, size: number, measure: ElementMeasure, family: string, weight: number): string[] {
  if (lines.length < 2 || !/[㐀-鿿]/.test(text)) return lines;
  const chars = graphemes(text), N = chars.length, K = lines.length;
  const dp: Array<Array<{ cost: number; lines: string[] } | null>> = Array.from({ length: K + 1 }, () => Array(N + 1).fill(null));
  dp[0][0] = { cost: 0, lines: [] };
  for (let row = 1; row <= K; row++) for (let end = row; end <= N; end++) for (let start = row - 1; start < end; start++) {
    const previous = dp[row - 1][start]; if (!previous) continue;
    const value = chars.slice(start, end).join("");
    if (/^[，。！？、；：,.!?;:）】」』]/.test(value) || /[（【「『]$/.test(value)) continue;
    if (end < N && /[A-Za-z0-9]/.test(chars[end - 1]) && /[A-Za-z0-9]/.test(chars[end])) continue;
    const width = measure(value, size, family, weight); if (width > maxWidth + .1) continue;
    const cost = previous.cost + (maxWidth - width) ** 2 + (end - start === 1 ? maxWidth ** 2 * 8 : 0);
    if (!dp[row][end] || cost < dp[row][end]!.cost) dp[row][end] = { cost, lines: [...previous.lines, value] };
  }
  return dp[K][N]?.lines ?? lines;
}
interface Fit { lines: string[]; size: number; step: number; height: number; ascent: number; family: string; weight: number }
function fit(text: string, box: { w: number; h: number }, measure: ElementMeasure,
  { max = 148, min = 82, maxLines = 4, family = "Noto Sans TC", weight = 900 }: { max?: number; min?: number; maxLines?: number; family?: string; weight?: number } = {}): Fit {
  for (let rows = 1; rows <= maxLines; rows++) for (let size = max; size >= min; size -= 2) {
    let lines = breakLines(text, box.w - 8, size, measure, family, weight);
    const m = measure.bounds(text, size, family, weight), step = m.ascent + m.descent + size * .035, height = (lines.length - 1) * step + m.ascent + m.descent;
    if (lines.length <= rows && height <= box.h && lines.every(line => measure(line, size, family, weight) <= box.w - 8 + .1)) {
      lines = balanceLines(text, lines, box.w - 8, size, measure, family, weight);
      return { lines, size, step, height, ascent: m.ascent, family, weight };
    }
  }
  return reject("LAYOUT_OVERFLOW", "這段文字無法維持可讀字級；請縮短或拆幕。");
}

/**
 * `finish` adds Editkin's studio detail pass on top of the authored design
 * (Hao 2026-10-06：「美術可以加更多細節…要超專業的 Motion Graphic」): two-tone
 * lead wipes, glints, impact bursts, rings, typing dots, tape, rulers, barcodes,
 * scan lines, progress rails and check marks. Without it the output is the
 * research source shape for shape (see scripts/check-original-elements-port.ts).
 * Roles prefixed `fx-` are one-shot effects; their `data-sweep-*` attrs give
 * the travel of sweeping effects in design pixels.
 */
export function buildOriginalElement(config: OriginalElementConfig, measure: ElementMeasure, options: { finish?: boolean } = {}): ElementIr {
  const { element: e, theme: t, hold } = validateOriginalElement(config);
  const W = config.aspect === "landscape" ? 1920 : 1080, H = config.aspect === "landscape" ? 1080 : 1920;
  const P = H > W, bottom = P ? 320 : 200, area = { x: 92, y: 104, w: W - 184, h: H - bottom - 176 };
  const shapes: ElementShape[] = [], textZones: ElementIr["textZones"] = [];
  let currentPart: string | undefined;
  const part = (name: string, draw: () => unknown) => { const previous = currentPart; currentPart = name; try { draw(); } finally { currentPart = previous; } };
  const shape = (type: ElementShapeType, attrs: ElementShape["attrs"], group = "plate") => { shapes.push({ type, attrs, group, role: currentPart ?? group }); return shapes.at(-1)!; };
  const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0, stroke = "none", sw = 0, group = "plate") =>
    shape("rect", { x: n(x), y: n(y), width: n(w), height: n(h), rx: n(rx), fill, stroke, "stroke-width": sw }, group);
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, sw = 4, group = "detail") =>
    shape("line", { x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2), stroke, "stroke-width": sw, "stroke-linecap": "round" }, group);
  const circle = (cx: number, cy: number, r: number, fill: string, group = "ornament") => shape("circle", { cx: n(cx), cy: n(cy), r: n(r), fill }, group);
  const path = (d: string, fill: string, stroke = "none", sw = 0, group = "plate") => shape("path", { d, fill, stroke, "stroke-width": sw, "stroke-linejoin": "round" }, group);
  const text = (content: string, x: number, y: number, size: number, fill: string, group = "headline", weight = 900, family = "Noto Sans TC", zone?: ElementIr["textZones"][number]) => {
    const m = measure.bounds(content, size, family, weight);
    const z = zone ?? { x: x - Math.max(2, m.left) - 2, y: y - m.ascent - 2, w: Math.max(measure(content, size, family, weight), m.right) + Math.max(2, m.left) + 4, h: m.ascent + m.descent + 4 };
    textZones.push(z);
    shape("text", { x: n(x), y: n(y), "font-size": n(size), "font-weight": weight, "font-family": family, fill, "data-zone": textZones.length - 1, "data-content": content }, group);
  };
  const block = (content: string, box: { x: number; y: number; w: number; h: number }, fill: string, opts: Parameters<typeof fit>[3] = {}, group = "headline") => {
    if (config.mode === "overlay" && group === "detail" && (e.id === "keyword-sticker" || e.id === "reaction-seal")) rect(box.x - 12, box.y - 12, box.w + 24, box.h + 24, t.paper, 12, "none", 0, "detail");
    const f = fit(content, box, measure, opts), top = box.y + (box.h - f.height) / 2;
    f.lines.forEach((value, index) => text(value, box.x + 4, top + f.ascent + index * f.step, f.size, fill, group, f.weight, f.family, { ...box }));
    return f;
  };
  const tagFont = (value: string) => /[^\x20-\x7E’]/.test(value) ? { family: "Noto Sans TC", weight: 700 } : { family: "Bebas Neue", weight: 400 };
  const tag = (value: string, x: number, y: number, color = t.primary) => {
    const f = tagFont(value);
    if (config.mode === "overlay" && color === t.primary) { const m = measure.bounds(value, 32, f.family, f.weight); rect(x - 12, y - m.ascent - 6, measure(value, 32, f.family, f.weight) + 24, m.ascent + m.descent + 12, t.paper, 6, "none", 0, "detail"); }
    text(value, x, y, 32, color, "detail", f.weight, f.family);
  };
  const cross = (x: number, y: number, s = 22, fill = t.primary) => { rect(x - s / 2, y - s * 1.4, s, s * 2.8, fill, 0, "none", 0, "ornament"); rect(x - s * 1.4, y - s / 2, s * 2.8, s, fill, 0, "none", 0, "ornament"); };
  const grid = (x: number, y: number, w: number, h: number, group = "background") => {
    for (let gx = x; gx <= x + w; gx += 64) line(gx, y, gx, y + h, t.grid, 1.5, group);
    for (let gy = y; gy <= y + h; gy += 64) line(x, gy, x + w, gy, t.grid, 1.5, group);
  };
  // ---- studio finish helpers (Editkin addition; only drawn when options.finish)
  const F = options.finish === true, O = config.mode === "overlay";
  const poly = (points: Array<[number, number]>, fill: string, group = "fx") => path(`M${points.map(([px, py]) => `${n(px)},${n(py)}`).join(" L")} Z`, fill, "none", 0, group);
  const ring = (cx: number, cy: number, r: number, stroke: string, sw = 4, group = "fx") => shape("circle", { cx: n(cx), cy: n(cy), r: n(r), fill: "none", stroke, "stroke-width": sw }, group);
  const star = (cx: number, cy: number, r: number, fill: string) => poly([[cx, cy - r], [cx + r * .26, cy - r * .26], [cx + r, cy], [cx + r * .26, cy + r * .26],
    [cx, cy + r], [cx - r * .26, cy + r * .26], [cx - r, cy], [cx - r * .26, cy - r * .26]], fill, "ornament");
  /** A slanted glint that rests centred in [x0,x1]×[y0,y1] and sweeps ±sweep/2 without leaving it. */
  const glint = (x0: number, y0: number, x1: number, y1: number, width: number, slant: number, alpha: string) => {
    const cx = (x0 + x1) / 2;
    poly([[cx - width / 2 + slant, y0], [cx + width / 2 + slant, y0], [cx + width / 2 - slant, y1], [cx - width / 2 - slant, y1]], `#FFFFFF${alpha}`).attrs["data-sweep-x"] = n(Math.max(0, x1 - x0 - width - 2 * slant));
  };
  const burst = (cx: number, cy: number, rx: number, ry: number, length: number, count: number, stroke: string, sw: number, phase: number) => {
    for (let i = 0; i < count; i++) { const a = phase + Math.PI * 2 * i / count, c = Math.cos(a), s = Math.sin(a); line(cx + c * rx, cy + s * ry, cx + c * (rx + length), cy + s * (ry + length), stroke, sw, "fx"); }
  };
  const ruler = (x: number, y: number, count: number, step: number, stroke: string) => { for (let i = 0; i < count; i++) line(x + i * step, y, x + i * step, y - (i % 4 === 0 ? 16 : 8), stroke, 2.5, "ornament"); };
  const barcode = (x0: number, y0: number, x1: number, y1: number, fill: string) => {
    let seed = [...(config.number + config.tag)].reduce((sum, ch) => (sum * 31 + ch.codePointAt(0)!) >>> 0, 7);
    const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let x = x0; ;) { const w = [3, 3, 5, 8][Math.floor(next() * 4)]; if (x + w > x1) break; rect(x, y0, w, y1 - y0, fill, 0, "none", 0, "detail"); x += w + [4, 5, 7][Math.floor(next() * 3)]; }
  };
  // Source footage remains full-size; only the candidate concept mode paints a background.
  if (config.mode === "scene" && e.id !== "focus-bracket") { part("paper", () => rect(0, 0, W, H, t.paper, 0, "none", 0, "background")); part("grid", () => grid(W - 360, 100, 268, 192)); }
  if (e.id === "keyword-sticker") {
    const b = { x: P ? 130 : 220, y: P ? 350 : 236, w: P ? 820 : 1440, h: P ? 650 : 405 };
    part("shadow", () => path(`M${b.x + 16},${b.y + 18} H${b.x + b.w + 12} V${b.y + b.h + 26} H${b.x + 36} Z`, t.ink));
    if (F) part("lead", () => path(`M${b.x},${b.y} H${b.x + b.w - 18} L${b.x + b.w},${b.y + b.h} H${b.x + 18} Z`, t.accent));
    part("plate", () => path(`M${b.x},${b.y} H${b.x + b.w - 18} L${b.x + b.w},${b.y + b.h} H${b.x + 18} Z`, t.primary));
    if (F) part("fx-shine", () => glint(b.x + 46, b.y, b.x + b.w - 46, b.y + b.h, P ? 64 : 84, 36, "59"));
    part("title", () => block(config.title, { x: b.x + 62, y: b.y + 48, w: b.w - 124, h: b.h - 96 }, t.onPrimary, { max: 154, min: 88, maxLines: P ? 4 : 2 }));
    part("spark", () => cross(b.x + b.w - 12, b.y - 28, 17, t.accent)); part("tag", () => tag(config.tag, b.x + 30, b.y - 45, t.primary));
    if (F) part("fx-burst", () => burst(b.x + b.w - 12, b.y - 28, 32, 32, 22, 8, t.primary, 5, Math.PI / 8));
    part("detail", () => block(config.detail, { x: b.x + 24, y: b.y + b.h + 68, w: b.w - 48, h: P ? 180 : 104 }, t.ink, { max: 42, min: 36, maxLines: P ? 3 : 2, weight: 700 }, "detail"));
    if (F && config.detail.trim()) part("quote-bar", () => rect(b.x + 2, b.y + b.h + 68, 8, P ? 180 : 104, t.primary, 4, "none", 0, "detail"));
    if (F && !P) part("fx-streak", () => [.3, .5, .7].forEach((k, i) => line(Math.max(40, b.x - 170 + i * 30), b.y + b.h * k, b.x - 34, b.y + b.h * k, t.primary, i === 1 ? 7 : 5, "fx")));
  } else if (e.id === "conversation-bubble") {
    const b = { x: P ? 136 : 260, y: P ? 330 : 200, w: P ? 808 : 1400, h: P ? 860 : 560 };
    part("shadow", () => rect(b.x + 16, b.y + 20, b.w, b.h, t.primary, 52)); part("plate", () => rect(b.x, b.y, b.w, b.h, t.paper, 52, t.ink, 5));
    part("tail", () => path(`M${b.x + 100},${b.y + b.h - 3} L${b.x + 160},${b.y + b.h + 72} L${b.x + 238},${b.y + b.h - 3}`, t.paper, t.ink, 5));
    // "Someone is typing…" dots hold the title's place, then give way to it.
    if (F) part("fx-typing", () => [0, 1, 2].forEach(i => circle(b.x + 100 + i * 40, b.y + 145 + (P ? 258 : 136), 11, t.ink, "fx")));
    const tf = tagFont(config.tag), ts = graphemes(config.tag).length > 18 ? 24 : 28, pillW = Math.max(220, measure(config.tag, ts, tf.family, tf.weight) + 56);
    if (pillW > b.w - 152) reject("TAG_LAYOUT_OVERFLOW", "小標太長，請縮短或換元件");
    part("pill", () => rect(b.x + 76, b.y + 64, pillW, 58, t.accent, 29)); part("tag", () => text(config.tag, b.x + 102, b.y + 103, ts, t.onAccent, "detail", tf.weight, tf.family, { x: b.x + 94, y: b.y + 64, w: pillW - 32, h: 58 }));
    part("title", () => block(config.title, { x: b.x + 76, y: b.y + 145, w: b.w - 152, h: P ? 516 : 272 }, t.ink, { max: P ? 126 : 140, min: 84, maxLines: P ? 4 : 2 }));
    part("detail", () => block(config.detail, { x: b.x + 80, y: b.y + (P ? 710 : 432), w: b.w - 160, h: P ? 130 : 112 }, t.ink, { max: 42, min: 36, maxLines: 2, weight: 700 }, "detail"));
    part("dot", () => { circle(b.x + b.w + 25, b.y + 85, 12, t.accent); circle(b.x + b.w + 55, b.y + 124, 8, t.primary); });
    if (F) {
      part("speech", () => [200, 226, 252].forEach(deg => { const a = deg * Math.PI / 180;
        line(b.x + 8 + Math.cos(a) * 26, b.y + 8 + Math.sin(a) * 26, b.x + 8 + Math.cos(a) * 60, b.y + 8 + Math.sin(a) * 60, t.primary, 6, "ornament"); }));
      part("fx-ring", () => { ring(b.x + b.w + 25, b.y + 85, 24, t.accent, 4); ring(b.x + b.w + 55, b.y + 124, 17, t.primary, 3); });
    }
  } else if (e.id === "field-note") {
    const b = { x: P ? 120 : 220, y: P ? 292 : 160, w: P ? 840 : 1480, h: P ? 1000 : 650 };
    part("shadow", () => rect(b.x + 18, b.y + 20, b.w, b.h, t.ink, 0)); part("plate", () => rect(b.x, b.y, b.w, b.h, t.paper, 0, t.ink, 3)); part("bar", () => rect(b.x, b.y, 28, b.h, t.primary));
    if (F) part("tape", () => { const cx = b.x + b.w / 2, cy = b.y + 2, a = -3 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      poly(([[-96, -24], [96, -24], [96, 24], [-96, 24]] as Array<[number, number]>).map(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c] as [number, number]), `${t.accent}D9`, "ornament"); });
    part("grid", () => grid(b.x + b.w - 280, b.y + 36, 220, 80, "ornament")); part("tag", () => tag(config.tag, b.x + 76, b.y + 86, t.primary));
    part("title", () => block(config.title, { x: b.x + 72, y: b.y + 140, w: b.w - 144, h: P ? 520 : 292 }, t.ink, { max: P ? 124 : 144, min: 84, maxLines: P ? 4 : 2 }));
    part("rule", () => line(b.x + 74, b.y + (P ? 704 : 490), b.x + b.w - 74, b.y + (P ? 704 : 490), t.primary, 6));
    if (F) {
      const ry = b.y + (P ? 704 : 490);
      part("arrow", () => poly([[b.x + b.w - 70, ry - 13], [b.x + b.w - 46, ry], [b.x + b.w - 70, ry + 13]], t.primary, "detail"));
      part("fx-ring", () => ring(b.x + b.w - 50, ry, 20, t.primary, 3));
    }
    part("detail", () => block(config.detail, { x: b.x + 74, y: b.y + (P ? 752 : 542), w: b.w - 148, h: P ? 184 : 108 }, t.ink, { max: 42, min: 36, maxLines: P ? 3 : 2, weight: 700 }, "detail"));
    if (F && !O) part("ruler", () => ruler(b.x + 40, b.y - 14, 17, 12, t.ink));
  } else if (e.id === "chapter-ticket") {
    const b = { x: area.x, y: P ? 220 : 196, w: area.w, h: P ? 1060 : 600 }, nrW = P ? b.w : 340;
    part("plate", () => rect(b.x, b.y, b.w, b.h, t.ink, 30)); part("panel", () => rect(b.x, b.y, nrW, P ? 320 : b.h, t.primary, 30));
    if (F) {
      part("fx-shine", () => glint(b.x + 46, b.y, b.x + b.w - 46, b.y + b.h, P ? 90 : 120, P ? 60 : 50, "1F"));
      part("fx-flash", () => rect(b.x, b.y, nrW, P ? 320 : b.h, "#FFFFFFB3", 30, "none", 0, "fx"));
    }
    const num = fit(config.number, { w: nrW - 64, h: 308 }, measure, { max: 224, min: 210, maxLines: 1, family: "Bebas Neue", weight: 400 });
    part("number", () => text(config.number, b.x + 50, b.y + 228, num.size, t.onPrimary, "headline", 400, "Bebas Neue", { x: b.x + 35, y: b.y + 12, w: nrW - 70, h: 308 }));
    part("stitch", () => { if (P) { for (let x = b.x + 44; x < b.x + b.w - 24; x += 38) circle(x, b.y + 320, 4, t.paper, "detail"); }
      else { for (let y = b.y + 34; y < b.y + b.h - 24; y += 38) circle(b.x + 340, y, 4, t.paper, "detail"); } });
    const bx = P ? b.x + 54 : b.x + 404, by = P ? b.y + 408 : b.y + 96, bw = P ? b.w - 108 : b.w - 466;
    part("tag", () => tag(config.tag, bx, by, t.paper));
    part("title", () => block(config.title, { x: bx, y: by + 34, w: bw, h: P ? 384 : 272 }, t.paper, { max: P ? 124 : 130, min: 84, maxLines: P ? 3 : 2 }));
    part("detail", () => block(config.detail, { x: bx, y: by + (P ? 466 : 332), w: bw, h: P ? 120 : 104 }, t.paper, { max: 40, min: 36, maxLines: P ? 3 : 2, weight: 700 }, "detail"));
    // Ticket stub barcode: on the number panel (landscape) or under the copy (portrait), clear of every text zone.
    if (F) part("barcode", () => P ? barcode(bx, b.y + b.h - 54, bx + 300, b.y + b.h - 26, `${t.paper}CC`)
      : barcode(b.x + 44, b.y + b.h - 124, b.x + nrW - 44, b.y + b.h - 60, `${t.onPrimary}D9`));
  } else if (e.id === "focus-bracket") {
    const b = config.target!, x = b.x * W, y = b.y * H, w = b.w * W, h = b.h * H, len = Math.min(60, w / 4, h / 4);
    // Under-stroke preserves contrast on arbitrary footage; no fake screenshot is exported.
    const d = `M${x + len},${y} H${x} V${y + len} M${x + w - len},${y} H${x + w} V${y + len} M${x},${y + h - len} V${y + h} H${x + len} M${x + w - len},${y + h} H${x + w} V${y + h - len}`;
    part("corner-under", () => path(d, "none", "#FFFFFF", 18, "focus")); part("corner", () => path(d, "none", t.primary, 10, "focus"));
    if (F) {
      // Lock-on: an echo of the corners pulses outward; one scan line passes over the target.
      part("fx-echo", () => path(d, "none", `${t.primary}8C`, 6, "fx"));
      part("fx-scan", () => { line(x + 14, y + h / 2, x + w - 14, y + h / 2, `${t.primary}CC`, 4, "fx").attrs["data-sweep-y"] = n(Math.max(0, h - 40)); });
      for (const [role, stroke, sw] of [["tick-under", "#FFFFFF", 12], ["tick", t.primary, 6]] as const) part(role, () => {
        line(x - 26, y + h / 2, x - 10, y + h / 2, stroke, sw, "focus"); line(x + w + 10, y + h / 2, x + w + 26, y + h / 2, stroke, sw, "focus"); });
    }
    const fs = 42, labelW = Math.max(254, measure(config.title, fs, "Noto Sans TC", 900) + 72), lx = Math.min(W - 92 - labelW, x), ly = y - 100;
    if (labelW > W - 184 || ly < 46) reject("LABEL_OVERFLOW", "框選標籤超出安全區，請移動來源或縮短文字。");
    part("label", () => rect(lx, ly, labelW, 78, t.primary, 39, "none", 0, "focus"));
    if (F) part("fx-shine", () => glint(lx + 39, ly, lx + labelW - 39, ly + 78, 34, 10, "66"));
    part("title", () => text(config.title, lx + 36, ly + 58, fs, t.onPrimary, "focus", 900, "Noto Sans TC", { x: lx + 24, y: ly + 6, w: labelW - 48, h: 66 }));
    part("leader", () => line(x + w / 2, y + h + 20, x + w / 2, y + h + 48, t.primary, 6, "focus"));
  } else if (e.id === "reaction-seal") {
    const cx = W / 2, cy = P ? 704 : 430, rx = P ? 418 : 758, ry = P ? 448 : 272, points: string[] = [];
    for (let i = 0; i < 48; i++) { const a = Math.PI * 2 * i / 48, s = i % 2 === 0 ? 1 : .956; points.push(`${n(cx + Math.cos(a) * rx * s)},${n(cy + Math.sin(a) * ry * s)}`); }
    part("seal", () => path(`M${points.join(" L")} Z`, t.accent, t.ink, 5));
    if (F) {
      part("fx-flash", () => path(`M${points.join(" L")} Z`, "#FFFFFFB3", "none", 0, "fx"));
      part("fx-burst", () => burst(cx, cy, rx + 28, ry + 28, P ? 52 : 64, 20, t.ink, 6, Math.PI / 20));
    }
    part("tag", () => tag(config.tag, cx - rx + 90, cy - ry + 100, t.onAccent));
    part("title", () => block(config.title, { x: cx - rx + 94, y: cy - ry + 152, w: rx * 2 - 188, h: P ? 400 : 254 }, t.onAccent, { max: P ? 132 : 144, min: 84, maxLines: P ? 3 : 2 }));
    part("spark", () => cross(cx + rx - 40, cy - ry + 20, 17, t.primary)); part("dot", () => circle(cx - rx + 10, cy + ry + 28, 22, t.primary));
    if (F) {
      part("sparkle", () => { star(cx - rx - 36, cy - ry * .2, 26, t.primary); star(cx + rx + 34, cy + ry * .42, 17, t.ink); });
      part("fx-ring", () => ring(cx - rx + 10, cy + ry + 28, 38, t.primary, 4));
    }
    part("detail", () => block(config.detail, { x: cx - rx + 40, y: cy + ry + 74, w: rx * 2 - 80, h: P ? 154 : 82 }, t.ink, { max: 40, min: 36, maxLines: P ? 3 : 2, weight: 700 }, "detail"));
  } else if (e.id === "step-path") {
    part("tag", () => tag(config.tag, area.x, P ? 200 : 144, t.primary));
    part("title", () => block(config.title, { x: area.x, y: P ? 234 : 184, w: area.w, h: P ? 408 : 170 }, t.ink, { max: P ? 120 : 138, min: 84, maxLines: P ? 3 : 1 }));
    const steps = config.detail.split("／"), bw = P ? area.w : 504, bh = P ? 232 : 288;
    const coords = steps.map((_, i) => ({ x: P ? area.x : area.x + i * 616, y: P ? 720 + i * 292 : 470 }));
    for (let i = 0; i < 2; i++) {
      const a = coords[i], b = coords[i + 1];
      part("connector", () => { if (P) line(a.x + 60, a.y + bh + 12, b.x + 60, b.y - 12, t.primary, 7, "connector"); else line(a.x + bw + 16, a.y + bh / 2, b.x - 16, b.y + bh / 2, t.primary, 7, "connector"); });
    }
    if (F) {
      // Progress rail under (beside, in portrait) the nodes: a track, three fill segments, and a packet riding each fill.
      const along = (i: number) => i < 2 ? (P ? coords[i + 1].y : coords[i + 1].x) : (P ? coords[2].y + bh : coords[2].x + bw);
      const at = (value: number): [number, number] => P ? [area.x - 30, value] : [value, coords[0].y + bh + 40];
      const start = (i: number) => P ? coords[i].y : coords[i].x;
      part("rail-track", () => line(...at(start(0)), ...at(along(2)), t.grid, 4, "rail"));
      part("rail-fill", () => coords.forEach((_, i) => line(...at(start(i)), ...at(along(i)), t.primary, 4, "rail")));
      part("fx-packet", () => coords.forEach((_, i) => { const s = circle(...at(along(i)), 8, t.primary, "fx");
        s.attrs["data-sweep-x"] = P ? 0 : n(along(i) - start(i)); s.attrs["data-sweep-y"] = P ? n(along(i) - start(i)) : 0; }));
    }
    coords.forEach((b, i) => {
      part("shadow", () => rect(b.x + 9, b.y + 11, bw, bh, t.ink, 22, "none", 0, `step:${i}`)); part("plate", () => rect(b.x, b.y, bw, bh, i === 2 ? t.primary : t.paper, 22, t.ink, 3, `step:${i}`));
      if (F && i === 2) part("fx-shine", () => glint(b.x + 26, b.y + 3, b.x + bw - 26, b.y + bh - 3, P ? 70 : 60, 22, "59"));
      const ink = i === 2 ? t.onPrimary : t.ink; part("number", () => tag(`0${i + 1}`, b.x + 36, b.y + 60, ink));
      part("title", () => block(steps[i], { x: b.x + 36, y: b.y + 82, w: bw - 72, h: bh - 108 }, ink, { max: P ? 90 : 76, min: 58, maxLines: 2 }, `step:${i}`));
    });
  } else if (e.id === "recap-strip") {
    part("tag", () => tag(config.tag, area.x, P ? 196 : 136, t.primary));
    part("title", () => block(config.title, { x: area.x, y: P ? 238 : 172, w: area.w, h: P ? 414 : 258 }, t.ink, { max: P ? 124 : 142, min: 84, maxLines: P ? 3 : 2 }));
    config.detail.split("／").forEach((value, i) => {
      const y = P ? 700 + i * 284 : 460 + i * 132, h = P ? 224 : 124;
      if (F) part("lead", () => rect(area.x, y, area.w, h, t.accent, 0, "none", 0, `row:${i}`));
      part("row", () => rect(area.x, y, area.w, h, i === 0 ? t.primary : t.ink, 0, "none", 0, `row:${i}`));
      if (F && i === 0) part("fx-shine", () => glint(area.x + 20, y, area.x + area.w - 20, y + h, P ? 70 : 90, P ? 26 : 18, "4D"));
      const ink = i === 0 ? t.onPrimary : t.paper;
      part("chevron", () => path(`M${area.x + 34},${y + h / 2 - 18} L${area.x + 60},${y + h / 2} L${area.x + 34},${y + h / 2 + 18}`, "none", ink, 6, `row:${i}`));
      part("title", () => block(value, { x: area.x + 94, y: y + 18, w: area.w - 158, h: h - 36 }, ink, { max: P ? 82 : 68, min: 58, maxLines: P ? 2 : 1 }, `row:${i}`));
      if (F) part("check", () => path(`M${area.x + area.w - 54},${y + h / 2 + 1} L${area.x + area.w - 42},${y + h / 2 + 13} L${area.x + area.w - 18},${y + h / 2 - 14}`, "none", ink, 6, `row:${i}`));
    });
  }
  const entryMoves: Record<OriginalElementId, [number, number, number]> = { "keyword-sticker": [0, 22, .984], "conversation-bubble": [-26, 0, .99], "field-note": [28, 0, 1],
    "chapter-ticket": [0, 26, 1], "focus-bracket": [0, 0, 1], "reaction-seal": [0, 0, .94], "step-path": [0, 14, 1], "recap-strip": [0, 18, 1] };
  const [dx, dy, scale] = entryMoves[e.id];
  const overlay = config.mode === "overlay" && e.id !== "focus-bracket";
  return { version: ORIGINAL_ELEMENTS_VERSION, config: structuredClone(config), width: W, height: H, subtitleBottomPx: bottom, theme: t, shapes, textZones, holdSeconds: hold,
    sourceMotion: { entrySeconds: config.firstFrameReadable ? 0 : .24, translateXPx: dx, translateYPx: dy, scaleFrom: scale },
    sceneTransform: overlay ? (P ? "translate(54 224) scale(.90)" : "translate(288 70) scale(.70)") : "" };
}
