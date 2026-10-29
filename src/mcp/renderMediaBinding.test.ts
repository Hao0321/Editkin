// Security follow-up to 16b3a10 (check-use mismatch): an MCP render must read exactly the outside file the grant check
// resolved, fail on a missing outside file, and leave workspace-only projects exactly as they were.
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MediaAsset } from "../domain/types";

const rendered = vi.hoisted(() => ({ projects: [] as EditProject[] }));
vi.mock("../application/exportVideo", () => ({ exportVideo: vi.fn(async (request: { project: EditProject; outputPath: string }) => {
  rendered.projects.push(structuredClone(request.project));
  return { outputPath: request.outputPath, duration: 1, encoder: "libx264", planner: "test", ffmpegVersion: "test" };
}) }));
import { bindProjectMediaForRender } from "./renderMediaBinding";
import { renderAutopilotProject } from "./renderTools";

const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_APP_DATA_ROOT", "EDITKIN_EXTRA_MEDIA_ROOTS", "EDITKIN_GPU_COMPOSITOR_PATH", "EDITKIN_CACHE_ROOT"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const temp = useTempRoots();
let workspace = "", extra = "", elsewhere = "", cache = "";

beforeAll(async () => {
  const root = await temp.create("w24-render-media-");
  workspace = join(root, "ws"); extra = join(root, "extra"); elsewhere = join(root, "elsewhere"); cache = join(root, "cache");
  await mkdir(join(cache, "derivatives", "real"), { recursive: true });
  await writeFile(join(cache, "derivatives", "real", "proxy.mp4"), "cached proxy");
  await Promise.all([mkdir(join(workspace, "media"), { recursive: true }), mkdir(join(extra, "real"), { recursive: true }), mkdir(elsewhere, { recursive: true })]);
  await writeFile(join(workspace, "media", "inside.mp4"), "workspace clip");
  await writeFile(join(extra, "real", "clip.mp4"), "the checked clip");
  await writeFile(join(elsewhere, "clip.mp4"), "a different file");
  process.env.EDITKIN_WORKSPACE = workspace;
  process.env.EDITKIN_APP_DATA_ROOT = join(root, "appdata");
  process.env.EDITKIN_EXTRA_MEDIA_ROOTS = [extra].join(delimiter);
  delete process.env.EDITKIN_GPU_COMPOSITOR_PATH;
  process.env.EDITKIN_CACHE_ROOT = cache;
});
afterAll(() => {
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

function projectWith(assets: Array<Pick<MediaAsset, "id" | "uri">>): EditProject {
  const project = createEmptyProject("render media binding", { id: "render-media-binding", width: 320, height: 180, fps: 30 });
  return { ...project, assets: assets.map(asset => ({ ...asset, name: "clip.mp4", kind: "video" as const, duration: 1 })) };
}

describe("MCP render reads exactly the media it checked", () => {
  it("leaves a workspace-only project untouched (the same object, so the render input is byte-identical)", async () => {
    const project = projectWith([{ id: "inside", uri: join(workspace, "media", "inside.mp4") }, { id: "relative", uri: "media/inside.mp4" },
      { id: "pack", uri: "creative://pack/asset" }]);
    const before = JSON.stringify(project);
    expect(await bindProjectMediaForRender(project)).toBe(project);
    expect(JSON.stringify(project)).toBe(before);
  });

  it("replaces an outside asset's URI with the canonical path the grant check resolved, so a later link swap is not followed", async () => {
    const link = join(extra, "link");
    await symlink(join(extra, "real"), link, "junction");
    try {
      const project = projectWith([{ id: "inside", uri: join(workspace, "media", "inside.mp4") }, { id: "outside", uri: join(link, "clip.mp4") }]);
      const bound = await bindProjectMediaForRender(project);
      const canonical = await realpath(join(extra, "real", "clip.mp4"));
      expect(bound.assets.map(asset => asset.uri)).toEqual([join(workspace, "media", "inside.mp4"), canonical]);
      expect(project.assets[1].uri).toBe(join(link, "clip.mp4"));
      // Swap the junction after the check: the project's own path now leads elsewhere, the bound one does not.
      await rm(link, { recursive: false, force: true }).catch(async () => (await import("node:fs/promises")).rmdir(link));
      await symlink(elsewhere, link, "junction");
      expect(await realpath(join(link, "clip.mp4"))).not.toBe(canonical);
      expect(bound.assets[1].uri).toBe(canonical);
    } finally { await (await import("node:fs/promises")).rmdir(link).catch(() => undefined); }
  });

  it("fails on a missing outside asset instead of skipping it, and on an ungranted one", async () => {
    await expect(bindProjectMediaForRender(projectWith([{ id: "gone", uri: join(extra, "real", "not-here.mp4") }])))
      .rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(missing\)/);
    await expect(bindProjectMediaForRender(projectWith([{ id: "elsewhere", uri: join(elsewhere, "clip.mp4") }])))
      .rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
  });

  it("renderAutopilotProject (sync, async job and original-motion route) hands the renderer the bound canonical project", async () => {
    const link = join(extra, "render-link");
    await symlink(join(extra, "real"), link, "junction");
    const project = projectWith([{ id: "outside", uri: join(link, "clip.mp4") }]);
    rendered.projects.length = 0;
    try { await renderAutopilotProject("unused.editkin.json", "out/bound.mp4", false, project); }
    finally { await (await import("node:fs/promises")).rmdir(link).catch(() => undefined); }
    expect(rendered.projects).toHaveLength(1);
    // Before this fix the renderer received the project's own (link) path after the check had resolved it.
    expect(rendered.projects[0].assets[0].uri).toBe(await realpath(join(extra, "real", "clip.mp4")));
    expect(rendered.projects[0].assets[0].uri).not.toBe(join(link, "clip.mp4"));
    rendered.projects.length = 0;
    await expect(renderAutopilotProject("unused.editkin.json", "out/bound.mp4", false, projectWith([{ id: "gone", uri: join(extra, "real", "gone.mp4") }])))
      .rejects.toThrow(/OUTSIDE_MEDIA_NOT_GRANTED \(missing\)/);
    expect(rendered.projects).toHaveLength(0);
    const workspaceOnly = projectWith([{ id: "inside", uri: join(workspace, "media", "inside.mp4") }]);
    await renderAutopilotProject("unused.editkin.json", "out/bound.mp4", false, workspaceOnly);
    expect(JSON.stringify(rendered.projects[0].assets)).toBe(JSON.stringify(workspaceOnly.assets));
  });
});

describe("preview derivatives and Auto Roto mattes follow the same rule (media cache, workspace or granted)", () => {
  const withDerivatives = (derivatives: Record<string, string>) => ({ ...projectWith([{ id: "inside", uri: join(workspace, "media", "inside.mp4") }])[`assets`][0],
    derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-23T00:00:00.000Z", ...derivatives } });
  const projectWithAsset = (asset: MediaAsset): EditProject => ({ ...projectWith([]), assets: [asset] });
  function projectWithMatte(paths: { sequenceUri: string; manifestUri: string; frameArtifactUris: string[] }): EditProject {
    const project = projectWith([{ id: "inside", uri: join(workspace, "media", "inside.mp4") }]);
    const clip = { id: "clip-1", assetId: "inside", masks: [{ id: "mask-1", matteSequence: { schema: "editkin.auto-roto-matte/v1", ...paths } }] };
    return { ...project, tracks: project.tracks.map((track, index) => index === 0 ? { ...track, clips: [clip as never] } : track) };
  }

  it("binds a cached derivative to its canonical path (a junction swapped later is not followed) and keeps workspace ones", async () => {
    const link = join(cache, "derivatives", "link");
    await symlink(join(cache, "derivatives", "real"), link, "junction");
    try {
      const canonical = await realpath(join(cache, "derivatives", "real", "proxy.mp4"));
      const asset = withDerivatives({ proxyUri: join(link, "proxy.mp4"), thumbnailUri: join(workspace, "media", "inside.mp4") });
      const bound = await bindProjectMediaForRender(projectWithAsset(asset));
      expect(bound.assets[0].derivatives).toMatchObject({ proxyUri: canonical, thumbnailUri: join(workspace, "media", "inside.mp4") });
      await (await import("node:fs/promises")).rmdir(link);
      await symlink(elsewhere, link, "junction");
      expect(bound.assets[0].derivatives!.proxyUri).toBe(canonical);
      // Already canonical and workspace-only: the very same project object comes back.
      const plain = projectWithAsset(withDerivatives({ proxyUri: canonical }));
      expect(await bindProjectMediaForRender(plain)).toBe(plain);
    } finally { await (await import("node:fs/promises")).rmdir(link).catch(() => undefined); }
  });

  it("refuses a derivative that escapes the cache or names an ungranted outside file, and drops one the cache no longer has", async () => {
    const escape = join(cache, "derivatives", "escape");
    await symlink(elsewhere, escape, "junction");
    try {
      await expect(bindProjectMediaForRender(projectWithAsset(withDerivatives({ proxyUri: join(escape, "clip.mp4") }))))
        .rejects.toMatchObject({ code: "RENDER_MEDIA_REFUSED", reason: "link_escape" });
    } finally { await (await import("node:fs/promises")).rmdir(escape).catch(() => undefined); }
    await expect(bindProjectMediaForRender(projectWithAsset(withDerivatives({ overlayProxyUri: join(elsewhere, "clip.mp4") }))))
      .rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
    const evicted = await bindProjectMediaForRender(projectWithAsset(withDerivatives({ proxyUri: join(cache, "derivatives", "gone", "proxy.mp4"),
      waveformUri: join(cache, "derivatives", "real", "proxy.mp4") })));
    expect(evicted.assets[0].derivatives!.proxyUri).toBeUndefined();
    expect(evicted.assets[0].derivatives!.waveformUri).toBe(await realpath(join(cache, "derivatives", "real", "proxy.mp4")));
  });

  it("accepts Auto Roto mattes recorded by their real cache path, and refuses mattes outside the cache or behind a link", async () => {
    const real = await realpath(join(cache, "derivatives", "real"));
    const matte = (folder: string) => ({ sequenceUri: join(folder, "proxy.mp4"), manifestUri: join(folder, "proxy.mp4"), frameArtifactUris: [join(folder, "proxy.mp4")] });
    const ok = projectWithMatte(matte(real));
    expect(await bindProjectMediaForRender(ok)).toBe(ok);
    // A matte the cache no longer has is left for the renderer's own product-cache verification (nothing is read here).
    const missing = projectWithMatte(matte(join(real, "gone")));
    expect(await bindProjectMediaForRender(missing)).toBe(missing);
    await expect(bindProjectMediaForRender(projectWithMatte(matte(elsewhere)))).rejects.toMatchObject({ code: "RENDER_MEDIA_REFUSED", reason: "outside_cache" });
    const link = join(cache, "derivatives", "matte-link");
    await symlink(real, link, "junction");
    try {
      await expect(bindProjectMediaForRender(projectWithMatte(matte(link)))).rejects.toMatchObject({ code: "RENDER_MEDIA_REFUSED", reason: "not_canonical" });
    } finally { await (await import("node:fs/promises")).rmdir(link).catch(() => undefined); }
    const refusal = await bindProjectMediaForRender(projectWithMatte(matte(elsewhere))).catch((error: Error) => error.message);
    expect(refusal).not.toContain(elsewhere);
  });
});
