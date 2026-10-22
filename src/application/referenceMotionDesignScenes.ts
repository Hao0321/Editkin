// Reproduced reference scenes (Hao 2026-10-07: 「我給你的參考資料你應該把他們的東西都抄下來保留…到時候就有大量模板可以選擇套用」).
// Each family rebuilds one studied scene's composition and timing for every design style; the style's kit supplies type,
// colour, chrome, marks and motion. Copy is the creator's own and every number shown must be a verified one.
import { MOTION_CURVES } from "../motion/motionLanguage";
import type { Base, DesignMotion, DesignType, Kit, Shape, Surface } from "./referenceMotionDesignThemes";

export const SCENE_FAMILY_IDS = ["word_build", "stat_cycle", "word_cycle", "logo_end", "ranked_list", "ui_demo", "mark_open"] as const;
type SceneFamily = typeof SCENE_FAMILY_IDS[number];

/** Number setting shared by data scenes: the number in the numeral face and its unit in the heading face on its baseline,
 * fitted on one line, counting up when it is one number, every glyph box kept on the frame. */
export function numberKit(b: Base, k: Kit, s: Surface) {
  const { ctx, input, u, fr, M, CW, W } = b, type = k.type(s);
  /** "4.1x" stays whole; "3 支" splits into the number (numeral face) and its unit (heading face, smaller, on the baseline). */
  const split = (value: string) => {
    const match = value.trim().match(/^([\x21-\x7E]*\d[\x21-\x7E]*?)\s*([^\x00-\x7F].*)?$/s);
    return match ? { number: match[1], unit: match[2]?.trim() || undefined } : { number: value.trim(), unit: undefined };
  };
  /** A glyph box pads its column by 28% of the size on each side; probes and columns keep that padding on the frame. */
  const padOf = (size: number) => Math.max(6, Math.ceil(u(size) * .28));
  const probe = (size: number, width: number) => {
    const x = Math.max(M, padOf(size) + 1);
    return { x, width: Math.min(width, W - x - padOf(size) - 1) };
  };
  /** Room after a number for the passing values of its count (proportional digits differ in width). */
  const slack = (size: number) => Math.max(u(40), Math.round(u(size) * .34));
  /** The largest size, down to 30%, at which a numeral sets on one line inside width. */
  const fitLine = (value: string, spec: DesignType, width: number) => {
    for (let size = spec.size; size >= spec.size * .3; size -= Math.max(2, spec.size * .04)) {
      const at = { ...spec, size: Math.floor(size) }, p = probe(at.size, width);
      if (ctx.measureLines(value, { ...at, maxLines: 4 }, p.x, p.width).length === 1 && ctx.measure(value, at, p.x, p.width).right - p.x <= width) return Math.floor(size);
    }
    return Math.floor(spec.size * .3);
  };
  const unitType: DesignType = { ...type.lead, color: type.title.color, maxLines: 1 };
  /** Number size, unit size, ink width, left bearing and set height for a value in a column of the given width. */
  const metrics = (label: string, size: number, width: number) => {
    const { number, unit } = split(label), unitSpec: DesignType = { ...unitType, size: Math.max(28, Math.round(size * .3)) };
    const unitWidth = unit ? b.lineSize(unit, unitSpec).w + u(18) : 0;
    const spec: DesignType = { ...type.numeral, size, maxLines: 1, align: "left" };
    spec.size = fitLine(number, spec, width - unitWidth);
    const p = probe(spec.size, width), m = ctx.measure(number, spec, p.x, p.width);
    return { number, unit, unitSpec, unitWidth, spec, inkWidth: m.right - m.left, bearing: m.left - p.x, height: m.height };
  };
  /** Sets one value at (x, inkTop); the number counts up when it is a single number, its unit lands beside it. */
  const value = (role: string, label: string, size: number, x: number, width: number, inkTop: number, start: number, align: "left" | "center",
    options: { stop?: number; motion?: (text: string) => DesignMotion; color?: string } = {}) => {
    const stop = options.stop ?? b.end, motionFor = options.motion ?? ((text: string) => k.motion.numeral(text));
    const { number, unit, unitSpec, unitWidth, spec, inkWidth: numberWidth, bearing } = metrics(label, size, width);
    if (options.color) spec.color = options.color;
    const x0 = align === "center" ? x + (width - numberWidth - unitWidth) / 2 : x;
    const counts = (number.match(/\d+(?:[.,]\d+)*/g) ?? []).length === 1;
    // The ink aligns to x0 unless the glyph box's padding would leave the frame (a wide-bearing "1"): then it shifts in.
    const columnX = Math.max(padOf(spec.size) + 1, x0 - bearing);
    const motionV2 = motionFor(number), column = numberWidth + slack(spec.size);
    const graphics = counts ? ctx.count(role, number, spec, columnX, column, inkTop, motionV2, start, stop)
      : [ctx.line(role, number, spec, columnX, column, inkTop, motionV2, start, stop)];
    const final = graphics[graphics.length - 1], box = ctx.ink(final);
    const landed = Math.round(final.timelineStart * b.fps) - input.startFrame + b.span(number, motionV2);
    if (unit) {
      const unitMotion = k.motion.label(unit), uh = ctx.measure(unit, unitSpec, M, CW).height;
      b.requireTime(b.need(unit, landed - fr(4), unitMotion), "數據單位");
      b.lineAt(`${role}:unit`, unit, unitSpec, box.right + u(14), box.bottom - uh, unitMotion, landed - fr(4), stop);
    }
    return { box: { ...box, right: box.right + unitWidth }, landed };
  };
  /** The hero's size: the largest (up to 2.4x the system numeral, at most 384 px) at which number and unit sit centred on one line inside
   * the content width, the glyph boxes stay on the frame and the ink fits the room. */
  const heroSize = (label: string, room: number) => {
    // Up to 2.4x the system numeral, within the project's 384-pixel type ceiling.
    const { number, unit } = split(label), max = Math.min(Math.round(b.D.numeralMaxPixels * 2.4), Math.floor(384 / ctx.unit)), floor = Math.round(b.D.numeralMaxPixels * .3);
    const ref = ctx.measure(number, { ...type.numeral, size: 100, maxLines: 1, align: "left" }, M, CW);
    const unitRef = unit ? b.lineSize(unit, { ...unitType, size: 100 }).w : 0;
    const fits = (size: number) => {
      const scale = size / 100, numberWidth = (ref.right - ref.left) * scale, bearing = (ref.left - M) * scale;
      const unitWidth = unit ? unitRef * Math.max(28, Math.round(size * .3)) / 100 + u(18) : 0, total = numberWidth + unitWidth;
      const pad = padOf(size), x0 = (W - total) / 2;
      return total <= CW && x0 - bearing >= pad + 2 && x0 - bearing + numberWidth + slack(size) + pad <= W - 2 && ref.height * scale <= room;
    };
    let size = max;
    while (size > floor && !fits(size)) size -= Math.max(2, Math.round(size * .03));
    return Math.max(floor, size);
  };
  return { split, slack, fitLine, metrics, value, heroSize };
}

