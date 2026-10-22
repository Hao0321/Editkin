// Reference-study styles (Hao 2026-10-07: 「我給你的參考資料你應該把他們的東西都抄下來保留…到時候就有大量模板可以選擇套用」).
// Each kit reproduces one studied reference's visual system for every shared family: colour structure, type pairing,
// chrome, framing and motion personality. Author names, logos, product UI, footage and fonts are not copied: copy, footage
// and fonts are the creator's own and every colour is an editable palette role. Private study material (not in the public kit).
import { MOTION_CURVES } from "../motion/motionLanguage";
import type { Base, DesignType, Kit, Rect, Shape, Surface } from "./referenceMotionDesignThemes";

/** Upright pixel size of a source for viewfinder spec labels (real metadata only; nothing when unknown). */
function sourceSpecs(b: Base, index: number) {
  const asset = b.ctx.sourceAssets[index], source = b.ctx.sources[index];
  let dims: string | undefined;
  if (asset?.width && asset.height) {
    const long = Math.max(asset.width, asset.height), short = Math.min(asset.width, asset.height);
    const portrait = (asset.displayAspectRatio ?? asset.width / asset.height) < 1;
    // Physical glyph runs take ASCII, Latin, Han and common punctuation only: "x", not the multiplication sign.
    dims = portrait ? `${short} x ${long}` : `${long} x ${short}`;
  }
  const at = source ? Math.max(0, source.sourceStart) : undefined;
  const time = at === undefined ? undefined : `SRC ${String(Math.floor(at / 60)).padStart(2, "0")}:${(at % 60).toFixed(1).padStart(4, "0")}`;
  return { dims, time };
}

/** A soft radial glow: feathered ellipses stepped about one feather apart (vector softness stops at 64px), so the steps
 * melt into a gradient that peaks at `peak` opacity of `color` (#RRGGBB) in the centre. */
function bloom(b: Base, role: string, cx: number, cy: number, rx: number, ry: number, color: string, peak: number, layer: "background" | "foreground",
  start = 0, end = b.end) {
  const steps = Math.max(3, Math.min(10, Math.round(Math.max(rx, ry) / 64)));
  const alpha = Math.max(1, Math.round(255 * (1 - (1 - peak) ** (1 / steps)))).toString(16).padStart(2, "0").toUpperCase();
  for (let i = 0; i < steps; i++) {
    const k = 1 - i / steps;
    b.ctx.panel(`${role}:${i}`, cx - rx * k, cy - ry * k, 2 * rx * k, 2 * ry * k, 0, `${color}${alpha}`, layer, start, end, { ellipse: true, softness: 64 });
  }
}

/** Four thin L marks inset from the frame corners (viewfinder chrome). */
function cornerMarks(b: Base, inset: number, arm: number, thickness: number): Shape {
  const { ctx, W, H } = b, marks: Shape = [];
  for (const [x, y, sx, sy] of [[inset, inset, 1, 1], [W - inset, inset, -1, 1], [inset, H - inset, 1, -1], [W - inset, H - inset, -1, -1]] as const) {
    marks.push(...ctx.roundedRect(sx > 0 ? x : x - arm, sy > 0 ? y : y - thickness, arm, thickness, 0),
      ...ctx.roundedRect(sx > 0 ? x : x - thickness, sy > 0 ? y : y - arm, thickness, arm, 0));
  }
  return marks;
}

