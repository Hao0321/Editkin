/**
 * Exports Motion Language v1 (src/motion/motionLanguage.ts) as data for the
 * video-autopilot skill. TypeScript stays the single source of truth: the skill
 * reads this JSON and only scales pixel fields by its frame unit.
 *
 *   vendor/node/win32-x64/node.exe node_modules/tsx/dist/cli.mjs scripts/export-motion-language.ts [--check] <outPath>
 *
 * Without <outPath>, EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT selects
 * <root>/references/motion-language-v1.json; with neither, nothing is written.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KINETIC_MOTION_PRESETS } from "../src/creative/kineticMotionPresets";
import { ORIGINAL_ELEMENTS, ORIGINAL_ELEMENT_THEMES } from "../src/creative/originalElements";
import {
  CLIP_MOTION_RECIPES, CLIP_MOTION_RECIPE_SPECS, KINETIC_MAX_ENTRANCE_TAIL_SECONDS, KINETIC_MAX_EXIT_TAIL_SECONDS, KINETIC_TEXT_STYLES,
  KINETIC_TEXT_STYLE_SPECS, MOTION_CURVES, MOTION_ENERGIES, MOTION_ENERGY_PROFILES, MOTION_LANGUAGE_VERSION, kineticTextMotion,
} from "../src/motion/motionLanguage";

export const MOTION_LANGUAGE_EXPORT_FPS = [24, 25, 30, 50, 60] as const;

export function motionLanguageExport() {
  const table = (effects: boolean) => Object.fromEntries(MOTION_LANGUAGE_EXPORT_FPS.map(fps => [String(fps), Object.fromEntries(MOTION_ENERGIES.map(energy => [energy,
    Object.fromEntries(KINETIC_TEXT_STYLES.map(style => [style, kineticTextMotion(style, { fps, unit: 1, energy, effects })]))]))]));
  const source = readFileSync(resolve("src/motion/motionLanguage.ts"));
  return {
    schema: MOTION_LANGUAGE_VERSION,
    generator: "scripts/export-motion-language.ts",
    sourceSha256: createHash("sha256").update(source.toString("utf8").replace(/\r\n/g, "\n")).digest("hex"),
    reference: { unit: "min(projectWidth, projectHeight) / 1080", pixelFields: ["offsetXPixels", "offsetYPixels", "blurPixels", "spreadPixels"],
      staggerTailSeconds: { entrance: KINETIC_MAX_ENTRANCE_TAIL_SECONDS, exit: KINETIC_MAX_EXIT_TAIL_SECONDS },
      nativePaint: "nativePaintMotions strip rotation/blur; native paint renders the four-field pose only" },
    energies: MOTION_ENERGIES, energyProfiles: MOTION_ENERGY_PROFILES, curves: MOTION_CURVES,
    styles: Object.fromEntries(KINETIC_TEXT_STYLES.map(style => [style, { label: KINETIC_TEXT_STYLE_SPECS[style].label, use: KINETIC_TEXT_STYLE_SPECS[style].use, unit: KINETIC_TEXT_STYLE_SPECS[style].unit }])),
    motions: table(true),
    nativePaintMotions: table(false),
    clipRecipes: Object.fromEntries(CLIP_MOTION_RECIPES.map(recipe => [recipe, CLIP_MOTION_RECIPE_SPECS[recipe]])),
    presets: KINETIC_MOTION_PRESETS.map(preset => ({ id: preset.id, name: preset.name, roles: preset.routing?.semanticRoles ?? [], intensity: preset.routing?.intensity })),
    originalElements: { tool: "prepare_original_element", collection: "Collection 01 (Hao preferred 2026-10-03)", themes: Object.keys(ORIGINAL_ELEMENT_THEMES),
      choreography: "Staged beats, not simultaneous (Hao 2026-10-05): ground (paper fade, grid lines drawn one by one, then a slow float) -> container (plate wipes behind an accent lead or lands, hard shadow slides out from behind) -> headline per character, line by line -> tag swipe, detail focus -> accents in sequence (sparks, dots, perforations, step connectors). Studio finish (Hao 2026-10-06, default on): glints, impact bursts, flashes, rings, typing dots, tape, rulers, barcodes, scan lines, progress rail with packets, check marks; one-shot fx-* layers end before the exit, lasting layers exit together. The tool returns timeline.buildSeconds / holdAfterBuildSeconds; size the slot as build + reading hold, short slots only compress beat times and drop effects that no longer fit.",
      elements: ORIGINAL_ELEMENTS.map(({ id, name, use, intent, maxTitle }) => ({ id, name, use, intent, maxTitle })) },
    graphicKit: { tool: "prepare_motion_graphic_kit", components: ["board", "kicker", "headline", "body", "bubble", "chip", "card", "ripple"] },
  };
}

if (process.argv[1] && /export-motion-language\.ts$/.test(process.argv[1])) {
  const check = process.argv.includes("--check");
  // The skill lives outside this repository; never assume a home-directory default such as ~/.codex.
  const skillRoot = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT;
  const out = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? (skillRoot ? join(skillRoot, "references", "motion-language-v1.json") : "");
  if (!out) { console.error("請指定輸出路徑參數，或設定 EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT（video-autopilot Skill 根目錄）；未指定時不寫入任何檔案"); process.exit(1); }
  const text = `${JSON.stringify(motionLanguageExport(), null, 1)}\n`;
  if (check) {
    const current = readFileSync(out, "utf8");
    if (current !== text) { console.error(`Motion Language export is stale: ${out}`); process.exit(1); }
    console.log(JSON.stringify({ ok: true, out }));
  } else {
    writeFileSync(out, text, "utf8");
    console.log(JSON.stringify({ wrote: out, bytes: Buffer.byteLength(text) }));
  }
}