const HAN = /[\p{Script=Han}　-〿＀-￯]/u;
/** Space-separated words with their joining space; a space between two Han words is not shown. */
function words(text: string) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.map((part, index) => {
    const next = parts[index + 1];
    return next !== undefined && !(HAN.test([...part].at(-1)!) && HAN.test([...next][0])) ? `${part} ` : part;
  });
}

/** A vector that starts at an offset, fully visible, and glides into place (cursor segments, toggle knobs). */
const glide = (dx: number, dy: number, frames: number): DesignMotion => ({
  sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
  entrance: { durationFrames: Math.max(1, frames), offsetXPixels: dx, offsetYPixels: dy, scale: 1, opacity: 1, easing: MOTION_CURVES.quintOut },
  exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: MOTION_CURVES.snapIn } });

/** Word build (studied: a launch's opening line): the headline arrives one word at a time on a clean page, centred, and
 * a second line (subtitle) follows; the accent word takes the accent ink and the style's emphasis once its line is in. */
function wordBuild(b: Base, k: Kit) {
  const { ctx, input, fr, cM: M, cW: CW, H, end } = b, s = k.surfaceFor("word_build"), type = k.type(s);
  // A clean page covers the live picture while its sound continues.
  k.page(s, { layer: "foreground" }); k.chrome(s, 0, end); k.footer(s);
  const lines = [input.title, input.subtitle].filter((line): line is string => !!line).map(words);
  const spec: DesignType = { ...type.title, size: 136, maxLines: 2, align: "center" };
  spec.size = Math.min(...lines.map(runs => b.fitSize(runs.join(""), spec, CW)));
  const heights = lines.map(runs => ctx.measure(runs.join(""), spec, M, CW).height), gap = b.u(spec.size) * .42;
  let inkTop = H * .45 - (heights.reduce((sum, h) => sum + h, 0) + gap * (lines.length - 1)) / 2;
  const motionFor = (text: string) => k.motion.title(text);
  let at = fr(8), settled = 0;
  lines.forEach((runs, line) => {
    const starts = runs.map(run => { const start = at; at += Math.max(fr(7), fr(4) + fr(1.5) * [...run.trim()].length); return start; });
    const accent = (run: string) => !!input.accentText && run.includes(input.accentText);
    const pieces = ctx.inline(`line:${line}`, runs.map(run => ({ text: run, color: accent(run) ? k.accentWord(s) : k.ink(s) })), spec, M, CW, inkTop,
      motionFor, starts[0], end, { runStarts: starts });
    const landed = starts.at(-1)! + b.span(runs.at(-1)!, motionFor(runs.at(-1)!));
    pieces.filter(piece => piece.textColor === k.accentWord(s) && k.accentWord(s) !== k.ink(s) && piece.text.trim())
      .forEach((piece, index) => k.emphasis(`line:${line}:emphasis:${index}`, ctx.ink(piece), s, landed + fr(3), end));
    settled = Math.max(settled, landed);
    at = landed + fr(8);
    inkTop += heights[line] + gap;
  });
  b.requireTime(settled + ctx.readingFrames(lines.map(runs => runs.join("")).join("")) + b.exitFrames, "逐字標題");
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

/** Big-number sequence (studied: a launch's result beats): each verified number takes the frame in turn, counting in on its
 * style's numeral motion with its caption under it; the next pushes it away through a blur; the last one holds. */
function statCycle(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, cM: M, cW: CW, W, end, D } = b, s = k.surfaceFor("stat_cycle"), type = k.type(s), items = input.items!, n = numberKit(b, k, s);
  k.page(s, { layer: "foreground", grid: true }); k.chrome(s, 0, end); k.footer(s);
  // The title rides at the top as the scene's quiet label.
  const label: DesignType = { ...type.lead, size: 54, maxLines: 2, align: "center" };
  label.size = b.fitSize(input.title, label, CW);
  const labelMotion = k.motion.label(input.title);
  b.requireTime(b.need(input.title, 0, labelMotion), "主標");
  const header = ctx.line("headline", input.title, label, M, CW, Y(D.grid.contentTop) + u(10), labelMotion, 0, end);
  const zoneTop = ctx.ink(header).bottom + Y(90), zoneBottom = Y(D.grid.contentBottom) - Y(40);
  const blurOut = (text: string): DesignMotion => { const m = k.motion.numeral(text); return { ...m, exit: { ...m.exit, durationFrames: fr(7), blurPixels: u(20) } }; };
  let start = fr(10), revealFrom = 0;
  items.forEach((item, index) => {
    const last = index === items.length - 1, caption: DesignType = { ...type.body, maxLines: 2, align: "center" };
    const captionH = item.detail ? ctx.measure(item.detail, caption, M, CW).height + Y(46) : 0;
    const size = n.heroSize(item.label, zoneBottom - zoneTop - captionH), hm = n.metrics(item.label, size, CW);
    const total = hm.inkWidth + hm.unitWidth, top = zoneTop + Math.max(0, (zoneBottom - zoneTop - hm.height - captionH) / 2);
    // A count is at most nine two-frame steps before its final value enters; the beat is sized on that bound.
    const reading = ctx.readingFrames(item.detail ? `${item.label}${item.detail}` : item.label);
    const stop = last ? end : start + 18 + b.span(hm.number, blurOut(hm.number)) + reading + fr(8);
    const set = n.value(`item:${index}:value`, item.label, size, (W - total) / 2, total + n.slack(size), top, start, "left", { stop, motion: blurOut });
    k.accent(`item:${index}:impact`, (set.box.left + set.box.right) / 2, (set.box.top + set.box.bottom) / 2,
      Math.max(u(200), Math.min(u(340), (set.box.bottom - set.box.top) * .8)), s, set.landed - fr(2));
    // The beat holds once the impact has faded and the caption is in; it ends where the next number starts to push.
    let held = set.landed - fr(2) + fr(16);
    if (item.detail) {
      const motionV2 = k.motion.body(item.detail), captionStart = set.landed - fr(4);
      ctx.line(`item:${index}:caption`, item.detail, caption, M, CW, set.box.bottom + Y(46), motionV2, captionStart, stop);
      held = Math.max(held, captionStart + b.span(item.detail, motionV2));
    }
    const holdEnd = last ? end - b.exitFrames : stop - fr(8);
    b.requireTime(Math.max(set.landed + reading, held + fr(6)) + b.exitFrames, "數字");
    ctx.phase("reveal", revealFrom, held); ctx.phase("hold", held, holdEnd);
    revealFrom = holdEnd; start = stop;
  });
}

