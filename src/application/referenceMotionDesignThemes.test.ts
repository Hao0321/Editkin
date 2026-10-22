import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { evaluateMotionGraphicV2Easing } from "../motion/motionEasing";
import { REFERENCE_MOTION_DESIGN_THEMES, referenceMotionDesignSystems, type ReferenceMotionDesignSystem, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { writeAssContent } from "../render/captionAss";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { SCENE_FAMILY_IDS } from "./referenceMotionDesignScenes";
import { designThemeColors } from "./referenceMotionDesignThemes";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Synthetic graph metadata (no file probe, rights or pixels); real bundled glyph bytes for every face the themes use.
// Like the product's provider (src/mcp/referenceMotionPhysicalFonts.ts), each face is digested against the catalog and
// parsed once and its runs are made from that parse (identical runs), instead of re-reading and re-parsing a 10–16 MB
// face for every text inside the 10-second preparation deadline. At most six parsed faces are kept.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    if (faces.size >= 6) faces.delete(faces.keys().next().value!);
    faces.set(faceId, face);
    face.catch(() => faces.delete(faceId));
  }
  return (await face)(text);
}
function ids() {
  let ordinal = 0;
  return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`;
}
type Family = ReferenceMotionTemplateInput["templateId"];
const FAMILIES: Record<Family, { frames: number; extra: number; input: Partial<ReferenceMotionTemplateInput> }> = {
  strike_reframe: { frames: 330, extra: 0, input: { previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", subtitle: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", tag: "沒有蝙蝠" } },
  comparison_pair: { frames: 150, extra: 1, input: { title: "同樣的皮 兩種做法", accentText: "兩種做法", primaryLabel: "紅油抄手 皮薄透餡", verdicts: ["good", "bad"] } },
  context_stack: { frames: 360, extra: 0, input: { title: "大溪老街 蔡記", accentText: "蔡記",
    items: [{ label: "現場手工做", detail: "鋪粉、壓條全程看得到" }, { label: "麥芽花生 一盒150" }, { label: "全台僅此一家", detail: "申明板寫別無分店" }] } },
  brand_recap: { frames: 420, extra: 0, input: { title: "龍騰斷橋", accentText: "斷橋",
    items: [{ label: "1907", detail: "紅磚拱橋完工" }, { label: "1935", detail: "關刀山大地震震斷" }, { label: "1999", detail: "九二一又斷一次" }, { label: "2003", detail: "列為縣定古蹟" }] } },
  level_bridge: { frames: 180, extra: 0, input: { title: "烏嘎彥竹林", accentText: "竹林", subtitle: "兩邊竹梢往中間彎，太陽從竹縫透進來" } },
  evidence_takeover: { frames: 300, extra: 0, input: { title: "現做麥芽花生糖", accentText: "麥芽花生糖", subtitle: "鋪粉、壓條全程看得到" } },
  focus_wall: { frames: 150, extra: 2, input: { title: "號稱平價版鼎泰豐", accentText: "鼎泰豐", primaryLabel: "紅油抄手" } },
  kinetic_network: { frames: 300, extra: 0, input: { title: "一句話剪成一支片", items: [{ label: "看懂素材" }, { label: "自動剪輯" }, { label: "動態模板" }],
    network: { seed: 32021, points: 32, labels: ["素材", "剪輯", "模板"], hubLabel: "一句話" } } },
  stat_reveal: { frames: 300, extra: 0, input: { title: "一週剪完三支片", accentText: "三支片",
    items: [{ label: "69%", detail: "時間花在挑素材" }, { label: "3 支", detail: "一週完成" }, { label: "NT$0", detail: "不另付費" }] } },
  statement_cut: { frames: 300, extra: 0, input: { title: "用一句話開始剪輯", items: [{ label: "看懂" }, { label: "剪好", detail: "一句話完成" }, { label: "上線" }] } },
  word_build: { frames: 240, extra: 0, input: { title: "你的下一支 影片", accentText: "影片", subtitle: "只要 一句話" } },
  stat_cycle: { frames: 330, extra: 0, input: { title: "一週的成果", items: [{ label: "3 支", detail: "長片完成" }, { label: "69%", detail: "時間花在挑素材" }, { label: "NT$0", detail: "不另付費" }] } },
  word_cycle: { frames: 240, extra: 0, input: { title: "在咖啡涼掉之前", items: [{ label: "剪好" }, { label: "配樂" }, { label: "上線" }] } },
  logo_end: { frames: 180, extra: 0, input: { title: "一句話開始剪輯", subtitle: "AI 剪輯工作室", kicker: "Editkin · Autopilot" } },
  ranked_list: { frames: 300, extra: 0, input: { title: "最常用的三個模板", accentText: "三個", primaryLabel: "使用次數",
    items: [{ label: "數據揭示", detail: "42" }, { label: "宣言快切", detail: "31" }, { label: "逐字標題", detail: "18" }] } },
  ui_demo: { frames: 300, extra: 0, input: { title: "輸出設定", kicker: "Editkin · 匯出", primaryLabel: "開始輸出", subtitle: "影片已輸出",
    items: [{ label: "動態模糊" }, { label: "畫面比例", detail: "9:16" }, { label: "影格率", detail: "30 fps" }] } },
  mark_open: { frames: 270, extra: 0, input: { title: "Hao0321 Studio", kicker: "AI 剪輯 · 2026", subtitle: "每一格都有理由" } },
};
const LABELS = ["再炸一盤 起泡翹邊", "蔥鹽雞", "炸餛飩"], WALL_LABELS = ["蔥鹽雞", "炸餛飩"];
function fixture(theme: ReferenceMotionDesignSystem, family: Family, options: { aspect?: number; style?: ReferenceMotionTemplateInput["style"]; landscape?: boolean } = {}) {
  const spec = FAMILIES[family], aspect = options.aspect ?? 9 / 16;
  const project = createEmptyProject("Synthetic design theme control", { id: `theme-${theme}-${family}`, width: options.landscape ? 1920 : 1080,
    height: options.landscape ? 1080 : 1920, fps: 30 });
  project.assets = Array.from({ length: spec.extra + 1 }, (_, index) => ({ id: `media-${index}`, name: `Synthetic source ${index}`, kind: "video" as const,
    uri: `D:/synthetic/theme-${index}.mov`, duration: 30, width: aspect < 1 ? 1080 : 1920, height: aspect < 1 ? 1920 : 1080, displayAspectRatio: aspect,
    color: { interpretation: "rec709" as const }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }));
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "media-0", timelineStart: 0, sourceStart: 1,
    duration: spec.frames / 30, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input = { templateId: family, clipId: "primary", startFrame: 0, durationFrames: spec.frames, graphicCadence: "kinetic", intent: "shortform",
    designSystem: theme, kicker: "桃園復興｜三民蝙蝠洞", brandMark: "Hao0321 Studio", ...(options.style ? { style: options.style } : {}),
    sources: Array.from({ length: spec.extra }, (_, index) => ({ assetId: `media-${index + 1}`, sourceStart: 2, label: (family === "focus_wall" ? WALL_LABELS : LABELS)[index] })),
    evidenceRefs: ["synthetic:design-theme"], purpose: "Synthetic design theme control; no rendered art or ownership assertion", ...spec.input } as ReferenceMotionTemplateInput;
  return { project: parseProject(project), input };
}
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const cache = new Map<string, Promise<ReturnType<typeof fixture> & { packet: Packet; current: EditProject }>>();
function saved(theme: ReferenceMotionDesignSystem, family: Family, options: Parameters<typeof fixture>[2] = {}, key = "") {
  const id = `${theme}:${family}:${key}`;
  if (!cache.has(id)) cache.set(id, (async () => {
    const f = fixture(theme, family, options);
    const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return cache.get(id)!;
}
const graphics = (packet: Packet) => packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
const colours = (graphic: MotionGraphic) => [graphic.textColor, graphic.backgroundColor, graphic.accentColor].map(value => value.slice(0, 7).toUpperCase());

describe("a scene that starts the video: its first and last frames", () => {
  const cases = referenceMotionDesignSystems.flatMap(theme => (Object.keys(FAMILIES) as Family[]).map(family => [theme, family] as const));
  const WINDOW_PART = /^source:0:(shadow|mat|tape|plate|edge|brackets|glow|tint|dims|time|sheet|dots)$/;
  it.each(cases)("%s %s holds everything that reaches its end and opens on the finished media window", async (theme, family) => {
    const { packet, current } = await saved(theme, family);
    const end = FAMILIES[family].frames, frame = (seconds: number) => Math.round(seconds * 30);
    const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    // Last frame: nothing that lasts to the end fades, slides or scales away a frame before the cut.
    for (const graphic of graphics(packet)) {
      if (frame(graphic.timelineStart + graphic.duration) !== end) continue;
      const exit = graphic.motionV2!.exit;
      // Fully visible at the cut: held still, or a slow drift that ends opaque and near its place (a hold that breathes).
      const still = exit.durationFrames === 1 && exit.scale === 1 && exit.offsetXPixels === 0 && exit.offsetYPixels === 0;
      const drift = exit.durationFrames > 1 && Math.abs(exit.scale - 1) <= .08 && Math.abs(exit.offsetXPixels) <= 32 && Math.abs(exit.offsetYPixels) <= 32;
      expect({ role: roles.get(graphic.id), visible: exit.opacity === 1 && (still || drift) }).toEqual({ role: roles.get(graphic.id), visible: true });
    }
    if (["kinetic_network", "stat_reveal", "statement_cut", ...SCENE_FAMILY_IDS].includes(family)) return;
    // First frame (S-N): the primary footage is at its settled opacity, inside every drawn part of its window.
    const primary = current.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary")!;
    const first = [...primary.keyframes].sort((a, b) => a.time - b.time)[0];
    expect(first.time).toBe(0);
    expect(first.transform.opacity).toBeGreaterThan(0);
    const parts = graphics(packet).filter(graphic => WINDOW_PART.test(roles.get(graphic.id) ?? ""));
    for (const graphic of parts) {
      const entrance = graphic.motionV2!.entrance;
      expect({ role: roles.get(graphic.id), start: frame(graphic.timelineStart), visible: entrance.opacity === 1 || entrance.durationFrames === 1 })
        .toEqual({ role: roles.get(graphic.id), start: 0, visible: true });
      expect(graphic.vectorV2?.revealFrames ?? 1).toBe(1);
    }
  }, 60_000);

  it("keeps the entrance choreography of a scene placed later in the video", async () => {
    const f = fixture("trip_pop_v1", "strike_reframe");
    f.project.tracks[0].clips[0].timelineStart = 2;
    const later = await prepareReferenceMotionTemplateInstance(f.project, { ...f.input, startFrame: 60 }, ids(), { prepareText: physicalText });
    const current = applyCommand(f.project, { type: "batch", commands: later.commands });
    const roles = new Map(later.instance.roles.map(role => [role.id, role.key]));
    const mat = graphics(later).find(graphic => roles.get(graphic.id) === "source:0:mat")!;
    expect(Math.round(mat.timelineStart * 30)).toBeGreaterThan(60);
    expect(mat.motionV2!.entrance.opacity).toBe(0);
    const primary = current.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary")!;
    expect([...primary.keyframes].sort((a, b) => a.time - b.time)[0].transform.opacity).toBe(0);
  }, 60_000);
});

// Shorts layout v2. VA R12 (Shorts/Reels 2026): readable text stays inside x <= 930 and 260 <= y <= 1660 on a 1080x1920
// canvas; the platform's status bar/header, action buttons and description/subscribe overlay cover the rest. Text also
// keeps clear of the left edge, and supporting copy is set at phone reading sizes (VA SHORTS_SAFE_ZONE.min_font_px = 60).
const SHORTS_TEXT_SAFE = { left: 40, right: 930, top: 260, bottom: 1660 };
function inkBoxes(packet: Packet) {
  const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
  return graphics(packet).flatMap(graphic => {
    const layout = packet.layouts.find(row => row.graphicId === graphic.id);
    const segments = (layout?.segments ?? []).filter(segment => segment.outline?.ink);
    if (!graphic.text || !segments.length) return [];
    return [{ graphic, role: roles.get(graphic.id) ?? graphic.id, left: Math.min(...segments.map(s => s.x + s.outline!.ink!.xMin)),
      right: Math.max(...segments.map(s => s.x + s.outline!.ink!.xMax)), top: Math.min(...segments.map(s => s.y + s.outline!.ink!.yMin)),
      bottom: Math.max(...segments.map(s => s.y + s.outline!.ink!.yMax)) }];
  });
}
const floorOf = (role: string) => /(^|:)subtitle(:claim)?(:\d+)?$|^hero:detail$/.test(role) ? 60 : /:detail$/.test(role) ? 40 : /:label$/.test(role) ? 40 : 32;
describe("short-form text stays inside the platform-safe area at a phone reading size", () => {
  it.each(referenceMotionDesignSystems)("%s keeps every text glyph of every family inside VA R12 and above the reading floors", async theme => {
    const violations: string[] = [];
    for (const family of Object.keys(FAMILIES) as Family[]) {
      const { packet } = await saved(theme, family);
      for (const box of inkBoxes(packet)) {
        const where = `${family} ${box.role} 「${box.graphic.text.slice(0, 12)}」`;
        // Half a pixel of tolerance: glyph outlines are measured in fractional design pixels.
        if (box.left < SHORTS_TEXT_SAFE.left - .5 || box.right > SHORTS_TEXT_SAFE.right + .5 || box.top < SHORTS_TEXT_SAFE.top - .5 || box.bottom > SHORTS_TEXT_SAFE.bottom + .5)
          violations.push(`${where} x${Math.round(box.left)}-${Math.round(box.right)} y${Math.round(box.top)}-${Math.round(box.bottom)}`);
        if (box.graphic.fontSize < floorOf(box.role)) violations.push(`${where} ${box.graphic.fontSize}px < ${floorOf(box.role)}px`);
      }
    }
    expect(violations).toEqual([]);
  }, 600_000);
});

// Shorts v2 hierarchy rules: one text never sits on another while both are on screen (including the path an entering or
// leaving line sweeps, unless its glyphs are clipped to their own line window), and a drawn line never crosses a glyph
// except the annotations that are meant to (strikes, underlines, highlights, emphasis marks).
type Box = { left: number; right: number; top: number; bottom: number };
const meets = (a: Box, b: Box, inset = 3) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > inset && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > inset;
const shifted = (a: Box, dx: number, dy: number): Box => ({ left: Math.min(a.left, a.left + dx), right: Math.max(a.right, a.right + dx), top: Math.min(a.top, a.top + dy), bottom: Math.max(a.bottom, a.bottom + dy) });
const ANNOTATION = /strike|underline|highlight|emphasis|:wave|scribble/;
describe("short-form hierarchy: no text on text and no line through a glyph", () => {
  it.each(referenceMotionDesignSystems)("%s keeps every family's text apart and its drawn lines off the glyphs", async theme => {
    const violations: string[] = [];
    for (const family of Object.keys(FAMILIES) as Family[]) {
      const { packet } = await saved(theme, family);
      // Frame by frame: each text sits at its settled ink plus the part of its entrance or exit offset still to travel
      // (linear; a staggered line counts until its last unit has landed). Parts of one composite text (accent runs,
      // split layers, a counting number and its unit) belong together and are not compared with each other.
      const boxes = inkBoxes(packet).map(box => {
        const motion = box.graphic.motionV2!, start = Math.round(box.graphic.timelineStart * 30), stop = Math.round((box.graphic.timelineStart + box.graphic.duration) * 30);
        const clipped = !!(box.graphic as MotionGraphic & { clipRegion?: unknown }).clipRegion, units = Math.max(1, [...box.graphic.text].length);
        const enterFrames = motion.entrance.durationFrames + (motion.sequence.unit === "all" ? 0 : (units - 1) * motion.sequence.staggerFrames);
        const at = (f: number): Box => {
          let dx = 0, dy = 0;
          if (!clipped && f < start + enterFrames) { const left = 1 - (f - start) / Math.max(1, enterFrames); dx = motion.entrance.offsetXPixels * left; dy = motion.entrance.offsetYPixels * left; }
          else if (!clipped && f >= stop - motion.exit.durationFrames) { const done = (f - (stop - motion.exit.durationFrames)) / Math.max(1, motion.exit.durationFrames); dx = motion.exit.offsetXPixels * done; dy = motion.exit.offsetYPixels * done; }
          return { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
        };
        const entering = (f: number) => f < start + enterFrames, leaving = (f: number) => f >= stop - motion.exit.durationFrames;
        return { ...box, start, stop, at, entering, leaving, group: box.role.replace(/:split/g, "").replace(/(:count)?:\d+$/, "").replace(/:(unit|count)$/, "") };
      });
      for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
        if (a.group === b.group || a.group.startsWith(`${b.group}:`) || b.group.startsWith(`${a.group}:`)) continue;
        const from = Math.max(a.start, b.start), to = Math.min(a.stop, b.stop);
        // A handoff (one line leaving while the next arrives in its place) is a crossfade, not a collision.
        for (let f = from; f < to; f++) if (meets(a.at(f), b.at(f)) && !((a.leaving(f) && b.entering(f)) || (b.leaving(f) && a.entering(f)))) {
          violations.push(`${family} 「${a.graphic.text.slice(0, 8)}」(${a.role}) × 「${b.graphic.text.slice(0, 8)}」(${b.role}) @${f}`); break;
        }
      }
      const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
      for (const line of graphics(packet)) {
        const vector = line.vectorV2 as { kind?: string; stack?: string; commands?: Array<{ type: string; x?: number; y?: number }>; widthPixels?: number } | undefined;
        const role = roles.get(line.id) ?? "";
        if (vector?.kind !== "stroke" || vector.stack === "under_media" || ANNOTATION.test(role)) continue;
        const ox = line.x * 1080, oy = line.y * 1920, half = (vector.widthPixels ?? 2) / 2;
        const points = (vector.commands ?? []).filter(c => c.x !== undefined).map(c => [ox + c.x!, oy + c.y!] as const);
        const start = Math.round(line.timelineStart * 30), stop = Math.round((line.timelineStart + line.duration) * 30);
        for (const box of boxes) {
          if (Math.max(start, box.start) >= Math.min(stop, box.stop)) continue;
          const hit = points.some(([x, y], k) => { if (!k) return false; const [px, py] = points[k - 1];
            for (let t = 0; t <= 1; t += .05) { const sx = px + (x - px) * t, sy = py + (y - py) * t;
              if (sx > box.left - half && sx < box.right + half && sy > box.top - half && sy < box.bottom + half) return true; }
            return false; });
          if (hit) violations.push(`${family} line ${role} crosses 「${box.graphic.text.slice(0, 8)}」(${box.role})`);
        }
      }
    }
    expect(violations).toEqual([]);
  }, 600_000);
});

// R53 product renders (2026-10-09): an opening chapter card loops without a jump and keeps its window in the media column,
// a title cascade runs in reading order, a list step hands over as one unit, and a struck claim never shares a glyph with
// the deck that takes its slot. Poses are the v2 evaluator's (easing, stagger and exit included) per glyph unit.
const FPS = 30, frameOf = (seconds: number) => Math.round(seconds * FPS);
const unitsOf = (graphic: MotionGraphic) => graphic.motionV2!.sequence.unit === "all" ? 1 : Math.max(1, [...graphic.text].filter(c => !/\s/u.test(c)).length);
function pose(graphic: MotionGraphic, frame: number, unitIndex = 0) {
  const motion = graphic.motionV2!, start = frameOf(graphic.timelineStart), duration = Math.max(1, frameOf(graphic.duration)), local = frame - start;
  if (local < 0 || local >= duration) return undefined;
  const units = unitsOf(graphic), exitStagger = motion.sequence.exitStaggerFrames ?? motion.sequence.staggerFrames;
  const exitStart = duration - motion.exit.durationFrames - Math.max(0, units - 1) * exitStagger;
  const progress = (f: number, delay: number, length: number) => f < delay ? 0 : length <= 1 ? 1 : Math.min(1, Math.max(0, (f - delay) / (length - 1)));
  const rank = (order: string) => order === "reverse" ? units - 1 - unitIndex : unitIndex;
  const enter = evaluateMotionGraphicV2Easing(progress(local, rank(motion.sequence.order) * motion.sequence.staggerFrames, motion.entrance.durationFrames), motion.entrance.easing);
  const leave = evaluateMotionGraphicV2Easing(progress(local - exitStart, rank(motion.sequence.exitOrder) * exitStagger, motion.exit.durationFrames), motion.exit.easing);
  return { dx: motion.entrance.offsetXPixels * (1 - enter) + motion.exit.offsetXPixels * leave, dy: motion.entrance.offsetYPixels * (1 - enter) + motion.exit.offsetYPixels * leave,
    opacity: Math.min(1, Math.max(0, (motion.entrance.opacity + (1 - motion.entrance.opacity) * enter) * (1 + (motion.exit.opacity - 1) * leave))) };
}
const glyphsOf = (packet: Packet, graphic: MotionGraphic) => (packet.layouts.find(row => row.graphicId === graphic.id)?.segments ?? []).filter(segment => segment.outline?.ink);
const clipOf = (graphic: MotionGraphic) => (graphic as MotionGraphic & { clipRegion?: { x: number; y: number; width: number; height: number } }).clipRegion;
/** Visible glyph ink boxes of `list` at a frame (moved by their pose, cut to their own window). */
function inkAt(packet: Packet, list: MotionGraphic[], frame: number) {
  return list.flatMap(graphic => glyphsOf(packet, graphic).flatMap(segment => {
    const p = pose(graphic, frame, segment.unitIndex), ink = segment.outline!.ink!, clip = clipOf(graphic);
    if (!p || p.opacity < .004) return [];
    const box = { left: segment.x + ink.xMin + p.dx, right: segment.x + ink.xMax + p.dx, top: segment.y + ink.yMin + p.dy, bottom: segment.y + ink.yMax + p.dy };
    const cut = clip ? { left: Math.max(box.left, clip.x * 1080), right: Math.min(box.right, (clip.x + clip.width) * 1080),
      top: Math.max(box.top, clip.y * 1920), bottom: Math.min(box.bottom, (clip.y + clip.height) * 1920) } : box;
    return cut.right > cut.left && cut.bottom > cut.top ? [cut] : [];
  }));
}
/** Everything drawn at a frame as absolute glyph and vector positions; a lead copy and the piece it stands for coincide. */
function sceneAt(packet: Packet, frame: number) {
  return graphics(packet).flatMap(graphic => {
    const look = `${graphic.text}|${graphic.textColor}|${graphic.backgroundColor}|${graphic.accentColor}|${graphic.fontSize}|${JSON.stringify(clipOf(graphic) ?? null)}`;
    if (graphic.vectorV2) {
      const p = pose(graphic, frame);
      const shape = JSON.stringify({ ...graphic.vectorV2, revealFrames: 1 }, (_key, value) => typeof value === "number" ? Math.round(value * 1000) / 1000 : value);
      return p && p.opacity > .004 ? [`${look}|${shape}|${(graphic.x * 1080 + p.dx).toFixed(1)},${(graphic.y * 1920 + p.dy).toFixed(1)}|${p.opacity.toFixed(2)}`] : [];
    }
    // A text compares by the union of its moved glyph ink (a whole-unit copy merges its glyphs into one layout segment).
    const ink = inkAt(packet, [graphic], frame), p = pose(graphic, frame);
    return ink.length && p ? [`${look}|${Math.min(...ink.map(b => b.left)).toFixed(1)},${Math.min(...ink.map(b => b.top)).toFixed(1)}-${Math.max(...ink.map(b => b.right)).toFixed(1)},${Math.max(...ink.map(b => b.bottom)).toFixed(1)}|${p.opacity.toFixed(2)}`] : [];
  }).sort();
}
const bridges = new Map<string, Promise<{ packet: Packet; current: EditProject }>>();
/** level_bridge on the real T02 geometry: a portrait source cropped to its observed subject range fills the media column. */
function bridge(theme: ReferenceMotionDesignSystem, focused: boolean) {
  const id = `${theme}:${focused}`;
  if (!bridges.has(id)) bridges.set(id, (async () => {
    if (!focused) return saved(theme, "level_bridge");
    const f = fixture(theme, "level_bridge");
    const packet = await prepareReferenceMotionTemplateInstance(f.project, { ...f.input, focusRegion: { x: 0, y: .12, width: 1, height: .68 } }, ids(), { prepareText: physicalText });
    return { packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return bridges.get(id)!;
}
describe("an opening chapter card loops and a list step or a struck claim hands over whole", () => {
  const bridgeCases = referenceMotionDesignSystems.flatMap(theme => [false, true].map(focused => [theme, focused] as const));
  it.each(bridgeCases)("%s level_bridge (column-filling window: %s) keeps its window in the media column and ends on its first frame", async (theme, focused) => {
    const { packet, current } = await bridge(theme, focused), end = FAMILIES.level_bridge.frames;
    const primary = current.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary")!, view = primary.layout!.viewport;
    const keys = [...primary.keyframes].sort((a, b) => a.time - b.time);
    for (const key of keys) {
      // The window's extent under each keyframe (scaled about its own centre): never past x 40-1040 or below y 1880.
      const scale = key.transform.scale ?? 1, cx = (view.x + view.width / 2) * 1080 + (key.transform.x ?? 0), cy = (view.y + view.height / 2) * 1920 + (key.transform.y ?? 0);
      const extent = { left: cx - scale * view.width * 540, right: cx + scale * view.width * 540, bottom: cy + scale * view.height * 960 };
      expect({ at: key.time, inside: extent.left >= 39.5 && extent.right <= 1040.5 && extent.bottom <= 1880.5 }).toEqual({ at: key.time, inside: true });
    }
    const pick = (key: (typeof keys)[number]) => ({ scale: key.transform.scale ?? 1, x: key.transform.x ?? 0, y: key.transform.y ?? 0, opacity: key.transform.opacity ?? 1 });
    expect(pick(keys.at(-1)!)).toEqual(pick(keys[0]));
    // The cut from the last frame back to frame 0 shows the same glyphs and shapes at the same places.
    expect(sceneAt(packet, end - 1)).toEqual(sceneAt(packet, 0));
  }, 60_000);

  it.each(bridgeCases)("%s level_bridge (column-filling window: %s) settles its title in reading order, complete on frame 0", async (theme, focused) => {
    const { packet } = await bridge(theme, focused), roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const pieces = graphics(packet).filter(g => /^headline:\d+$/.test(roles.get(g.id) ?? "")), leads = graphics(packet).filter(g => /^headline:\d+:lead$/.test(roles.get(g.id) ?? ""));
    expect(pieces.length).toBeGreaterThan(1); // the accent run is its own piece
    const size = pieces[0].fontSize, glyphs = pieces.flatMap(piece => glyphsOf(packet, piece).map(segment => ({ line: Math.round(segment.y / (size * .6)), x: segment.x,
      turn: frameOf(piece.timelineStart) + (piece.motionV2!.sequence.unit === "all" ? 0 : segment.unitIndex * piece.motionV2!.sequence.staggerFrames) })));
    const turns = glyphs.sort((a, b) => a.line - b.line || a.x - b.x).map(glyph => glyph.turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    // Each later piece is on screen from frame 0 as a still copy of its first pose, replaced exactly when it starts to move.
    for (const piece of pieces.filter(piece => frameOf(piece.timelineStart) > 0)) {
      const lead = leads.find(copy => copy.text === piece.text && frameOf(copy.timelineStart) === 0 && frameOf(copy.timelineStart + copy.duration) === frameOf(piece.timelineStart));
      expect(lead, piece.text).toBeDefined();
    }
    const onFirstFrame = [...pieces, ...leads].filter(graphic => inkAt(packet, [graphic], 0).length).map(graphic => graphic.text).join("");
    expect([...onFirstFrame].sort()).toEqual(pieces.flatMap(piece => [...piece.text]).sort());
  }, 60_000);

  it.each(bridgeCases)("%s level_bridge (column-filling window: %s) closes its orbit on the page beside the window, or leaves it out when the window fills the column", async (theme, focused) => {
    const { packet, current } = await bridge(theme, focused), roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const view = current.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary")!.layout!.viewport;
    const centre = (view.x + view.width / 2) * 1080, half = view.width * 540;
    const points = (graphic: MotionGraphic) => ((graphic.vectorV2 as { commands: Array<{ type: string; x?: number; y?: number }> }).commands)
      .filter(command => command.x !== undefined).map(command => ({ x: graphic.x * 1080 + command.x!, y: graphic.y * 1920 + command.y! }));
    const halves = graphics(packet).filter(g => /^orbit:(front|back)$/.test(roles.get(g.id) ?? ""));
    // A window wider than 80% of the 1000 px media column leaves no page for the ring, which would only cut across the footage.
    if (view.width * 1080 > 800) { expect(halves).toHaveLength(0); return; }
    expect(halves).toHaveLength(2);
    for (const point of halves.flatMap(points)) expect(point.x > 6 && point.x < 1074).toBe(true);
    // The front half (drawn over the footage) ends where it meets the back half: both ends on the page, clear of the window.
    const front = points(halves.find(g => roles.get(g.id) === "orbit:front")!);
    for (const end of [front[0], front.at(-1)!]) expect(Math.abs(end.x - centre) - half).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it.each(referenceMotionDesignSystems)("%s context_stack hands each step over as one unit: never two steps on one pixel, never an empty band", async theme => {
    const { packet } = await saved(theme, "context_stack"), roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const end = FAMILIES.context_stack.frames, count = FAMILIES.context_stack.input.items!.length;
    const steps = Array.from({ length: count }, (_, index) => graphics(packet).filter(g => new RegExp(`^item:${index}:(number|label|detail)$`).test(roles.get(g.id) ?? "")));
    for (const step of steps) {
      expect(step.length).toBeGreaterThanOrEqual(2);
      const unit = (g: MotionGraphic) => ({ start: frameOf(g.timelineStart), stop: frameOf(g.timelineStart + g.duration), motion: g.motionV2, clip: clipOf(g) });
      for (const graphic of step) expect(unit(graphic)).toEqual(unit(step[0])); // number, label and detail move as one block
      expect(clipOf(step[0])).toBeDefined();
    }
    const firstLanded = frameOf(steps[0][0].timelineStart) + steps[0][0].motionV2!.entrance.durationFrames;
    const restArea = steps.map(step => step.reduce((area, g) => area + glyphsOf(packet, g).reduce((sum, segment) => {
      const ink = segment.outline!.ink!; return sum + (ink.xMax - ink.xMin) * (ink.yMax - ink.yMin); }, 0), 0));
    let thin = 0;
    for (let frame = 0; frame < end; frame++) {
      const inks = steps.map(step => inkAt(packet, step, frame));
      for (let index = 0; index + 1 < count; index++) for (const a of inks[index]) for (const b of inks[index + 1])
        expect(meets(a, b, 0), `steps ${index + 1}/${index + 2} overlap @${frame}`).toBe(false);
      if (frame < firstLanded) continue;
      // The band always shows most of a step (the outgoing one's tail and the incoming one's head add up during a roll).
      const shown = inks.reduce((sum, list, index) => sum + list.reduce((area, box) => area + (box.right - box.left) * (box.bottom - box.top), 0) / restArea[index], 0);
      thin = shown < .4 ? thin + 1 : 0;
      expect(thin, `band nearly empty for ${thin} frames @${frame}`).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it.each(referenceMotionDesignSystems)("%s strike_reframe never shows the struck claim and the deck that replaces it on the same pixels", async theme => {
    const { packet } = await saved(theme, "strike_reframe"), roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const claim = graphics(packet).filter(g => /^previous(:hook)?$/.test(roles.get(g.id) ?? "")), deck = graphics(packet).filter(g => /^subtitle(:\d+)?$/.test(roles.get(g.id) ?? ""));
    expect(claim.length).toBeGreaterThan(0); expect(deck.length).toBeGreaterThan(0);
    for (let frame = 0; frame < FAMILIES.strike_reframe.frames; frame++) {
      const before = inkAt(packet, claim, frame), after = inkAt(packet, deck, frame);
      for (const a of before) for (const b of after) expect(meets(a, b, 0), `claim × deck @${frame}`).toBe(false);
    }
  }, 60_000);
});

describe("genre design themes over every family", () => {
  const cases = referenceMotionDesignSystems.flatMap(theme => (Object.keys(FAMILIES) as Family[]).map(family => [theme, family] as const));
  it.each(cases)("%s compiles %s into a valid, saved, editable scene with real footage blocks", async (theme, family) => {
    const { packet, current } = await saved(theme, family);
    expect(packet.instance.input.designSystem).toBe(theme);
    expect(packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/design-v1:[0-9a-f]{64}$/);
    expect(parseProject(current)).toBeTruthy();
    // Every graphic sits inside the canvas; footage blocks (other than the abstract network) are laid out windows.
    for (const graphic of graphics(packet)) expect(graphic.x >= 0 && graphic.x <= 1 && graphic.width > 0 && graphic.width <= 1).toBe(true);
    if (!["kinetic_network", "stat_reveal", "statement_cut", ...SCENE_FAMILY_IDS].includes(family)) expect(current.tracks.flatMap(track => track.clips).some(clip => clip.layout)).toBe(true);
    // Physical glyphs everywhere: no estimated text layouts.
    expect(packet.layouts.filter(layout => graphics(packet).find(g => g.id === layout.graphicId)?.text).every(layout => layout.physicalFont)).toBe(true);
  }, 60_000);

  it("gives each theme its own recipe identity, defaults and typography", async () => {
    const versions = await Promise.all(referenceMotionDesignSystems.map(async theme => (await saved(theme, "strike_reframe")).packet.instance.dependencies.recipeVersion));
    expect(new Set(versions).size).toBe(referenceMotionDesignSystems.length);
    const trip = await saved("trip_pop_v1", "strike_reframe");
    expect(trip.packet.instance.input.style).toEqual(REFERENCE_MOTION_DESIGN_THEMES.trip_pop_v1.defaultStyle);
    expect(graphics(trip.packet).find(g => g.text === "來看蝙蝠")?.fontFamily).toBe("LXGW WenKai TC");
    const swiss = await saved("swiss_blue_v1", "strike_reframe");
    expect(graphics(swiss.packet).find(g => g.text === "來看蝙蝠")?.fontFamily).toBe("Noto Sans TC");
  }, 60_000);

  it.each(referenceMotionDesignSystems)("%s takes every colour from the editable palette", async theme => {
    const base = REFERENCE_MOTION_DESIGN_THEMES[theme].defaultStyle;
    const custom = { ...base, palette: { ...base.palette, accent: "#C2185B", separator: theme === "swiss_blue_v1" ? base.palette.separator : "#2E7D32" } };
    const [standard, recoloured] = await Promise.all([saved(theme, "comparison_pair"), saved(theme, "comparison_pair", { style: custom }, "custom")]);
    const before = new Set(graphics(standard.packet).flatMap(colours)), after = new Set(graphics(recoloured.packet).flatMap(colours));
    expect(before.has(base.palette.accent.toUpperCase())).toBe(true);
    expect(after.has(base.palette.accent.toUpperCase())).toBe(false);
    expect([...after].some(value => value === "#C2185B" || value === designThemeColors(custom.palette).accentInk.toUpperCase())).toBe(true);
  }, 60_000);

  it("darkens a light accent for words on a light page and keeps a readable on-accent ink", () => {
    const colours = designThemeColors({ surface: "#FFF4E6", text: "#2B2622", accent: "#FFD23F", muted: "#857A70", separator: "#FF6B6B" });
    const luminance = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    expect(ratio(colours.accentInk, "#FFF4E6")).toBeGreaterThanOrEqual(3);
    expect(colours.onAccent).toBe("#2B2622");
  }, 60_000);

  it("revises the palette and copy of a saved theme instance", async () => {
    const { current, packet } = await saved("trip_pop_v1", "strike_reframe");
    const revision = await prepareReferenceMotionTemplateRevision(current, packet.instance.id,
      { style: { palette: { accent: "#7E57C2" } }, title: "其實是來看瀑布", tag: null },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    const next = revision.instance.input;
    expect(next.style?.palette.accent).toBe("#7E57C2");
    expect(next.accentText).toBeUndefined(); // the old accent word no longer occurs in the replaced title
    expect(next.tag).toBeUndefined();
    expect(next.designSystem).toBe("trip_pop_v1");
  }, 60_000);

  it("strikes over the glyphs and mats polaroids under the footage", async () => {
    const trip = await saved("trip_pop_v1", "strike_reframe"), list = graphics(trip.packet);
    const strike = list.find(g => g.vectorV2?.kind === "shape" && g.name.includes("previous") === false && g.vectorV2.stack === "over_text");
    expect(strike).toBeDefined();
    const mats = list.filter(g => g.vectorV2?.kind === "shape" && g.vectorV2.stack === "under_media");
    expect(mats.length).toBeGreaterThan(0);
    expect(mats.every(g => g.compositeLayer === "background")).toBe(true);
    const foreground = writeAssContent(trip.current, trip.current.captionStyle, { compositeLayer: "foreground" });
    expect(foreground).toMatch(/Dialogue: 3,/); // the scribble paints over the claim
    const background = writeAssContent(trip.current, trip.current.captionStyle, { compositeLayer: "background" });
    expect(background).toMatch(/Dialogue: 1,/);
  }, 60_000);

  it("rejects a background shape without the under_media marker and a stacked shape in the wrong layer", async () => {
    const { current, packet } = await saved("trip_pop_v1", "strike_reframe");
    const mat = graphics(packet).find(g => g.vectorV2?.kind === "shape" && g.vectorV2.stack === "under_media")!;
    const strip = structuredClone(current);
    const target = strip.motionGraphics.find(g => g.id === mat.id)!;
    delete (target.vectorV2 as { stack?: string }).stack;
    expect(() => parseProject(strip)).toThrow();
    const swap = structuredClone(current);
    swap.motionGraphics.find(g => g.id === mat.id)!.compositeLayer = "foreground";
    expect(() => parseProject(swap)).toThrow();
  }, 60_000);

  it("refuses a landscape canvas instead of squeezing the portrait grid", async () => {
    const f = fixture("swiss_blue_v1", "level_bridge", { landscape: true, aspect: 16 / 9 });
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, intent: "standalone_showcase" }, ids(), { prepareText: physicalText }))
      .rejects.toThrow(/直式 9:16/);
  }, 60_000);

  it.each(["swiss_blue_v1", "trip_pop_v1"] as const)("%s lays landscape footage across the footage column with the support line in the reading slot", async theme => {
    const { packet } = await saved(theme, "strike_reframe", { aspect: 16 / 9 }, "wide");
    const window = packet.mediaBindings[0].layout.viewport;
    expect(window.width).toBeGreaterThan(.85);
    // Shorts v2: the support line takes the struck claim's slot above the answer once the claim has been read.
    const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const subtitle = graphics(packet).find(g => roles.get(g.id) === "subtitle")!, claim = graphics(packet).find(g => g.text === "來看蝙蝠")!;
    expect(subtitle.text.startsWith("名字叫蝙蝠洞")).toBe(true);
    expect(subtitle.y).toBeLessThan(window.y);
    // It arrives during the struck line's exit at most (a four-frame handoff), never on top of the settled claim.
    expect(subtitle.timelineStart).toBeGreaterThanOrEqual(claim.timelineStart + claim.duration - claim.motionV2!.exit.durationFrames / 30);
  }, 60_000);

  it.each(["strike_reframe", "level_bridge", "context_stack"] as const)("crops a portrait source in %s to its observed subject range so the window fills the width", async family => {
    const f = fixture("trip_pop_v1", family), focusRegion = { x: 0, y: .25, width: 1, height: .5 };
    const [whole, cropped] = await Promise.all([saved("trip_pop_v1", family),
      prepareReferenceMotionTemplateInstance(f.project, { ...f.input, focusRegion }, ids(), { prepareText: physicalText })]);
    const before = whole.packet.mediaBindings[0].layout.viewport, after = cropped.mediaBindings[0].layout.viewport;
    expect(after.width).toBeGreaterThan(before.width * 1.2);
    expect(after.width * after.height).toBeGreaterThanOrEqual(before.width * before.height);
    expect(after.width).toBeGreaterThan(.6);
    expect(cropped.mediaBindings[0].role).toContain("已觀察主體範圍");
  }, 60_000);

  it("fits a long claim on one line instead of stranding a character on a second line", async () => {
    const f = fixture("swiss_blue_v1", "strike_reframe");
    const packet = await prepareReferenceMotionTemplateInstance(f.project, { ...f.input, previousText: "做材質要寫程式" }, ids(), { prepareText: physicalText });
    const claim = graphics(packet).find(g => g.text === "做材質要寫程式")!;
    const layout = packet.layouts.find(row => row.graphicId === claim.id)!;
    expect(new Set(layout.segments.map(segment => Math.round(segment.y))).size).toBe(1);
    expect(claim.fontSize).toBeLessThan(148);
    expect(claim.fontSize).toBeGreaterThanOrEqual(148 * .78);
  }, 60_000);

  it("frames landscape chapter footage in a wide window and wall footage in one column", async () => {
    const level = await saved("swiss_blue_v1", "level_bridge", { aspect: 16 / 9 }, "wide");
    const window = level.packet.mediaBindings[0].layout.viewport;
    expect(window.width).toBeGreaterThan(.8);
    expect(level.current.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary")!.masks![0].name).toBe("影片窗柔和圓角");
    const wall = await saved("trip_pop_v1", "focus_wall", { aspect: 16 / 9 }, "wide");
    const cells = wall.packet.mediaBindings.filter(binding => !binding.role.includes("連續前景")).map(binding => binding.layout.viewport);
    expect(new Set(cells.map(cell => cell.x.toFixed(3))).size).toBe(1);
    expect(cells[0].width).toBeGreaterThan(.45);
  }, 60_000);

  it("sets two-tone titles on the whole title's glyph positions, line by line and centred", async () => {
    const { packet } = await saved("swiss_blue_v1", "level_bridge");
    // (A ":lead" copy only holds a later run's first pose on the opening frames; the placed pieces are the run graphics.)
    const roles = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const pieces = graphics(packet).filter(g => (g.text === "烏嘎彥" || g.text === "竹林") && !roles.get(g.id)?.endsWith(":lead"));
    expect(pieces).toHaveLength(2);
    const ink = (graphic: MotionGraphic) => { const layout = packet.layouts.find(row => row.graphicId === graphic.id)!;
      return layout.segments.map(segment => segment.x + segment.outline!.ink!.xMin); };
    const [first, second] = pieces.map(ink);
    // The accent run continues the line: its first glyph starts to the right of the base run's last glyph.
    expect(second[0]).toBeGreaterThan(first.at(-1)!);
    // Centred: the line's ink is balanced about the canvas centre within a glyph's advance.
    const left = first[0], layout = packet.layouts.find(row => row.graphicId === pieces[1].id)!;
    const right = Math.max(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMax));
    expect(Math.abs((left + right) / 2 - 540)).toBeLessThan(40);
  }, 60_000);
});
