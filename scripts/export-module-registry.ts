/**
 * Exports the module registry (editkin.module/v1) and composition templates
 * (editkin.template/v1) as data for the video-autopilot skill, so the agent
 * can pick modules, variants and template slots offline and its helper can
 * validate fills before any MCP call. TypeScript stays the single source of
 * truth; the skill never edits this JSON.
 *
 *   vendor/node/win32-x64/node.exe node_modules/tsx/dist/cli.mjs scripts/export-module-registry.ts [--check] <outPath>
 *
 * Without <outPath>, EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT selects
 * <root>/references/editkin-modules-v1.json; with neither, nothing is written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOPILOT_MAX_COMMANDS } from "../src/application/autopilotPlan";
import { MOTION_TREATMENT_FAMILIES } from "../src/application/motionTreatment";
import { editkinModuleRegistry } from "../src/modules/moduleRegistry";
import { editkinTemplateRegistry } from "../src/modules/templateRegistry";

export const MODULE_REGISTRY_EXPORT_SCHEMA = "editkin.module-registry-export/v1";

export function moduleRegistryExport() {
  const modules = editkinModuleRegistry(), templates = editkinTemplateRegistry();
  return {
    schema: MODULE_REGISTRY_EXPORT_SCHEMA,
    generator: "scripts/export-module-registry.ts",
    moduleRegistry: modules.identity,
    templateRegistry: templates.identity,
    tools: { listModules: "list_editkin_modules", prepareModule: "prepare_editkin_module", listTemplates: "list_editkin_templates", prepareTemplate: "prepare_editkin_template",
      batch: "scripts/mcp-batch.ts --calls calls.json (captures each result to <id>.result.raw.json)" },
    v4: { commandCap: AUTOPILOT_MAX_COMMANDS, editorialGraphicsCap: 64, motionTreatmentFamilies: MOTION_TREATMENT_FAMILIES,
      planFields: { commands: "commands", referenceMotion: "referenceMotion", graphics: "editorial.graphics", motionTreatment: "editorial.motionTreatment", beats: "editorial.narrative.beats" },
      designEvidence: "Design decisions bind flat visible commands only — never wrap module commands in a batch." },
    modules: modules.manifests.map(manifest => ({
      id: manifest.id, kind: manifest.kind, name: manifest.name, status: manifest.status, invoke: manifest.invoke.tool, layer: manifest.layer,
      formats: manifest.formats, roles: manifest.roles, variantField: manifest.variantField ?? null,
      variants: manifest.variants.map(({ id, name, roles, formats, intensity, use }) => ({ id, name, ...(roles ? { roles } : {}), ...(formats ? { formats } : {}),
        ...(intensity ? { intensity } : {}), ...(use ? { use } : {}) })),
      output: manifest.output, requires: manifest.requires, autopilot: manifest.autopilot, legacyTools: manifest.legacy.tools,
    })),
    templates: templates.templates.map(template => ({ ...template, sha256: templates.get(template.id)!.sha256 })),
  };
}

if (process.argv[1] && /export-module-registry\.ts$/.test(process.argv[1])) {
  const check = process.argv.includes("--check");
  // The skill lives outside this repository; never assume a home-directory default such as ~/.codex.
  const skillRoot = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT;
  const out = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? (skillRoot ? join(skillRoot, "references", "editkin-modules-v1.json") : "");
  if (!out) { console.error("請指定輸出路徑參數，或設定 EDITKIN_VIDEO_AUTOPILOT_SKILL_ROOT（video-autopilot Skill 根目錄）；未指定時不寫入任何檔案"); process.exit(1); }
  const text = `${JSON.stringify(moduleRegistryExport(), null, 1)}\n`;
  if (check) {
    let current = "";
    try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== text) { console.error(`Editkin module registry export is stale: ${out}`); process.exit(1); }
    console.log(JSON.stringify({ ok: true, out }));
  } else {
    writeFileSync(out, text, "utf8");
    console.log(JSON.stringify({ wrote: out, bytes: Buffer.byteLength(text) }));
  }
}
