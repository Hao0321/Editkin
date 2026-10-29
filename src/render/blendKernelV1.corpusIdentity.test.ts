import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeProjectBytes } from "../application/projectCodec";
import type { EditProject } from "../domain/types";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { resolveAssFontRoot } from "./fontRoot";

/**
 * Opt-in corpus identity (not part of the default run): compiles the export FFmpeg vector of every saved project in
 * EDITKIN_CORPUS_LIST (one .editkin.json path per line) with all media I/O mocked: probes answer from the project's own
 * asset metadata, no process runs and no media file is read or hashed. EDITKIN_CORPUS_RECORD=<file> writes
 * project → SHA-256 of the vector (or the compile error); EDITKIN_CORPUS_BASELINE=<file> asserts every project matches.
 * Projects that reference media named in EDITKIN_CORPUS_EXCLUDE (comma separated substrings) are skipped.
 */
vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});
vi.mock("../plugins/nativeEffectGpuHelpers", async importOriginal => {
  const actual = await importOriginal<typeof import("../plugins/nativeEffectGpuHelpers")>();
  return { ...actual, sha256File: vi.fn(async () => "0".repeat(64)) };
});
vi.mock("./autoRotoMatteIntegrity", async importOriginal => {
  const actual = await importOriginal<typeof import("./autoRotoMatteIntegrity")>();
  return { ...actual, verifyFrozenRotoMatte: vi.fn(async (_matte: unknown, sequencePath: string) => sequencePath) };
});
vi.mock("./proofStillRouteV1", async importOriginal => {
  const actual = await importOriginal<typeof import("./proofStillRouteV1")>();
  return { ...actual, verifyProofStillCompositeSourcesV1: vi.fn(async () => undefined) };
});

const list = process.env.EDITKIN_CORPUS_LIST;
const app = fileURLToPath(new URL("../../", import.meta.url));
let workRoot = "";
let captured: string[] = [];
let current: EditProject | undefined;

beforeAll(async () => { workRoot = await mkdtemp(join(tmpdir(), "editkin-corpus-identity-")); initializeStudioCreativeAssets(); });
afterAll(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });
beforeEach(() => {
  vi.mocked(probeMedia).mockImplementation(async (path: string) => {
    const asset = current?.assets.find(candidate => candidate.uri === path) ?? current?.assets.find(candidate => path.endsWith(candidate.uri.replaceAll("\\", "/").split("/").pop() ?? "\u0000"));
    const width = asset?.width ?? 1920, height = asset?.height ?? 1080;
    return { duration: asset?.duration ?? 60, width, height, encodedWidth: width, encodedHeight: height, sampleAspectRatio: 1, displayAspectRatio: width / height,
      hasVideo: asset?.kind !== "audio", hasAudio: asset?.kind !== "image", colorPrimaries: asset?.color?.primaries ?? "bt709",
      colorTransfer: asset?.color?.transfer ?? "bt709", colorMatrix: asset?.color?.matrix ?? "bt709", colorRange: asset?.color?.range ?? "tv" };
  });
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => {
    const vector = [...args];
    const script = vector.indexOf("-filter_complex_script");
    if (script >= 0) vector[script + 1] = `<script>${await readFile(vector[script + 1], "utf8")}`;
    captured = vector;
    return { stdout: "", stderr: "" };
  });
});

describe.skipIf(!list)("saved-project corpus export vectors (opt-in)", () => {
  it("records or matches every project's vector", async () => {
    const excluded = (process.env.EDITKIN_CORPUS_EXCLUDE ?? "").split(",").map(value => value.trim()).filter(Boolean);
    const files = (await readFile(list!, "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const values: Record<string, string> = {};
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (excluded.some(name => text.includes(name))) { values[file] = "excluded"; continue; }
      captured = [];
      try {
        current = decodeProjectBytes(Buffer.from(text, "utf8"));
        const fonts = await resolveAssFontRoot(resolve(app, "public/fonts"), current);
        await renderComposite("owned-ffmpeg", "owned-ffprobe", join(workRoot, "out.mp4"), current, buildRenderPlan(current, uri => uri), undefined, "libx264", 30_000,
          fonts.fontRoot, current.colorManagement?.mode === "aces2" ? resolve(app, "public/color/aces2") : undefined, workRoot, undefined, false, undefined, fonts.bundledFaces);
        const vector = captured.map(argument => argument.replaceAll(workRoot.replaceAll("\\", "/"), "<work>").replaceAll(workRoot, "<work>")
          .replace(/\.[0-9a-f-]{36}\.background\.ass/g, ".<uuid>.background.ass")
          // Checkout location and per-render temporary directories are not content.
          .replace(/[A-Za-z]\\{0,2}:[\\/][^'"]*?[\\/]public[\\/](color|fonts)/g, "<app>/public/$1")
          .replace(/[A-Za-z]\\{0,2}:[\\/][^'"]*?editkin-(?:render|filtergraph|corpus-identity)-[A-Za-z0-9_-]+/g, "<work>"));
        values[file] = createHash("sha256").update(JSON.stringify(vector)).digest("hex");
        // EDITKIN_CORPUS_DUMP=<dir>: keep each normalized vector for diffing.
        if (process.env.EDITKIN_CORPUS_DUMP) await writeFile(join(process.env.EDITKIN_CORPUS_DUMP, `${values[file]}.json`), JSON.stringify(vector, null, 1), "utf8");
      } catch (error) {
        values[file] = `error: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200)}`;
      }
    }
    if (process.env.EDITKIN_CORPUS_RECORD) await writeFile(process.env.EDITKIN_CORPUS_RECORD, `${JSON.stringify({ schema: "editkin.corpus-vector-identity/v1", values }, null, 2)}\n`, "utf8");
    if (process.env.EDITKIN_CORPUS_BASELINE) {
      const baseline = JSON.parse(await readFile(process.env.EDITKIN_CORPUS_BASELINE, "utf8")) as { values: Record<string, string> };
      const differences = Object.keys({ ...baseline.values, ...values }).filter(key => baseline.values[key] !== values[key]);
      expect(differences).toEqual([]);
    }
    expect(Object.values(values).some(value => /^[0-9a-f]{64}$/.test(value))).toBe(true);
  }, 600_000);
});