/** Word cycle (studied: a launch's closing words): two to four words take the centre in turn, each sliding up and out
 * through a blur as the next rises from below where it waited faintly; the last lands in the accent ink with the title
 * under it as the tagline. */
function wordCycle(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, cM: M, cW: CW, H, end } = b, s = k.surfaceFor("word_cycle"), type = k.type(s), items = input.items!;
  k.page(s, { layer: "foreground" }); k.chrome(s, 0, end); k.footer(s);
  const spec: DesignType = { ...type.title, size: 176, maxLines: 1, align: "center" };
  spec.size = Math.min(...items.map(item => b.fitSize(item.label, spec, CW)));
  const lh = Math.max(...items.map(item => ctx.measure(item.label, spec, M, CW).height)), travel = lh * 1.1;
  const tagline: DesignType = { ...type.body, maxLines: 2, align: "center" }, tagH = ctx.measure(input.title, tagline, M, CW).height;
  const top = H * .45 - (lh + Y(44) + tagH) / 2;
  const slide = (text: string): DesignMotion => {
    const m = b.text(text, { perCharacter: false, dy: travel, blur: u(16), frames: fr(10), easing: MOTION_CURVES.quintOut });
    return { ...m, exit: { durationFrames: fr(8), offsetXPixels: 0, offsetYPixels: -travel, scale: 1, opacity: 0, easing: MOTION_CURVES.snapIn, blurPixels: u(16) } };
  };
  let start = fr(8), revealFrom = 0;
  items.forEach((item, index) => {
    const last = index === items.length - 1, motion = slide(item.label), landed = start + b.span(item.label, motion);
    if (!last) {
      const stop = landed + ctx.readingFrames(item.label) + fr(6) + motion.exit.durationFrames, leave = stop - motion.exit.durationFrames;
      b.requireTime(stop, "字詞");
      ctx.line(`word:${index}`, item.label, { ...spec, color: k.ink(s) }, M, CW, top, motion, start, stop);
      // The next word waits faintly below until its turn (a passing ghost, read when it takes the centre).
      ctx.line(`word:${index}:next`, items[index + 1].label, { ...spec, color: `${k.ink(s)}2B` }, M, CW, top + travel, b.fade(fr(8)), landed, leave, { flash: true });
      ctx.phase("reveal", revealFrom, landed + fr(8)); ctx.phase("hold", landed + fr(8), leave);
      revealFrom = leave; start = leave;
      return;
    }
    const final = { ...motion, exit: b.text(item.label).exit };
    const word = ctx.line(`word:${index}`, item.label, { ...spec, color: k.accentWord(s) }, M, CW, top, final, start, end);
    k.emphasis("word:emphasis", ctx.ink(word), s, landed + fr(3), end);
    const tagMotion = k.motion.body(input.title), tagStart = landed + fr(6), held = Math.max(tagStart + b.span(input.title, tagMotion), landed + fr(16));
    b.requireTime(Math.max(b.need(input.title, tagStart, tagMotion), landed + ctx.readingFrames(item.label) + b.exitFrames), "標語");
    ctx.line("tagline", input.title, tagline, M, CW, ctx.ink(word).bottom + Y(44), tagMotion, tagStart, end);
    ctx.phase("reveal", revealFrom, held); ctx.phase("hold", held, end - b.exitFrames);
  });
}

