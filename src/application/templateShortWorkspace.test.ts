import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateShortBlockError } from "./templateShortBrief";
import { TEMPLATE_SHORT_DEFAULTS_PATH, readTemplateShortDefaults, readTemplateShortFactSources, resolveTemplateShortSourceRights,
  templateShortDefaultsSchema, type TemplateShortDefaults } from "./templateShortWorkspace";

// Fixtures only: the creator's real defaults file is never written by Editkin or by these tests.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace(defaults?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "editkin-template-short-workspace-")); roots.push(root);
  if (defaults !== undefined) {
    await mkdir(join(root, ".autopilot"));
    await writeFile(join(root, TEMPLATE_SHORT_DEFAULTS_PATH), typeof defaults === "string" ? defaults : JSON.stringify(defaults));
  }
  return root;
}
const OWN = { provenance: "創作者本人拍攝的原始素材", rightsBasis: "創作者本人擁有完整著作權", distributionScope: "創作者自有頻道與作品集", license: "creator-owned" };
const DEFAULTS = { schema: "editkin.template-short-defaults/v1", rights: [{ scope: "videos", declaration: OWN }],
  excludedSources: ["IMG_6172", "IMG_6173"], brandMark: "Hao0321 Studio", confirmedBy: "creator", confirmedAt: "2026-10-09T15:00:00+08:00" };
const blocked = async (run: () => Promise<unknown> | unknown) => {
  try { await run(); } catch (error) { if (error instanceof TemplateShortBlockError) return error; throw error; }
  throw new Error("expected a TemplateShortBlockError");
};

describe("template short workspace defaults (one-time rights and brand)", () => {
  it("blocks start once with the file and every field named when the creator has not written it", async () => {
    const root = await workspace();
    const error = await blocked(() => readTemplateShortDefaults(root));
    expect(error.code).toBe("BLOCK_START");
    for (const name of [TEMPLATE_SHORT_DEFAULTS_PATH, "rights", "provenance", "rightsBasis", "distributionScope", "license", "excludedSources", "brandMark", "confirmedBy", "confirmedAt"]) {
      expect(error.detail).toContain(name);
    }
  });

  it("reads a creator-confirmed file with a stable identity", async () => {
    const root = await workspace(DEFAULTS);
    const first = await readTemplateShortDefaults(root), second = await readTemplateShortDefaults(root);
    expect(first.defaults).toEqual(DEFAULTS);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
  });

  it.each([
    [{ ...DEFAULTS, rights: [{ scope: "videos", declaration: { provenance: OWN.provenance } }] }, "rights.0.declaration"],
    [{ ...DEFAULTS, rights: [{ scope: "D:\\Creator\\videos", declaration: OWN }] }, "rights.0.scope"],
    [{ ...DEFAULTS, rights: [{ scope: "../videos", declaration: OWN }] }, "rights.0.scope"],
    [{ ...DEFAULTS, rights: [{ scope: "videos", declaration: OWN }, { scope: "Videos/", declaration: OWN }] }, "rights"],
    [{ ...DEFAULTS, rights: [] }, "rights"],
    [{ ...DEFAULTS, brandMark: "Hao0321 Studio 剪輯室" }, "brandMark"],
    [{ ...DEFAULTS, confirmedBy: "agent" }, "confirmedBy"],
    [{ ...DEFAULTS, excludedSources: ["videos/IMG_6172"] }, "excludedSources"],
    [{ ...DEFAULTS, extra: true }, "內容"],
  ])("rejects an incomplete or unsafe declaration %#", async (defaults, where) => {
    const error = await blocked(async () => readTemplateShortDefaults(await workspace(defaults)));
    expect(error.code).toBe("BLOCK_START");
    expect(error.detail).toContain(where);
  });

  it("rejects malformed JSON and a non-directory .autopilot", async () => {
    expect((await blocked(async () => readTemplateShortDefaults(await workspace("{")))).detail).toContain("UTF-8 JSON");
    const root = await workspace();
    await writeFile(join(root, ".autopilot"), "not a directory");
    expect((await blocked(() => readTemplateShortDefaults(root))).code).toBe("BLOCK_START");
  });
});

