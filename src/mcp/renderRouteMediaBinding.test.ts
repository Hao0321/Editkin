// Security follow-up to 16b3a10 for every remaining MCP render route: the exact-copy routes (packet-copy v1, muxed
// packet-copy v1, GOP source-copy v2/v3), source-preserving v1, source-clock (time-remap) v1 and the multi-source Short v2
// render read exactly the media the grant check resolved. A junction swapped after the check cannot redirect the read,
// a missing or ungranted outside asset stops the route before its renderer runs, and a workspace-only project reaches
// the renderer byte for byte as it was read. Synthetic files only; the renderers are dependency seams.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject, MediaAsset } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { EXACT_PACKET_COPY_POLICY_V1 } from "../render/packetCopyAdmissionV1";
import { MUXED_PACKET_COPY_POLICY_V1 } from "../render/muxedPacketCopyAdmissionV1";
import { GOP_SOURCE_COPY_POLICY_V2 } from "../render/gopSourceCopyAdmissionV2";
import { GOP_SOURCE_COPY_POLICY_V3 } from "../render/gopSourceCopyExportV3";
import { SOURCE_PRESERVING_POLICY_V1 } from "../render/sourcePreservingAdmissionV1";
import { SOURCE_CLOCK_RENDER_POLICY_V1 } from "../render/timeRemapSourceRenderV1";

const multi = vi.hoisted(() => ({ projects: [] as EditProject[], onRender: undefined as undefined | (() => Promise<void>) }));
vi.mock("../render/ffmpeg", async original => ({ ...await original<typeof import("../render/ffmpeg")>(), renderProject: vi.fn(async (project: EditProject) => {
  multi.projects.push(structuredClone(project));
  await multi.onRender?.();
  return { outputPath: "unused.mp4", duration: 1, encoder: "libx264", planner: "test", ffmpegVersion: "test" };
}) }));
import { renderPacketCopyToolV1 } from "./packetCopyRenderToolsV1";
import { renderMuxedPacketCopyToolV1 } from "./muxedPacketCopyRenderToolsV1";
import { renderGopSourceCopyToolV2 } from "./gopSourceCopyRenderToolsV2";
import { renderGopSourceCopyToolV3 } from "./gopSourceCopyRenderToolsV3";
import { renderSourcePreservingToolV1 } from "./sourcePreservingRenderToolsV1";
import { renderTimeRemapToolV1 } from "./timeRemapRenderToolsV1";
import { productionMultiSourceShortDeps } from "./multiSourceShortToolsV2";

const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_APP_DATA_ROOT", "EDITKIN_EXTRA_MEDIA_ROOTS", "EDITKIN_CACHE_ROOT"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const temp = useTempRoots();
const SHA = "a".repeat(64);
let workspace = "", extra = "", elsewhere = "", cache = "", checked = "";