/** End card (studied: a launch's logo reveal and a reel's end card): the style's mark and the wordmark forming left to
 * right, the subtitle as a whisper line, a hairline, the title letter-spaced and typed out, the kicker as a quiet footer. */
function logoEnd(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, cM: M, cW: CW, W, H, end, textBottom } = b, s = k.surfaceFor("logo_end"), type = k.type(s), brand = input.brandMark!;
  // The brand is the subject: no chrome repeating it.
  k.page(s, { layer: "foreground" }); k.footer(s);
  const markSize = u(108), gap = u(28), wordSpec: DesignType = { ...type.title, size: 124, maxLines: 1, align: "left" };
  // A wordmark is one line: it scales down until it fits beside the mark in the centred safe column.
  wordSpec.size = Math.min(wordSpec.size, Math.floor(40 * (CW - markSize - gap) / b.lineSize(brand, { ...wordSpec, size: 40 }).w));
  const m = ctx.measure(brand, wordSpec, M, CW), wordW = m.right - m.left, left = (W - (markSize + gap + wordW)) / 2, cy = H * .43;
  k.mark("mark", left + markSize / 2, cy, markSize, s, fr(4), end);
  const wordMotion = k.motion.title(brand), wordStart = fr(10);
  b.requireTime(b.need(brand, wordStart, wordMotion), "字標");
  const word = b.lineAt("wordmark", brand, wordSpec, left + markSize + gap, cy - m.height / 2, wordMotion, wordStart, end);
  let y = ctx.ink(word).bottom + Y(52), settled = wordStart + b.span(brand, wordMotion);
  if (input.subtitle) {
    const spec: DesignType = { ...type.body, maxLines: 2, align: "center" }, motionV2 = k.motion.body(input.subtitle), start = settled - fr(4);
    b.requireTime(b.need(input.subtitle, start, motionV2), "副標");
    y = ctx.ink(ctx.line("subtitle", input.subtitle, spec, M, CW, y, motionV2, start, end)).bottom + Y(48);
    settled = Math.max(settled, start + b.span(input.subtitle, motionV2));
  }
  k.divider("rule", W / 2 - CW * .2, y, CW * .4, settled, s);
  // The title typed out letter by letter, letter-spaced in the accent ink.
  const typed: DesignType = { ...type.small, size: 36, tracking: 5, color: k.accentWord(s), maxLines: 2, align: "center" };
  const typing = b.text(input.title, { dy: 0, frames: 1, staggerMax: 2, tailMax: 40 }), typeStart = settled + fr(6);
  b.requireTime(b.need(input.title, typeStart, typing), "標語");
  ctx.line("tagline", input.title, typed, M, CW, y + Y(40), typing, typeStart, end);
  settled = typeStart + b.span(input.title, typing);
  if (input.kicker) {
    // The quiet footer still sits above the platform's caption overlay, at a size a phone can read.
    const spec: DesignType = { ...type.small, size: 34, align: "center", maxLines: 1 }, motionV2 = b.fade(fr(10)), start = settled + fr(4);
    b.requireTime(b.need(input.kicker, start, motionV2), "頁尾");
    ctx.line("footer:text", input.kicker, spec, M, CW, textBottom - ctx.measure(input.kicker, spec, M, CW).height, motionV2, start, end);
  }
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

