import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { exportCaptionDelivery } from "../domain/captionDelivery";
import { readProjectFile } from "./projectFiles";
import { exportLongformSidecarBundleV1, prepareLongformSidecarExportV1, type LongformSidecarExportRequestV1 } from "./longformSidecarExportV1";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-owned-sidecars-")), source = join(root, "source.editkin.json");
  const project = createEmptyProject("Owned filesystem fixture", { id: "owned-sidecar-file", fps: 30 });
  project.captions = [{ id: "C1", text: "Claude Code 😃", start: 1.1254, duration: 2.5, translation: { text: "Claude Code captions 😃", language: "en" } },
    { id: "C2", text: "第二句", start: 5.1254, duration: 2.5, translation: { text: "Second cue", language: "en" } }];
  project.director.markers = [{ id: "chapter", time: 1.1254, title: "教學章節 🧪", note: "", kind: "note", status: "open", createdAt: project.updatedAt },
    { id: "not-chapter", time: 0, title: "節拍提醒", note: "", kind: "beat", status: "open", createdAt: project.updatedAt }];
  const bytes = Buffer.from(JSON.stringify(project, null, 2) + "\n"); await writeFile(source, bytes, { flag: "wx" });
  const runtime = { workspaceRoot: root }, request = { projectPath: source, expectedProjectRevision: project.revision, chapterMarkerIds: ["chapter"], captionMode: "original" as const };
  const preview = await prepareLongformSidecarExportV1(runtime, request);
  const exportRequest: LongformSidecarExportRequestV1 = { ...request, expectedProjectSha256: preview.binding.projectSha256,
    expectedProjectFileSha256: preview.binding.projectFileSha256, expectedBundleSha256: preview.bundleSha256, outputDirectory: join(root, "new-pair") };
  return { root, source, bytes, project, runtime, request, preview, exportRequest };
}
const absent = async (path: string) => expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
describe("exclusive source-bound paired sidecar delivery", () => {
  it("writes and re-reads exactly two legacy-compatible files in all three modes without touching the source", async () => {
    const f = await fixture(); expect(await readdir(f.root)).toEqual(["source.editkin.json"]);
    for (const mode of ["original", "translation", "bilingual"] as const) {
      const request = { ...f.request, captionMode: mode }, preview = await prepareLongformSidecarExportV1(f.runtime, request);
      const result = await exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, ...request, expectedBundleSha256: preview.bundleSha256, outputDirectory: join(f.root, mode) });
      expect(result.status).toBe("COMPLETE"); expect(result.completePairVerified).toBe(true); expect(result.filesystemTransactionAtomic).toBe(false);
      expect(await readdir(result.outputDirectory)).toEqual(["captions.srt", "chapters.txt"]);
      expect(await readFile(result.files[0].path, "utf8")).toBe(exportCaptionDelivery(await readProjectFile(f.source), "srt", mode).text);
      expect(await readFile(result.files[1].path, "utf8")).toBe("00:00:01.125 教學章節 🧪\n");
      expect(result.binding).toEqual(preview.binding); expect(result.bundleSha256).toBe(preview.bundleSha256);
      for (const file of result.files) expect((await readFile(file.path)).byteLength).toBe(file.utf8Bytes);
    }
    expect(await readFile(f.source)).toEqual(f.bytes);
  });
  it("refuses stale revision, raw/canonical/bundle identity and changed selection before making an output directory", async () => {
    const f = await fixture();
    for (const change of [{ expectedProjectRevision: f.project.revision + 1 }, { expectedProjectSha256: "b".repeat(64) },
      { expectedProjectFileSha256: "b".repeat(64) }, { expectedBundleSha256: "b".repeat(64) }, { expectedBundleSha256: "bad" }, { chapterMarkerIds: ["not-chapter"] }]) {
      await expect(exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, ...change })).rejects.toThrow(/SIDECAR_/);
      await absent(f.exportRequest.outputDirectory);
    }
    expect(await readFile(f.source)).toEqual(f.bytes);
  });
  it("refuses a raw source change even when revision and normalized project contents remain identical", async () => {
    const f = await fixture(); await writeFile(f.source, Buffer.concat([f.bytes, Buffer.from(" \n")]));
    const newPreview = await prepareLongformSidecarExportV1(f.runtime, f.request);
    expect(newPreview.binding.projectSha256).toBe(f.preview.binding.projectSha256);
    expect(newPreview.binding.projectFileSha256).not.toBe(f.preview.binding.projectFileSha256);
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest)).rejects.toThrow("STALE_PREPARED_BINDING");
    await absent(f.exportRequest.outputDirectory);
  });
  it("keeps an interrupted partial pair incomplete and leaves prior aborts without output", async () => {
    const f = await fixture(), stopped = new AbortController(); stopped.abort();
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest, { signal: stopped.signal })).rejects.toThrow("ABORTED");
    await absent(f.exportRequest.outputDirectory);
    const midway = new AbortController();
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest, { signal: midway.signal, onPhase: async phase => { if (phase === "captions_written") midway.abort(); } }))
      .rejects.toThrow(/INCOMPLETE_OUTPUT.*ABORTED/);
    expect(await readdir(f.exportRequest.outputDirectory)).toEqual(["captions.srt"]);
    expect(await readFile(f.source)).toEqual(f.bytes);
  });
  it("does not complete if the original project changes after the first file is written", async () => {
    const f = await fixture(), externallyChanged = Buffer.concat([f.bytes, Buffer.from("\n")]);
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest, { onPhase: async phase => {
      if (phase === "captions_written") await writeFile(f.source, externallyChanged);
    } })).rejects.toThrow(/INCOMPLETE_OUTPUT.*SOURCE_CHANGED/);
    expect(await readdir(f.exportRequest.outputDirectory)).toEqual(["captions.srt"]);
    expect(await readFile(f.source)).toEqual(externallyChanged);
  });
  it("re-reads the first file after the second write so a changed pair cannot receive COMPLETE", async () => {
    const f = await fixture();
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest, { onPhase: async phase => {
      if (phase === "chapters_written") await writeFile(join(f.exportRequest.outputDirectory, "captions.srt"), "external edit\n");
    } })).rejects.toThrow(/INCOMPLETE_OUTPUT.*FINAL_PAIR_CHANGED/);
    expect(await readdir(f.exportRequest.outputDirectory)).toEqual(["captions.srt", "chapters.txt"]);
    expect(await readFile(join(f.exportRequest.outputDirectory, "captions.srt"), "utf8")).toBe("external edit\n");
  });
  it("preserves every existing author output directory or file and refuses a raced file without overwriting it", async () => {
    const f = await fixture(), old = join(f.root, "author-output"); await mkdir(old);
    const a = Buffer.from([0, 1, 2, 255]), b = Buffer.from("author chapters\n");
    await writeFile(join(old, "captions.srt"), a); await writeFile(join(old, "chapters.txt"), b);
    await expect(exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, outputDirectory: old })).rejects.toThrow("OUTPUT_EXISTS");
    expect(await readFile(join(old, "captions.srt"))).toEqual(a); expect(await readFile(join(old, "chapters.txt"))).toEqual(b);
    const leaf = join(f.root, "author-file"); await writeFile(leaf, a);
    await expect(exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, outputDirectory: leaf })).rejects.toThrow("OUTPUT_EXISTS");
    expect(await readFile(leaf)).toEqual(a);
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest, { onPhase: async phase => {
      if (phase === "directory_created") await writeFile(join(f.exportRequest.outputDirectory, "captions.srt"), b, { flag: "wx" });
    } })).rejects.toThrow("INCOMPLETE_OUTPUT");
    expect(await readFile(join(f.exportRequest.outputDirectory, "captions.srt"))).toEqual(b);
    expect(await readdir(f.exportRequest.outputDirectory)).toEqual(["captions.srt"]);
  });
  it("refuses lexical escape, alternate streams and observed parent junctions before writing a pair", async () => {
    const f = await fixture();
    for (const outputDirectory of [join(f.root, "..", "must-not-create-sidecars"), join(f.root, "new:stream")])
      await expect(exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, outputDirectory })).rejects.toThrow(/SIDECAR_(WORKSPACE_BOUNDARY|PATH_STREAM)/);
    const destination = join(f.root, "destination"), alias = join(f.root, "alias"); await mkdir(destination);
    await symlink(destination, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(exportLongformSidecarBundleV1(f.runtime, { ...f.exportRequest, outputDirectory: join(alias, "new") })).rejects.toThrow("DIRECTORY_REPARSE_OR_ALIAS");
    expect(await readdir(destination)).toEqual([]);
    await writeFile(join(destination, "source.editkin.json"), f.bytes);
    await expect(prepareLongformSidecarExportV1(f.runtime, { ...f.request, projectPath: join(alias, "source.editkin.json") })).rejects.toThrow("DIRECTORY_REPARSE_OR_ALIAS");
  });
  it("requires valid bounded primary project bytes rather than exporting from a hidden recovery copy", async () => {
    const f = await fixture(); await writeFile(`${f.source}.previous`, f.bytes); await writeFile(f.source, "{ corrupt");
    await expect(exportLongformSidecarBundleV1(f.runtime, f.exportRequest)).rejects.toThrow(); await absent(f.exportRequest.outputDirectory);
    expect(await readFile(`${f.source}.previous`)).toEqual(f.bytes);
    await writeFile(f.source, Buffer.from([0xff]));
    await expect(prepareLongformSidecarExportV1(f.runtime, f.request)).rejects.toThrow();
  });
  it("bounds previews while hashing the full SRT and does not cut a Unicode surrogate pair", async () => {
    const f = await fixture(); f.project.captions[0].text = "🧪".repeat(6000);
    await writeFile(f.source, JSON.stringify(f.project));
    const preview = await prepareLongformSidecarExportV1(f.runtime, f.request), srt = preview.files[0];
    expect(srt.previewTruncated).toBe(true); expect(srt.preview.length).toBeLessThanOrEqual(4096);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(srt.preview))).toBe(srt.preview);
    const full = exportCaptionDelivery(await readProjectFile(f.source), "srt", "original");
    expect(full.text.startsWith(srt.preview)).toBe(true); expect(srt.utf8Bytes).toBe(full.utf8Bytes);
    expect(srt.utf8Bytes).toBeGreaterThan(Buffer.byteLength(srt.preview, "utf8"));
  });
});
