import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { uiFocusFileFixtureV1 } from "./longformUiFocusFileV1.fixture";
import { publishLongformUiFocusArtifactV1, readLongformUiFocusArtifactV1, readLongformUiFocusImageV1,
  sealLongformUiFocusArtifactV1, verifyLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";

const temp = useTempRoots();
async function fixture() {
  const root = await temp.create("uif-artifact-", { parent: tmpdir() }); expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  return { root, ...uiFocusFileFixtureV1(root, join(root, "source.mp4")) };
}
it("publishes exact image/manifest bytes immutably; identical publication does not replace or leave pending helpers", async () => {
  const f = await fixture(), images = new Map([[f.frame.id, f.image]]);
  await publishLongformUiFocusArtifactV1(f.root, f.artifact, images);
  const path = join(f.root, "longform-ui-focus-v1", f.artifact.artifactId, "manifest.json"), before = await readFile(path);
  await publishLongformUiFocusArtifactV1(f.root, f.artifact, images);
  expect(await readFile(path)).toEqual(before); expect(await readdir(join(f.root, "longform-ui-focus-v1"))).toEqual([f.artifact.artifactId]);
  const read = await readLongformUiFocusArtifactV1(f.root, f.artifact.artifactId);
  expect(read).toEqual(f.artifact); expect((await readLongformUiFocusImageV1(f.root, read, f.frame.id)).data).toEqual(f.image);
});
it("refuses image substitution and never silently replaces an already-published corrupted winner", async () => {
  const f = await fixture(), images = new Map([[f.frame.id, f.image]]);
  await expect(publishLongformUiFocusArtifactV1(f.root, f.artifact, new Map([[f.frame.id, Buffer.from("wrong")]]))).rejects.toThrow("IMAGE_INTEGRITY");
  await publishLongformUiFocusArtifactV1(f.root, f.artifact, images);
  const path = join(f.root, "longform-ui-focus-v1", f.artifact.artifactId, f.frame.id + ".jpg");
  await writeFile(path, "corrupted owner fixture");
  await expect(readLongformUiFocusImageV1(f.root, f.artifact, f.frame.id)).rejects.toThrow("IMAGE_INTEGRITY");
  await expect(publishLongformUiFocusArtifactV1(f.root, f.artifact, images)).rejects.toThrow("IMAGE_INTEGRITY");
  expect(await readFile(path, "utf8")).toBe("corrupted owner fixture");
});
it("rejects manifest edits, resealed forged coordinates and manual-box request fields", async () => {
  const f = await fixture(); await publishLongformUiFocusArtifactV1(f.root, f.artifact, new Map([[f.frame.id, f.image]]));
  const path = join(f.root, "longform-ui-focus-v1", f.artifact.artifactId, "manifest.json");
  await writeFile(path, JSON.stringify({ ...f.artifact, sourcePath: "other.mp4" }));
  await expect(readLongformUiFocusArtifactV1(f.root, f.artifact.artifactId)).rejects.toThrow("INTEGRITY");
  const bad = structuredClone(f.artifact); bad.draft.candidates[0].bounds.x = .7;
  const { artifactId: _ignored, ...body } = bad, resealed = sealLongformUiFocusArtifactV1(body);
  expect(() => verifyLongformUiFocusArtifactV1(resealed, resealed.artifactId)).toThrow();
  expect(() => verifyLongformUiFocusArtifactV1({ ...f.artifact, request: { ...f.request, bounds: {} } as never }, f.artifact.artifactId)).toThrow();
});
it("rejects path traversal and canonical directory junctions even if target data is readable", async () => {
  const f = await fixture(), other = await fixture();
  await publishLongformUiFocusArtifactV1(other.root, other.artifact, new Map([[other.frame.id, other.image]]));
  await expect(readLongformUiFocusArtifactV1(f.root, "../escape")).rejects.toThrow("PATH");
  await symlink(join(other.root, "longform-ui-focus-v1"), join(f.root, "longform-ui-focus-v1"), "junction");
  await expect(readLongformUiFocusArtifactV1(f.root, other.artifact.artifactId)).rejects.toThrow("CANONICAL_BOUNDARY");
});