// ---- Showreel: a motion designer's reel (fields, tumble type, HUD chrome, the signal dot) -----------------------------
export function reelKit(b: Base): Kit {
  const { ctx, input, col, u, Y, fr, M, W, H } = b;
  const ink = (s: Surface) => s === "light" ? col.ink : col.onAccent;
  const quiet = (s: Surface) => s === "light" ? col.mute : col.onAccentMute;
  // The recurring mark: the signal colour on the page, the whisper ink on a signal-coloured field.
  const signal = (s: Surface) => s === "light" ? col.accent : col.accentWord;
  const snappy = MOTION_CURVES.expoOut;
  const kit: Kit = {
    surfaceFor: family => ["comparison_pair", "level_bridge", "kinetic_network", "brand_recap"].includes(family) ? "bold" : "light",
    type: s => ({ title: { size: 124, weight: 900, color: ink(s), family: b.heading, maxLines: 2 }, claim: { size: 140, weight: 900, color: col.ink, family: b.heading, maxLines: 2 },
      // The whisper voice: the body family (Kai by default) in the field's second ink.
      body: { size: 44, weight: 700, color: s === "light" ? col.ink : col.accentWord, family: b.body, maxLines: 4 },
      label: { size: 34, weight: 800, color: ink(s), family: b.heading, maxLines: 2 },
      lead: { size: 46, weight: 900, color: ink(s), family: b.heading, maxLines: 2 }, detail: { size: 28, weight: 500, color: quiet(s), family: b.heading, maxLines: 3 },
      numeral: { size: 132, weight: 900, color: ink(s), family: b.numerals }, small: { size: 20, weight: 700, color: quiet(s), family: b.heading, maxLines: 1, tracking: 4 },
      tag: { size: 28, weight: 800, color: col.paper, family: b.heading, tracking: 2 } }),
    motion: {
      // Heavy type tumbles up: per character, a rise with a small turn and a focus pull.
      title: value => b.text(value, { dy: u(70), rotation: -9, blur: u(10), frames: fr(13), staggerMax: 2, tailMax: 12, easing: snappy }),
      body: value => b.text(value, { perCharacter: false, dx: -u(26), dy: 0, blur: u(12), frames: fr(14), easing: snappy }),
      label: value => b.text(value, { perCharacter: false, dy: u(18), blur: u(6), frames: fr(10), easing: snappy }),
      numeral: value => b.text(value, { dy: 0, dx: u(60), blur: u(18), frames: fr(10), staggerMax: 1, easing: snappy }),
      pop: () => b.fade(fr(8), .5, MOTION_CURVES.backOutSoft) },
    accentWord: s => s === "light" ? col.accentInk : col.accentWord,
    ink,
    page(s, options = {}) {
      const layer = options.layer ?? "background";
      ctx.panel("design:page", 0, 0, W, H, 0, s === "light" ? col.paper : col.accent, layer, 0, b.end);
      // A flat field with a quiet dot grid (a full-frame lift showed its feather steps as rings).
      b.dots("design:dots", 0, H, u(46), u(1.5), s === "light" ? `${col.ink}17` : `${col.onAccent}1A`, layer, 0, b.end);
    },
    chrome(s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", top = Y(b.D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(6));
      const spec: DesignType = { ...kit.type(s).small, size: 32, tracking: 2 }, brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) b.lineAt(`design:brand${suffix}`, brand, { ...spec, color: ink(s) }, M, top, motionV2, start, stop);
      if (kicker) {
        const m = b.lineSize(kicker, spec), x = b.R - m.w, r = u(7);
        b.lineAt(`design:kicker${suffix}`, kicker, spec, x, top, motionV2, start, stop);
        b.shape(`design:kicker:dot${suffix}`, b.ellipseContour(x - u(18), top + m.h / 2, r, r), signal(s), start, stop, { motionV2 });
      }
    },
    footer(s, start = 0, stop = b.end, suffix = "") {
      const motionV2 = start === 0 ? ctx.still() : b.fade(fr(6)), y = Y(b.D.grid.footer);
      b.shape(`design:corners${suffix}`, cornerMarks(b, u(26), u(28), Math.max(1, u(2))), s === "light" ? `${col.ink}66` : `${col.onAccent}73`, start, stop, { motionV2 });
      // The reel's recording light: a signal dot in the frame corner. The band below 1660 sits under the platform's own
      // caption and buttons, so it carries no words (Shorts v2).
      b.shape(`design:rec:dot${suffix}`, b.ellipseContour(b.W - b.MX - u(40), y, u(7), u(7)), signal(s), start, stop, { motionV2 });
    },
    title(role, value, s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type(s).title, size: options.size ?? 124, maxLines: options.maxLines ?? 2, align: options.align ?? "left" };
      spec.size = b.fitSize(value, spec, width);
      // Identity type: characters tumble up out of their own line window (a mask rise with a turn).
      const rise = (t: string) => { const m = b.maskRise(t, u(spec.size) * .95); return { ...m, entrance: { ...m.entrance, rotationDegrees: -12 } }; };
      const pieces = ctx.inline(role, b.runsOf(value, ink(s), kit.accentWord(s)), spec, x, width, inkTop, rise, start, end,
        { clipLines: { padX: u(26), padTop: u(spec.size) * .36, padBottom: u(spec.size) * .14 } });
      const box = b.union(pieces.map(ctx.ink)), settled = start + b.span(value, rise(value));
      // The coloured period: a signal dot on the last line's baseline when the measure leaves room for it.
      const last = ctx.inkLines(pieces[pieces.length - 1]).at(-1) ?? box, r = Math.max(u(8), u(spec.size) * .085);
      if (last.right + u(10) + 2 * r <= x + width) {
        // In a settling opener the dot moves with the last character it follows.
        b.follow(b.turnOf(pieces[pieces.length - 1], true), () => b.shape(`${role}:dot`, b.ellipseContour(last.right + u(10) + r, last.bottom - r, r, r), signal(s),
          settled - fr(4), end, { motionV2: b.fade(fr(7), .2, MOTION_CURVES.backOut) }));
      }
      return { ink: box, settled };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // A signal line draws through each line and lands on a dot.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top, mid = box.top + h * .54, t = Math.max(3, h * .09), at = start + index * fr(4), right = box.right + u(22);
        b.drawn(`strike:${index}`, [{ type: "M", x: box.left - u(22), y: mid }, { type: "L", x: right, y: mid }], col.accent, at, b.end,
          { width: t, frames: fr(9), overText: true, cap: "round" });
        b.shape(`strike:${index}:dot`, b.ellipseContour(right, mid, t * 1.25, t * 1.25), col.accent, at + fr(8), b.end, { motionV2: b.fade(fr(6), .2, MOTION_CURVES.backOut), overText: true });
      });
      return fr(13) + (lines.length - 1) * fr(4);
    },
    frame: { top: u(70), right: u(16), bottom: u(16), left: u(16) },
    image(index, rect, role, start, s, options = {}) {
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "rounded", radiusPixels: u(4) }, fadeFrames: fr(9), scaleFrom: 1.08, dy: options.dy });
      if (!options.plain) {
        // Viewfinder brackets with the footage's own frame size and source time: one spec row above the window, at a size a
        // phone can read and inside the platform-safe text column (Shorts v2).
        const r = block.box, color = s === "light" ? col.ink : col.onAccent, spec: DesignType = { ...kit.type(s).small, size: 34, tracking: 2 }, { dims, time } = sourceSpecs(b, index);
        b.shape(`${block.key}:brackets`, b.brackets(r, u(14), u(34), Math.max(2, u(3))), color, start + fr(6), b.end, { motionV2: b.fade(fr(9), 1.06, snappy) });
        const row = r.y - u(14) - u(16) - b.lineSize("0", spec).h;
        const dimsRight = dims ? Math.max(b.M, r.x - u(14)) + b.lineSize(dims, spec).w : b.M;
        if (dims) b.lineAt(`${block.key}:dims`, dims, spec, Math.max(b.M, r.x - u(14)), row, b.fade(fr(8)), start + fr(10), b.end);
        if (time) {
          const m = b.lineSize(time, spec), x = Math.min(r.x + r.w + u(14), b.R) - m.w;
          if (x > dimsRight + u(32)) b.lineAt(`${block.key}:time`, time, spec, x, row, b.fade(fr(8)), start + fr(12), b.end);
        }
      }
      return { ...block, outer: options.plain ? block.box : { x: block.box.x - u(16), y: block.box.y - u(74), w: block.box.w + u(32), h: block.box.h + u(90) } };
    },
    tag(role, value, x, yTop, start, stop, s, tone = "accent") {
      // A dark pill with a signal dot (accent), the second colour, or the page's ink.
      const { w, h } = kit.tagSize(value), motionV2 = b.fade(fr(8), .8, MOTION_CURVES.backOutSoft);
      const fill = tone === "second" ? col.second : tone === "ink" ? col.ink : ink(s);
      const text = tone === "second" ? col.onSecond : tone === "ink" ? col.paper : s === "light" ? col.paper : col.accent;
      b.shape(`${role}:pill`, b.pill(x, yTop, w, h), fill, start, stop, { motionV2 });
      b.shape(`${role}:dot`, b.ellipseContour(x + u(22), yTop + h / 2, u(6), u(6)), tone === "accent" ? (s === "light" ? col.accent : col.accentWord) : text, start, stop, { motionV2 });
      const spec = { ...kit.type(s).tag, color: text }, m = b.lineSize(value, spec);
      b.lineAt(role, value, spec, x + u(40), yTop + (h - m.h) / 2, b.fade(fr(6)), start + fr(3), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + u(62), h: m.h + 2 * u(15) }; },
    verdict(role, cx, cy, size, kind, start, s) {
      const fill = kind === "good" ? (s === "light" ? col.accent : col.onAccent) : (s === "light" ? col.ink : `${col.onAccent}2E`);
      const mark = kind === "good" ? (s === "light" ? col.onAccent : col.accent) : (s === "light" ? col.paper : col.onAccent);
      ctx.panel(role, cx - size / 2, cy - size / 2, size, size, 0, fill, "foreground", start, b.end, { ellipse: true, motionV2: kit.motion.pop() });
      const d = size, t = d * .11;
      const shape = kind === "good" ? b.polyline([[cx - .22 * d, cy + .02 * d], [cx - .06 * d, cy + .18 * d], [cx + .24 * d, cy - .16 * d]], t)
        : [...b.stroke(cx - .16 * d, cy - .16 * d, cx + .16 * d, cy + .16 * d, t), ...b.stroke(cx + .16 * d, cy - .16 * d, cx - .16 * d, cy + .16 * d, t)];
      b.shape(`${role}:mark`, shape, mark, start + fr(3), b.end, { motionV2: kit.motion.pop() });
    },
    marker(role, x, y, start, s) { b.shape(role, b.ellipseContour(x + u(9), y + u(16), u(9), u(9)), signal(s), start, b.end, { motionV2: kit.motion.pop() }); return u(34); },
    divider(role, x, y, w, start, s) { b.bar(role, x, y, w, Math.max(1, u(2)), s === "light" ? `${col.ink}33` : col.onAccentRule, "foreground", start, b.end, fr(12), b.fade(1)); },
    card(role, rect, start, end) {
      // A floating card: a soft shadow under a rounded sheet.
      const motionV2 = b.fade(fr(12), .97, snappy, u(24));
      ctx.panel(`${role}:shadow`, rect.x + u(6), rect.y + u(18), rect.w - u(12), rect.h, u(22), `${col.dark ? col.white : col.ink}1F`, "foreground", start, end, { softness: 28, motionV2 });
      b.shape(`${role}:fill`, ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(20)), col.dark ? col.raised : col.white, start, end, { motionV2 });
    },
    badge(role, x, y, size, value, emphasis, start, end) {
      const cx = x + size / 2, cy = y + size / 2, motionV2 = kit.motion.pop();
      if (emphasis) ctx.panel(role, x, y, size, size, 0, col.accent, "foreground", start, end, { ellipse: true, motionV2 });
      else b.shape(role, b.ring(b.ellipseContour(cx, cy, size / 2, size / 2), b.ellipseContour(cx, cy, size / 2 - u(3), size / 2 - u(3), false)), col.ink, start, end, { motionV2 });
      const spec: DesignType = { size: 40, weight: 900, color: emphasis ? col.onAccent : col.ink, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, b.fade(fr(6)), start + fr(3), end);
    },
    // Dotted rings, like the reel's generative particle rings, over a faint disc.
    node(role, cx, cy, r, index, sf, start, end, motionV2) {
      const color = sf === "light" ? col.ink : col.onAccent, count = Math.min(72, Math.max(24, Math.round(2 * Math.PI * r / u(17)))), dot = Math.max(1.5, u(3.4));
      const dots: Shape = [];
      for (let i = 0; i < count; i++) { const a = i / count * 2 * Math.PI; dots.push(...b.ellipseContour(cx + r * Math.cos(a), cy + r * Math.sin(a), dot, dot)); }
      b.shape(`${role}:fill`, b.ellipseContour(cx, cy, r, r), `${color}${["17", "21", "12"][index % 3]}`, start, end, { motionV2 });
      b.shape(`${role}:dots`, dots, color, start, end, { motionV2 });
    },
    nodeInk: (_index, sf) => sf === "light" ? col.ink : col.onAccent,
    hub(role, cx, cy, r, sf, start, end) {
      const dot = signal(sf);
      bloom(b, `${role}:glow`, cx, cy, r * 1.7, r * 1.7, dot, .3, "foreground", start, end);
      b.shape(role, b.ellipseContour(cx, cy, r, r), dot, start, end, { motionV2: b.fade(fr(10), .3, MOTION_CURVES.backOutSoft) });
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(4));
      // onAccent reads on the signal colour, and on a signal field the dot is the whisper ink that onAccent also reads on.
      return col.onAccent;
    },
    halo(role, cx, cy, r, sf, start, end) {
      b.drawn(role, b.ellipseContour(cx, cy, r, r), sf === "light" ? `${col.ink}8C` : `${col.onAccent}8C`, start, end,
        { width: Math.max(1, u(2)), frames: fr(18), tip: u(7), tipColor: signal(sf) });
    },
    orbit(role, cx, cy, rx, ry, tilt, s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, s === "light" ? `${col.ink}A6` : `${col.onAccent}A6`, start, end, { width: Math.max(1, u(2.5)), frames: fr(24), tip: u(7), tipColor: signal(s) });
    },
    trail(role, points, s, start, frames, end) {
      // The reel's dot becoming a line: a signal line that draws itself with its dot leading.
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        signal(s), start, end, { width: Math.max(2, u(3)), frames, tip: u(7), tipColor: signal(s), cap: "round" });
    },
    accent(role, cx, cy, size, s, start) {
      // A radial burst on the beat: a thin ring and sixteen rays.
      b.impact(role, cx, cy, size, signal(s), start, { rays: 16, thickness: Math.max(1, u(2.5)) });
    },
    mark(role, cx, cy, size, s, start, end) {
      // The signal dot with its glow: the reel's recurring mark.
      bloom(b, `${role}:glow`, cx, cy, size * 1.5, size * 1.5, signal(s), .3, "foreground", start, end);
      b.shape(role, b.ellipseContour(cx, cy, size / 2, size / 2), signal(s), start, end, { motionV2: b.fade(fr(9), .2, MOTION_CURVES.backOut) });
    },
    emphasis(role, box, s, start, end) {
      // A hand-drawn swoosh that draws itself under the word and lands on a dot.
      const w = box.right - box.left, h = box.bottom - box.top, y = box.bottom + h * .16, t = Math.max(3, h * .06);
      const swoosh: Shape = [{ type: "M", x: box.left - u(6), y: y + h * .02 },
        { type: "C", x1: box.left + w * .3, y1: y + h * .12, x2: box.left + w * .72, y2: y + h * .04, x: box.right + u(12), y: y - h * .1 }];
      b.drawn(role, swoosh, signal(s), start, end, { width: t, frames: fr(10), cap: "round", tip: t * .9, tipColor: signal(s) });
    },
    glide: MOTION_CURVES.expoOut,
  };
  return kit;
}