/** Ranked list (studied: a launch's "already winning" list): the title, then rows arriving one by one with the index in
 * the accent ink, the line, and its verified score counting up at the right under the score caption (primaryLabel). */
function rankedList(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, W, end, D } = b, s = k.surfaceFor("ranked_list"), type = k.type(s), items = input.items!, n = numberKit(b, k, s);
  k.page(s, { layer: "foreground", grid: true }); k.chrome(s, 0, end); k.footer(s);
  const scored = items.some(item => item.detail), indexW = u(116), scoreW = scored ? u(200) : 0;
  const textX = M + indexW, textW = CW - indexW - scoreW - (scored ? u(28) : 0);
  const textSpec = (label: string): DesignType => { const spec: DesignType = { ...type.lead, size: 56, maxLines: 2 }; spec.size = b.fitSize(label, spec, textW); return spec; };
  const rowPad = Y(40), rowH = items.map(item => Math.max(ctx.measure(item.label, textSpec(item.label), textX, textW).height, u(74)) + 2 * rowPad);
  // Title and rows read as one centred group, as the studied list sat in the middle of its frame.
  const gap = Y(120), total = rowH.reduce((sum, h) => sum + h, 0), titleH = ctx.measure(input.title, { ...type.title, size: 96, maxLines: 2 }, M, CW).height;
  const groupTop = Math.max(Y(D.grid.contentTop), (Y(D.grid.contentTop) + Y(D.grid.contentBottom) - titleH - gap - total) / 2);
  b.requireTime(b.need(input.title, 0, k.motion.title(input.title)), "主標");
  const title = k.title("headline", input.title, s, M, CW, groupTop, 0, end, { size: 96 });
  let y = title.ink.bottom + gap, start = title.settled + fr(8), settled = start;
  if (scored && input.primaryLabel) {
    const spec: DesignType = { ...type.small, size: 34, maxLines: 1 }, m = b.lineSize(input.primaryLabel, spec);
    b.lineAt("score:caption", input.primaryLabel, spec, b.R - m.w, y - Y(24) - m.h, b.fade(fr(10)), start, end);
  }
  items.forEach((item, index) => {
    k.divider(`row:${index}:rule`, M, y, CW, start, s);
    const mark = String(index + 1).padStart(2, "0"), indexSpec: DesignType = { ...type.numeral, size: 64, color: k.accentWord(s), maxLines: 1 };
    ctx.line(`row:${index}:index`, mark, indexSpec, M, indexW, y + rowPad, k.motion.numeral(mark), start, end);
    const spec = textSpec(item.label), textMotion = k.motion.label(item.label);
    const textStart = start + b.span(mark, k.motion.numeral(mark));
    ctx.line(`row:${index}:text`, item.label, spec, textX, textW, y + rowPad, textMotion, textStart, end);
    let landed = textStart + b.span(item.label, textMotion);
    if (item.detail) {
      const sm = n.metrics(item.detail, 84, scoreW);
      // Counting digits can be wider than the final value: the score keeps a margin inside the safe edge.
      const set = n.value(`row:${index}:score`, item.detail, sm.spec.size, b.R - n.slack(sm.spec.size) - sm.inkWidth - sm.unitWidth, sm.inkWidth + sm.unitWidth + n.slack(sm.spec.size),
        y + rowPad, start + fr(5), "left");
      landed = Math.max(landed, set.landed);
    }
    b.requireTime(landed + ctx.readingFrames(item.label) + b.exitFrames, "清單列");
    settled = Math.max(settled, landed);
    start = landed + Math.max(fr(10), ctx.readingFrames(item.label) - fr(8));
    y += rowH[index];
  });
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