describe("template short source rights", () => {
  const defaults: TemplateShortDefaults = templateShortDefaultsSchema.parse(DEFAULTS);
  it("applies the owned-scope declaration to footage under it", () => {
    expect(resolveTemplateShortSourceRights(defaults, "videos/_INBOX/直式-vertical-Shorts-Reels/6/IMG_4022.MOV")).toEqual({ scope: "videos", declaration: OWN });
    expect(resolveTemplateShortSourceRights(defaults, "videos\\_INBOX\\IMG_4022.MOV").declaration).toEqual(OWN);
  });

  it("requires an explicit declaration outside the owned scope, and the most specific scope wins", async () => {
    const error = await blocked(() => resolveTemplateShortSourceRights(defaults, "downloads/clip.mp4"));
    expect(error).toMatchObject({ code: "BLOCK_START", field: "source.path" });
    expect(error.detail).toContain("明確宣告");
    const licensed = { provenance: "朋友提供的素材", rightsBasis: "書面授權", distributionScope: "僅本頻道", license: "written-permission" };
    const explicit = templateShortDefaultsSchema.parse({ ...DEFAULTS, rights: [...DEFAULTS.rights, { scope: "downloads/clip.mp4", declaration: licensed },
      { scope: "videos/friends", declaration: licensed }] });
    expect(resolveTemplateShortSourceRights(explicit, "downloads/clip.mp4")).toEqual({ scope: "downloads/clip.mp4", declaration: licensed });
    expect(resolveTemplateShortSourceRights(explicit, "videos/friends/a.mov").scope).toBe("videos/friends");
    expect(resolveTemplateShortSourceRights(explicit, "videos/friendship/a.mov").scope).toBe("videos");
  });

  it("never uses an excluded source, even inside the owned scope", async () => {
    for (const path of ["videos/_INBOX/Shorts9/IMG_6172.MOV", "videos/x/img_6173.mov", "videos/x/IMG_6172-proxy.mp4", "videos/x/IMG_6173 (1).MOV"]) {
      const error = await blocked(() => resolveTemplateShortSourceRights(defaults, path));
      expect(error.code).toBe("BLOCK_START");
      expect(error.detail).toContain("永遠不使用");
    }
    expect(resolveTemplateShortSourceRights(defaults, "videos/x/IMG_61720.MOV").scope).toBe("videos");
  });

  it("matches scope case-insensitively only where the file system does", async () => {
    expect(resolveTemplateShortSourceRights(defaults, "Videos/a.mov", { caseInsensitive: true }).scope).toBe("videos");
    expect((await blocked(() => resolveTemplateShortSourceRights(defaults, "Videos/a.mov", { caseInsensitive: false }))).code).toBe("BLOCK_START");
    expect((await blocked(() => resolveTemplateShortSourceRights(defaults, "../videos/a.mov"))).detail).toBe("請先把素材放進工作資料夾");
    expect((await blocked(() => resolveTemplateShortSourceRights(defaults, "D:/videos/a.mov"))).detail).toBe("請先把素材放進工作資料夾");
  });
});

describe("template short creator fact files (M10)", () => {
  it("reads bounded UTF-8 creator files inside the workspace", async () => {
    const root = await workspace();
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "價目.md"), "## 06 三民蝙蝠洞\n門票 50 元\n");
    expect(await readTemplateShortFactSources(root, [{ ref: "creator:notes/價目.md#06-三民蝙蝠洞" }]))
      .toEqual([{ ref: "creator:notes/價目.md#06-三民蝙蝠洞", content: "## 06 三民蝙蝠洞\n門票 50 元\n" }]);
  });

  it("blocks a missing, oversized, binary or escaping fact file and names the entry", async () => {
    const root = await workspace();
    await writeFile(join(root, "big.md"), "5".repeat(64 * 1024 + 1));
    await writeFile(join(root, "binary.md"), Buffer.from([0xff, 0xfe, 0x00]));
    for (const [ref, index] of [["creator:missing.md#a", 0], ["creator:big.md#a", 0], ["creator:binary.md#a", 0], ["creator:../outside.md#a", 0]] as const) {
      const error = await blocked(() => readTemplateShortFactSources(root, [{ ref }]));
      expect(error).toMatchObject({ code: "BLOCK_BRIEF", field: `facts[${index}].ref` });
    }
  });
});