// ---- Product launch: studio page, focus-pull words, app windows, pills and an app mark -------------------------------
export function launchKit(b: Base): Kit {
  const { ctx, input, col, u, Y, fr, M, W, H } = b;
  const ink = () => col.ink;
  const smooth = MOTION_CURVES.quintOut;
  /** An app window around footage: a title bar above it, one rounded sheet. */
  const windowOf = (rect: Rect) => ({ bar: u(40), radius: u(22), outer: { x: rect.x, y: rect.y - u(40), w: rect.w, h: rect.h + u(40) } });
  const kit: Kit = {
    surfaceFor: () => "light",
    type: () => ({ title: { size: 112, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, claim: { size: 128, weight: 900, color: `${col.ink}D9`, family: b.heading, maxLines: 2 },
      body: { size: 38, weight: 500, color: `${col.ink}B8`, family: b.body, maxLines: 4 }, label: { size: 34, weight: 700, color: col.ink, family: b.heading, maxLines: 2 },
      lead: { size: 46, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, detail: { size: 28, weight: 500, color: col.mute, family: b.body, maxLines: 3 },
      numeral: { size: 140, weight: 900, color: col.ink, family: b.numerals }, small: { size: 20, weight: 600, color: col.mute, family: b.body, maxLines: 1, tracking: 3 },
      tag: { size: 26, weight: 700, color: col.ink, family: b.heading } }),
    motion: {
      // Words rise into place out of a focus pull; numbers blur in with a slight scale.
      title: value => b.text(value, { dy: u(30), blur: u(16), frames: fr(10), staggerMax: 1, tailMax: 9, easing: smooth }),
      body: value => b.text(value, { perCharacter: false, dy: u(16), blur: u(10), frames: fr(10), easing: smooth }),
      label: value => b.text(value, { perCharacter: false, dy: u(14), blur: u(8), frames: fr(9), easing: smooth }),
      numeral: value => b.text(value, { perCharacter: false, dy: u(20), scale: .92, blur: u(22), frames: fr(11), easing: smooth }),
      pop: () => b.fade(fr(9), .85, MOTION_CURVES.backOutSoft) },
    accentWord: () => col.accentInk,
    ink,
    page(_s, options = {}) {
      const layer = options.layer ?? "background";
      ctx.panel("design:page", 0, 0, W, H, 0, col.paper, layer, 0, b.end);
      // Soft blooms: warm brand light in two corners of a light stage, one low glow on a dark one.
      if (col.dark) bloom(b, "design:glow", W * .08, H * .9, W * .7, H * .2, col.accent, .3, layer);
      else {
        bloom(b, "design:bloom:0", W * .1, H * .08, W * .55, H * .14, col.accent, .22, layer);
        bloom(b, "design:bloom:1", W * .92, H * .86, W * .6, H * .16, col.glow, .26, layer);
      }
    },
    chrome(_s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", top = Y(b.D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(6));
      const brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) {
        // An app mark in the brand colour carrying the wordmark's first letter, then the wordmark.
        const size = u(50), y = top - u(9), letter = [...brand.trim()][0]?.toUpperCase();
        b.shape(`design:mark${suffix}`, ctx.roundedRect(M, y, size, size, u(12)), col.accent, start, stop, { motionV2 });
        if (letter) {
          const spec: DesignType = { size: 32, weight: 900, color: col.onAccent, family: b.heading, align: "center" };
          ctx.line(`design:mark:letter${suffix}`, letter, spec, M, size, y + (size - ctx.measure(letter, spec, M, size).height) / 2, motionV2, start, stop);
        }
        b.lineAt(`design:brand${suffix}`, brand, { size: 32, weight: 800, color: col.ink, family: b.heading }, M + size + u(14), top, motionV2, start, stop);
      }
      if (kicker) {
        const spec: DesignType = { size: 32, weight: 600, color: col.mute, family: b.body }, m = b.lineSize(kicker, spec);
        b.lineAt(`design:kicker${suffix}`, kicker, spec, b.R - m.w, top + u(4), motionV2, start, stop);
      }
    },
    footer() { /* the launch page stays clean at the foot */ },
    title(role, value, _s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type("light").title, size: options.size ?? 112, maxLines: options.maxLines ?? 2, align: options.align ?? "left" };
      spec.size = b.fitSize(value, spec, width);
      const runs = b.runsOf(value, col.ink, col.accentInk), motionFor = (t: string) => kit.motion.title(t);
      const pieces = ctx.inline(role, runs, spec, x, width, inkTop, motionFor, start, end);
      const settled = start + b.span(value, motionFor(value));
      // The accent word sits on a soft brand-coloured highlight that wipes in once the line has landed (its pieces carry
      // the accent ink; nothing is marked when the palette makes both inks the same).
      if (runs.length > 1 && col.accentInk !== col.ink) {
        for (const [index, piece] of pieces.filter(piece => piece.textColor === col.accentInk && piece.text.trim()).entries()) {
          const box = ctx.ink(piece), h = box.bottom - box.top;
          // In a settling opener the highlight moves with its word.
          b.follow(b.turnOf(piece), () => b.shape(`${role}:highlight:${index}`, ctx.roundedRect(box.left - u(12), box.top - h * .12, box.right - box.left + u(24), h * 1.26, u(10)),
            `${col.accent}29`, settled - fr(2), end, { revealFrom: "left", revealFrames: fr(8) }));
        }
      }
      return { ink: b.union(pieces.map(ctx.ink)), settled };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // A brand-coloured line strikes each line from the left.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top, mid = box.top + h * .55, t = Math.max(3, h * .08);
        b.shape(`strike:${index}`, ctx.roundedRect(box.left - u(14), mid - t / 2, box.right - box.left + u(28), t, t / 2), col.accent, start + index * fr(4), b.end,
          { revealFrom: "left", revealFrames: fr(9), overText: true });
      });
      return fr(12) + (lines.length - 1) * fr(4);
    },
    frame: { top: u(40), right: 0, bottom: 0, left: 0 },
    image(index, rect, role, start, _s, options = {}) {
      const plain = options.plain || options.arch;
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "rounded", radiusPixels: plain ? u(18) : u(4) }, appearAfter: plain ? 0 : fr(4), fadeFrames: fr(10), scaleFrom: 1.03, dy: options.dy ?? u(30) });
      if (plain) return { ...block, outer: block.box };
      // An app window: soft shadow, a rounded sheet under the footage with a title bar and window dots.
      const win = windowOf(block.box), o = win.outer, motionV2 = b.fade(fr(12), .96, smooth, u(30));
      ctx.panel(`${block.key}:shadow`, o.x + u(10), o.y + u(26), o.w - u(20), o.h, u(28), `${col.dark ? "#000000" : col.ink}2E`, "background", start, b.end, { softness: 40, motionV2 });
      b.shape(`${block.key}:sheet`, ctx.roundedRect(o.x, o.y, o.w, o.h, win.radius), col.dark ? col.raised : col.white, start, b.end, { underMedia: true, motionV2 });
      b.shape(`${block.key}:dots`, [0, 1, 2].flatMap(i => b.ellipseContour(o.x + u(24) + i * u(20), o.y + win.bar / 2, u(6), u(6))), `${col.ink}2E`, start + fr(2), b.end, { motionV2 });
      return { ...block, outer: o };
    },
    tag(role, value, x, yTop, start, stop, _s, tone = "accent") {
      // A rounded pill: quiet grey (accent tone reads as a neutral chip), the brand colour, or the live colour.
      const { w, h } = kit.tagSize(value), motionV2 = kit.motion.pop();
      const fill = tone === "second" ? col.second : tone === "ink" ? col.ink : `${col.ink}14`;
      const text = tone === "second" ? col.onSecond : tone === "ink" ? col.paper : col.ink;
      b.shape(`${role}:pill`, b.pill(x, yTop, w, h), fill, start, stop, { motionV2 });
      const spec = { ...kit.type("light").tag, color: text }, m = b.lineSize(value, spec);
      b.lineAt(role, value, spec, x + u(24), yTop + (h - m.h) / 2, b.fade(fr(6)), start + fr(3), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + u(48), h: m.h + 2 * u(14) }; },
    verdict(role, cx, cy, size, kind, start) {
      ctx.panel(role, cx - size / 2, cy - size / 2, size, size, 0, kind === "good" ? col.second : `${col.ink}26`, "foreground", start, b.end, { ellipse: true, motionV2: kit.motion.pop() });
      const d = size, t = d * .11;
      const shape = kind === "good" ? b.polyline([[cx - .22 * d, cy + .02 * d], [cx - .06 * d, cy + .18 * d], [cx + .24 * d, cy - .16 * d]], t)
        : [...b.stroke(cx - .15 * d, cy - .15 * d, cx + .15 * d, cy + .15 * d, t), ...b.stroke(cx + .15 * d, cy - .15 * d, cx - .15 * d, cy + .15 * d, t)];
      b.shape(`${role}:mark`, shape, kind === "good" ? col.onSecond : col.ink, start + fr(3), b.end, { motionV2: kit.motion.pop() });
    },
    marker(role, x, y, start) { b.shape(role, ctx.roundedRect(x, y + u(6), u(18), u(18), u(5)), col.accent, start, b.end, { motionV2: kit.motion.pop() }); return u(34); },
    divider(role, x, y, w, start) { b.bar(role, x, y, w, Math.max(1, u(1.5)), `${col.ink}1A`, "foreground", start, b.end, fr(12), b.fade(1)); },
    card(role, rect, start, end) {
      const motionV2 = b.fade(fr(12), .97, smooth, u(24));
      ctx.panel(`${role}:shadow`, rect.x + u(8), rect.y + u(20), rect.w - u(16), rect.h, u(24), `${col.dark ? "#000000" : col.ink}24`, "foreground", start, end, { softness: 36, motionV2 });
      b.shape(`${role}:fill`, ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(22)), col.dark ? col.raised : col.white, start, end, { motionV2 });
    },
    badge(role, x, y, size, value, emphasis, start, end) {
      b.shape(role, ctx.roundedRect(x, y, size, size, size * .28), emphasis ? col.accent : `${col.ink}12`, start, end, { motionV2: kit.motion.pop() });
      const spec: DesignType = { size: 40, weight: 900, color: emphasis ? col.onAccent : col.ink, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, b.fade(fr(6)), start + fr(3), end);
    },
    // Floating rounded cards with soft shadows; the hub is the app mark.
    node(role, cx, cy, r, index, _sf, start, end, motionV2) {
      ctx.panel(`${role}:shadow`, cx - r * .92, cy - r * .62, r * 1.84, r * 1.5, r * .4, `${col.dark ? "#000000" : col.ink}1F`, "foreground", start, end, { softness: 30, motionV2 });
      b.shape(`${role}:fill`, ctx.roundedRect(cx - r, cy - r * .74, 2 * r, 1.48 * r, r * .32), col.dark ? col.raised : col.white, start, end, { motionV2 });
      b.shape(`${role}:edge`, b.ring(ctx.roundedRect(cx - r, cy - r * .74, 2 * r, 1.48 * r, r * .32), ctx.roundedRect(cx - r + u(2), cy - r * .74 + u(2), 2 * r - u(4), 1.48 * r - u(4), r * .32 - u(2), false)),
        index % 3 === 1 ? `${col.accent}66` : `${col.ink}1A`, start, end, { motionV2 });
    },
    nodeInk: () => col.ink,
    hub(role, cx, cy, r, sf, start, end) {
      bloom(b, `${role}:glow`, cx, cy, r * 1.6, r * 1.6, col.accent, .26, "foreground", start, end);
      b.shape(role, ctx.roundedRect(cx - r, cy - r, 2 * r, 2 * r, r * .5), col.accent, start, end, { motionV2: kit.motion.pop() });
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(4));
      return col.onAccent;
    },
    halo(role, cx, cy, r, _sf, start, end) {
      b.drawn(role, b.ellipseContour(cx, cy, r, r), `${col.ink}2E`, start, end, { width: Math.max(1, u(2)), frames: fr(18) });
    },
    orbit(role, cx, cy, rx, ry, tilt, _s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, `${col.accent}99`, start, end, { width: Math.max(1, u(2.5)), frames: fr(24), tip: u(6), tipColor: col.accent });
    },
    trail(role, points, _s, start, frames, end) {
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        `${col.ink}33`, start, end, { width: Math.max(1, u(2.5)), frames, cap: "round" });
    },
    accent(role, cx, cy, size, _s, start) {
      b.impact(role, cx, cy, size, `${col.accent}B3`, start, { thickness: Math.max(1, u(2.5)) });
    },
    mark(role, cx, cy, size, _s, start, end) {
      // The app mark: a brand-coloured rounded square with a soft glow, carrying the wordmark's first letter.
      bloom(b, `${role}:glow`, cx, cy + size * .12, size * .95, size * .95, col.accent, .3, "foreground", start, end);
      b.shape(role, ctx.roundedRect(cx - size / 2, cy - size / 2, size, size, size * .27), col.accent, start, end, { motionV2: kit.motion.pop() });
      const letter = [...(input.brandMark ?? "").trim()][0]?.toUpperCase();
      if (letter && /[\x21-\x7E\p{Script=Han}]/u.test(letter)) {
        const spec: DesignType = { size: Math.round(size / ctx.unit * .52), weight: 900, color: col.onAccent, family: b.heading, align: "center" };
        ctx.line(`${role}:letter`, letter, spec, cx - size / 2, size, cy - ctx.measure(letter, spec, cx - size / 2, size).height / 2, b.fade(fr(8), .8), start + fr(3), end);
      }
    },
    emphasis(role, box, _s, start, end) {
      // A soft brand-coloured highlight behind the word.
      const h = box.bottom - box.top;
      b.shape(role, ctx.roundedRect(box.left - u(12), box.top - h * .12, box.right - box.left + u(24), h * 1.26, u(10)), `${col.accent}29`, start, end,
        { revealFrom: "left", revealFrames: fr(8) });
    },
    glide: MOTION_CURVES.quintOut,
  };
  return kit;
}