/** The cursor: an arrow whose tip sits on (x, y). */
function arrow(b: Base, x: number, y: number, scale: number): Shape {
  const points: Array<[number, number]> = [[0, 0], [0, 44], [11, 34], [19, 52], [27, 48], [19, 31], [34, 31]];
  return b.clockwise(points.map(([px, py]) => ({ x: x + px * scale, y: y + py * scale })));
}

/** UI demo (studied: a reel's render-queue card and a launch's input demo): a floating settings card with the style's
 * mark, rows of values and switches, a cursor that travels, flips the first switch and presses the button, a progress
 * sweep, the done state and a toast. Illustrative interface: it is not a real product's screen. */
function uiDemo(b: Base, k: Kit) {
  const { ctx, input, col, u, Y, fr, M, CW, W, H, end } = b, s = k.surfaceFor("ui_demo"), type = k.type("light"), items = input.items!;
  k.page(s, { layer: "foreground", grid: true }); k.chrome(s, 0, end); k.footer(s);
  const ink = col.ink, sheet = col.dark ? col.raised : col.white, pad = u(46), rowH = u(124), buttonH = u(108), headerH = u(150);
  // The card fills the safe text column (its values and toast never reach the platform's action buttons).
  const cw = CW, cx = M, ch = pad + headerH + items.length * rowH + u(34) + buttonH + pad, cy = H * .47 - ch / 2;
  const enter = b.fade(fr(12), .97, MOTION_CURVES.quintOut, u(40));
  // The card: soft shadow under a rounded sheet.
  ctx.panel("card:shadow", cx + u(10), cy + u(26), cw - u(20), ch, u(30), `${col.dark ? "#000000" : ink}24`, "foreground", fr(4), end, { softness: 40, motionV2: enter });
  b.shape("card:sheet", ctx.roundedRect(cx, cy, cw, ch, u(30)), sheet, fr(4), end, { motionV2: enter });
  // Header: the style's mark, the title and the kicker.
  const markSize = u(64), headerStart = fr(9);
  k.mark("card:mark", cx + pad + markSize / 2, cy + pad + markSize / 2, markSize, "light", headerStart, end);
  const headX = cx + pad + markSize + u(24), headW = cw - 2 * pad - markSize - u(24);
  const titleSpec: DesignType = { ...type.lead, size: 56, maxLines: 1, color: ink }, titleMotion = k.motion.label(input.title);
  titleSpec.size = Math.max(46, b.fitSize(input.title, titleSpec, headW));
  const head = ctx.line("card:title", input.title, titleSpec, headX, headW, cy + pad + u(2), titleMotion, headerStart, end);
  if (input.kicker) ctx.line("card:kicker", input.kicker, { ...type.small, size: 34, maxLines: 1, color: col.mute }, headX, headW, ctx.ink(head).bottom + u(14), b.fade(fr(9)),
    headerStart + b.span(input.title, titleMotion), end);
  // Rows: a value pill, or a switch that the cursor will flip.
  const toggleW = u(92), toggleH = u(52), knob = u(20), rowsTop = cy + pad + headerH;
  let firstSwitch: { x: number; y: number; row: number } | undefined, start = headerStart + fr(8);
  const labelSpec: DesignType = { ...type.label, size: 46, maxLines: 1, color: ink };
  items.forEach((item, index) => {
    const rowY = rowsTop + index * rowH, mid = rowY + rowH / 2, rowStart = start + index * fr(4), motionV2 = k.motion.label(item.label);
    if (index > 0) b.bar(`row:${index}:rule`, cx + pad, rowY, cw - 2 * pad, Math.max(1, u(1.5)), `${ink}1A`, "foreground", rowStart, end, fr(10), b.fade(1));
    const labelH = ctx.measure(item.label, labelSpec, cx + pad, cw * .55).height;
    ctx.line(`row:${index}:label`, item.label, labelSpec, cx + pad, cw * .55, mid - labelH / 2, motionV2, rowStart, end);
    const right = cx + cw - pad;
    if (item.detail) {
      const valueSpec: DesignType = { ...type.label, size: 40, maxLines: 1, color: ink }, m = b.lineSize(item.detail, valueSpec), w = m.w + u(44), h = m.h + u(26);
      b.shape(`row:${index}:value:pill`, b.pill(right - w, mid - h / 2, w, h), `${ink}12`, rowStart + fr(2), end, { motionV2: b.fade(fr(8)) });
      b.lineAt(`row:${index}:value`, item.detail, valueSpec, right - w + u(22), mid - m.h / 2, b.fade(fr(8)), rowStart + fr(3), end);
    } else {
      const x = right - toggleW, y = mid - toggleH / 2;
      firstSwitch ??= { x, y, row: index };
      b.shape(`row:${index}:switch:track`, b.pill(x, y, toggleW, toggleH), `${ink}29`, rowStart + fr(2), end, { motionV2: b.fade(fr(8)) });
      b.shape(`row:${index}:switch:knob`, b.ellipseContour(x + toggleH / 2, mid, knob, knob), col.white, rowStart + fr(2), end, { motionV2: b.fade(fr(8)) });
    }
  });
  // The button.
  const buttonY = rowsTop + items.length * rowH + u(34), bx = cx + pad, bw = cw - 2 * pad, label = input.primaryLabel!;
  const buttonSpec: DesignType = { ...type.label, size: 46, maxLines: 1, color: col.paper, align: "center" }, buttonStart = start + items.length * fr(4);
  b.shape("button", b.pill(bx, buttonY, bw, buttonH), ink, buttonStart, end, { motionV2: b.fade(fr(8)) });
  const labelH = ctx.measure(label, buttonSpec, bx, bw).height;
  // The cursor's path: in from the lower right, to the first switch (or the first value), then to the button.
  const settledRows = buttonStart + fr(10), travel = fr(14), points: Array<{ x: number; y: number; at: number }> = [];
  const firstTarget = firstSwitch ? { x: firstSwitch.x + toggleH / 2, y: firstSwitch.y + toggleH / 2 } : { x: cx + cw - pad - u(60), y: rowsTop + rowH / 2 };
  points.push({ x: W - M - u(40), y: Math.min(H - u(260), cy + ch + u(180)), at: settledRows });
  points.push({ ...firstTarget, at: settledRows + travel });
  // The button is pressed only after its label has been read.
  const textStart = buttonStart + fr(3), labelMotion = k.motion.label(label), labelNeed = b.need(label, textStart, labelMotion);
  const pressAt = Math.max(points[1].at + fr(10) + travel, labelNeed - b.exitFrames);
  points.push({ x: bx + bw * .62, y: buttonY + buttonH * .58, at: pressAt });
  b.requireTime(pressAt + fr(60), "操作示範");
  const cursorColor = ink;
  points.forEach((point, index) => {
    const previous = points[index - 1], stop = points[index + 1]?.at ?? end;
    // The first cursor fades in and is replaced in place by the travelling one (no exit of its own).
    const motionV2 = previous ? glide(previous.x - point.x, previous.y - point.y, travel) : { ...b.fade(fr(8)), exit: glide(0, 0, 1).exit };
    b.shape(`cursor:${index}:shadow`, arrow(b, point.x + u(3), point.y + u(4), u(1.15)), `${col.dark ? "#000000" : ink}38`, previous ? previous.at : point.at, stop, { motionV2 });
    b.shape(`cursor:${index}`, arrow(b, point.x, point.y, u(1.15)), cursorColor, previous ? previous.at : point.at, stop, { motionV2 });
  });
  // The first click flips the switch: track to the accent, knob across.
  const clickAt = points[1].at + fr(2);
  k.accent("click:0", firstTarget.x, firstTarget.y, u(54), "light", clickAt);
  if (firstSwitch) {
    const { x, y } = firstSwitch, row = firstSwitch.row, slide = toggleW - toggleH;
    b.shape(`row:${row}:switch:on`, b.pill(x, y, toggleW, toggleH), col.accent, clickAt, end, { motionV2: b.fade(fr(5)) });
    b.shape(`row:${row}:switch:knob:on`, b.ellipseContour(x + toggleW - toggleH / 2, y + toggleH / 2, knob, knob), col.white, clickAt, end, { motionV2: glide(-slide, 0, fr(7)) });
  }
  // The press: the label gives way to a progress sweep, then the done state and a toast.
  b.requireTime(labelNeed, "按鈕");
  ctx.line("button:label", label, buttonSpec, bx, bw, buttonY + (buttonH - labelH) / 2, labelMotion, textStart, Math.max(pressAt + fr(3), labelNeed));
  const pressed = pressAt + fr(2), sweep = fr(26), done = pressed + sweep;
  k.accent("click:1", points[2].x, points[2].y, u(60), "light", pressed);
  b.shape("button:progress", b.pill(bx, buttonY, bw, buttonH), col.accent, pressed, end, { revealFrom: "left", revealFrames: sweep });
  const doneText = "完成", doneSpec: DesignType = { ...buttonSpec, color: col.onAccent }, dm = b.lineSize(doneText, doneSpec), check = u(30);
  const doneLeft = bx + (bw - dm.w - check - u(16)) / 2, doneMid = buttonY + buttonH / 2;
  b.shape("button:check", b.polyline([[doneLeft, doneMid], [doneLeft + check * .38, doneMid + check * .36], [doneLeft + check, doneMid - check * .4]], Math.max(3, u(5))),
    col.onAccent, done, end, { motionV2: k.motion.pop() });
  b.lineAt("button:done", doneText, doneSpec, doneLeft + check + u(16), doneMid - dm.h / 2, k.motion.label(doneText), done + fr(2), end);
  let settled = done + fr(2) + b.span(doneText, k.motion.label(doneText));
  if (input.subtitle) {
    const size = k.tagSize(input.subtitle), toastStart = done + fr(8);
    b.requireTime(toastStart + fr(4) + ctx.readingFrames(input.subtitle) + b.exitFrames, "通知");
    k.tag("toast", input.subtitle, Math.min(cx + cw - size.w, b.R - size.w), cy - size.h - u(30), toastStart, end, "light", "ink");
    settled = Math.max(settled, toastStart + fr(10));
  }
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

/** Mark opening (studied: a reel's first two seconds): the style's mark lands and ripples, the kicker types out under it,
 * a line draws out to both edges, the line opens into the accent field, and the title rolls in with the subtitle as its
 * whisper line. */
function markOpen(b: Base, k: Kit) {
  const { ctx, input, col, u, Y, fr, cM: M, cW: CW, W, H, end } = b, type = k.type("light");
  k.page("light", { layer: "foreground" });
  const cy = H * .45, size = u(64), markStart = fr(4);
  const typing = input.kicker ? b.text(input.kicker, { dy: 0, frames: 1, staggerMax: 1, tailMax: 24 }) : undefined, kickerStart = markStart + fr(6);
  const lineAt = Math.max(markStart + fr(18), input.kicker ? kickerStart + b.span(input.kicker, typing!) + ctx.readingFrames(input.kicker) : 0);
  const fieldAt = lineAt + fr(12), open = fr(10);
  // The mark (and any letter it carries) leaves as the field closes over it.
  k.mark("mark", W / 2, cy, size, "light", markStart, fieldAt + open - fr(2));
  k.accent("mark:ripple", W / 2, cy, u(110), "light", markStart + fr(6));
  if (input.kicker) {
    const spec: DesignType = { ...type.small, size: 34, tracking: 3, maxLines: 1, align: "center", color: col.ink };
    ctx.line("kicker", input.kicker, spec, M, CW, cy + u(64), typing!, kickerStart, lineAt + fr(14));
  }
  // The mark becomes a line to both edges, then the line opens into the field.
  // The lines leave from the mark's edges and are gone by the time the title rolls in.
  for (const [index, x] of [b.MX, W - b.MX].entries()) {
    const from = W / 2 + (x < W / 2 ? -1 : 1) * (size / 2 + u(12));
    b.drawn(`line:${index}`, [{ type: "M", x: from, y: cy }, { type: "L", x, y: cy }], col.accent, lineAt, fieldAt + open - fr(2), { width: Math.max(3, u(6)), frames: fr(9), cap: "round" });
  }
  b.shape("field:top", ctx.roundedRect(0, 0, W, cy, 0), col.accent, fieldAt, end, { revealFrom: "bottom", revealFrames: open });
  b.shape("field:bottom", ctx.roundedRect(0, cy, W, H - cy, 0), col.accent, fieldAt, end, { revealFrom: "top", revealFrames: open });
  // The title on the field: the style's title motion in the field's ink, the subtitle in its second ink.
  const titleSpec: DesignType = { ...type.title, size: 150, maxLines: 2, align: "center", color: col.onAccent };
  titleSpec.size = b.fitSize(input.title, titleSpec, CW);
  const titleMotion = k.motion.title(input.title), titleStart = fieldAt + open - fr(2), h = ctx.measure(input.title, titleSpec, M, CW).height;
  b.requireTime(b.need(input.title, titleStart, titleMotion), "主標");
  const title = ctx.line("headline", input.title, titleSpec, M, CW, cy - h / 2 - Y(30), titleMotion, titleStart, end);
  let settled = titleStart + b.span(input.title, titleMotion);
  if (input.subtitle) {
    const spec: DesignType = { ...type.body, size: 60, maxLines: 2, align: "center", color: col.accentWord }, motionV2 = k.motion.body(input.subtitle), start = settled - fr(4);
    b.requireTime(b.need(input.subtitle, start, motionV2), "副標");
    ctx.line("subtitle", input.subtitle, spec, M, CW, ctx.ink(title).bottom + Y(44), motionV2, start, end);
    settled = Math.max(settled, start + b.span(input.subtitle, motionV2));
  }
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

export const SCENE_LAYOUTS: Record<SceneFamily, (b: Base, k: Kit) => void> = { word_build: wordBuild, stat_cycle: statCycle, word_cycle: wordCycle,
  logo_end: logoEnd, ranked_list: rankedList, ui_demo: uiDemo, mark_open: markOpen };