beforeAll(async () => {
  const root = await temp.create("w25-route-media-");
  workspace = join(root, "ws"); extra = join(root, "extra"); elsewhere = join(root, "elsewhere"); cache = join(root, "cache");
  await Promise.all([mkdir(join(workspace, "media"), { recursive: true }), mkdir(join(extra, "real"), { recursive: true }), mkdir(elsewhere, { recursive: true }),
    mkdir(join(cache, "derivatives", "d1"), { recursive: true })]);
  await writeFile(join(workspace, "media", "inside.mp4"), "workspace clip");
  await writeFile(join(extra, "real", "clip.mp4"), "the checked clip");
  await writeFile(join(elsewhere, "clip.mp4"), "a different file");
  await writeFile(join(cache, "derivatives", "d1", "proxy.mp4"), "cached proxy");
  process.env.EDITKIN_WORKSPACE = workspace;
  process.env.EDITKIN_APP_DATA_ROOT = join(root, "appdata");
  process.env.EDITKIN_EXTRA_MEDIA_ROOTS = [extra].join(delimiter);
  process.env.EDITKIN_CACHE_ROOT = cache;
  checked = await realpath(join(extra, "real", "clip.mp4"));
});
afterAll(() => {
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

function project(asset: Pick<MediaAsset, "uri"> & Partial<MediaAsset>): EditProject {
  const base = createEmptyProject("route media binding", { id: "route-media-binding", width: 320, height: 180, fps: 30 });
  return { ...base, assets: [{ id: "source", name: "clip.mp4", kind: "video", duration: 1, ...asset }] };
}
/** A junction inside the extra root that points at the checked folder until the renderer starts. */
async function linkedProject(name: string) {
  const link = join(extra, name);
  await symlink(join(extra, "real"), link, "junction");
  return { link, stored: project({ uri: join(link, "clip.mp4") }) };
}
async function retarget(link: string) {
  await rmdir(link);
  await symlink(elsewhere, link, "junction");
}

type Route = (stored: EditProject, render: (project: EditProject) => Promise<void>) => Promise<unknown>;
function seams(stored: EditProject, render: (project: EditProject) => Promise<void>, output: string) {
  return {
    readProject: async () => structuredClone(stored), resolveProjectPath: async () => join(workspace, "route.editkin.json"),
    resolveRenderPath: async () => join(workspace, "out", output), workspaceRoot: () => workspace, acquireProjectLock: async () => async () => undefined,
    render: (async (project: EditProject) => { await render(project); return { status: "GREEN" }; }) as never,
  };
}
const routes: Record<string, Route> = {
  "packet-copy v1": (stored, render) => renderPacketCopyToolV1({ projectPath: "route.editkin.json", outputPath: "out/a.mp4", policy: EXACT_PACKET_COPY_POLICY_V1,
    expectedSourceSha256: SHA }, undefined, seams(stored, render, "a.mp4")),
  "muxed packet-copy v1": (stored, render) => renderMuxedPacketCopyToolV1({ projectPath: "route.editkin.json", outputPath: "out/a.mp4", policy: MUXED_PACKET_COPY_POLICY_V1,
    expectedSourceSha256: SHA }, undefined, seams(stored, render, "a.mp4")),
  "GOP source-copy v2": (stored, render) => renderGopSourceCopyToolV2({ projectPath: "route.editkin.json", outputPath: "out/a.mp4", policy: GOP_SOURCE_COPY_POLICY_V2,
    expectedSourceSha256: SHA }, undefined, seams(stored, render, "a.mp4")),
  "GOP source-copy v3": (stored, render) => renderGopSourceCopyToolV3({ projectPath: "route.editkin.json", outputPath: "out/a.mp4", policy: GOP_SOURCE_COPY_POLICY_V3,
    expectedSourceSha256: SHA }, undefined, seams(stored, render, "a.mp4")),
  "source-preserving v1": (stored, render) => renderSourcePreservingToolV1({ projectPath: "route.editkin.json", outputPath: "out/a.mp4", policy: SOURCE_PRESERVING_POLICY_V1,
    expectedSourceSha256: SHA }, undefined, seams(stored, render, "a.mp4")),
  "source-clock (time-remap) v1": (stored, render) => renderTimeRemapToolV1({ projectPath: "route.editkin.json", outputPath: "out/a.mkv", policy: SOURCE_CLOCK_RENDER_POLICY_V1,
    expectedSourceSha256: SHA, expectedProjectSha256: createHash("sha256").update(canonicalJson(stored)).digest("hex"), maximumOutputBytes: 1024 ** 2 },
    undefined, seams(stored, render, "a.mkv")),
  "multi-source Short v2": async (stored, render) => {
    multi.onRender = async () => render(multi.projects.at(-1)!);
    try { return await productionMultiSourceShortDeps(process.env).render(stored, join(workspace, "out", "a.mp4"), { workRoot: join(workspace, "work"), timeoutMs: 60_000 }); }
    finally { multi.onRender = undefined; }
  },
};

describe.each(Object.keys(routes))("%s reads exactly the media it checked", name => {
  const route = routes[name];

  it("renders an outside asset by the canonical path that was granted; a junction swapped after the check does not redirect the read", async () => {
    const { link, stored } = await linkedProject(`link-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    let received: EditProject | undefined, readBack = "";
    try {
      await route(stored, async project => {
        received = project;
        await retarget(link);
        readBack = await readFile(project.assets[0].uri, "utf8");
      });
    } finally { await rmdir(link).catch(() => undefined); }
    expect(received?.assets[0].uri).toBe(checked);
    expect(readBack).toBe("the checked clip");
    expect(stored.assets[0].uri).toBe(join(link, "clip.mp4"));
  });

  it("hands a workspace-only project to the renderer byte for byte as it was read", async () => {
    const stored = project({ uri: join(workspace, "media", "inside.mp4"),
      derivatives: { sourceSha256: SHA, proxyUri: await realpath(join(cache, "derivatives", "d1", "proxy.mp4")), generatedAt: "2026-10-23T00:00:00.000Z" } });
    let received: EditProject | undefined;
    await route(stored, async project => { received = project; });
    expect(JSON.stringify(received)).toBe(JSON.stringify(stored));
  });

  it("stops before its renderer runs when an outside asset is missing or was never granted", async () => {
    let rendered = false;
    await expect(route(project({ uri: join(extra, "real", "missing.mp4") }), async () => { rendered = true; })).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(missing\)/);
    await expect(route(project({ uri: join(elsewhere, "clip.mp4") }), async () => { rendered = true; })).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
    expect(rendered).toBe(false);
  });
});
