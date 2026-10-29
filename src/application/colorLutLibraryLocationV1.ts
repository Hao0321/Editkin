import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
/** Personal visual root is shared by the native host and the managed MCP launcher. */
export function colorLutLibraryLocationV1(cwd: string, environment: { EDITKIN_COLOR_LUT_ROOT?: string; EDITKIN_PERSONAL_VISUAL_ROOT?: string }) {
  const explicit = environment.EDITKIN_COLOR_LUT_ROOT;
  if (explicit) {
    if (!isAbsolute(explicit) || /^[\\/]{2}/.test(explicit)) throw new Error("LUT 素材庫請使用本機絕對路徑。");
    return resolve(explicit);
  }
  const legacy = resolve(cwd, ".personal-packs/hao-color-luts"), visual = environment.EDITKIN_PERSONAL_VISUAL_ROOT;
  const profile = visual ? join(dirname(resolve(cwd, visual)), "hao-color-luts") : legacy;
  if (profile !== legacy && existsSync(join(legacy, "editkin-color-luts.json"))) throw new Error("找到舊 LUT 素材庫，請先明確指定素材庫位置；原資料保持不變。");
  return profile;
}
