import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
const safeName = value => typeof value === "string" && /^[A-Za-z0-9_.\[\],-]+$/.test(value) && value !== "." && value !== "..";

function validateSource(font, bytes, license) {
  if (bytes.length < 10_000 || bytes.length > 40_000_000 || !["00010000", "4f54544f"].includes(bytes.subarray(0, 4).toString("hex"))) throw new Error(`Invalid SFNT source: ${font.id}`);
  if (sha(bytes) !== font.sha256) throw new Error(`Font source hash mismatch: ${font.id}`);
  if (sha(license) !== font.licenseSha256 || !license.toString("utf8").includes("SIL OPEN FONT LICENSE Version 1.1")) throw new Error(`Font license identity mismatch: ${font.id}`);
}

/** Bootstrap absent source packs; existing packs are verified, never downgraded or overwritten. */
export async function acquireFontSources({ root, fonts, metadata, fetchBytes, bootstrap = false }) {
  root = resolve(root);
  if (root === dirname(root)) throw new Error("A filesystem root is not a font-pack target");
  if (!fonts.length || new Set(fonts.map(f => f.id)).size !== fonts.length || new Set(fonts.map(f => f.file)).size !== fonts.length) throw new Error("Duplicate or empty source contract");
  for (const font of fonts) {
    if (!safeName(font.file) || !safeName(`${font.id}-OFL.txt`) || !/^[a-f0-9]{64}$/.test(font.sha256) || !/^[a-f0-9]{64}$/.test(font.licenseSha256)) throw new Error("Unsafe or unpinned font source contract");
  }
  if (!await exists(root) && !bootstrap) throw new Error("Absent font pack requires explicit bootstrap; existing assets are never replaced");
  await mkdir(dirname(root), { recursive: true });
  const lockPath = join(dirname(root), `.${basename(root)}-source-acquire.lock`);
  const lock = await open(lockPath, "wx");
  let lockIdentity;
  try {
    lockIdentity = await lock.stat();
    const current = await exists(root);
    if (current) {
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("Existing font root is not a plain directory");
      const manifestPath = join(root, "editkin-open-fonts.json");
      const manifestInfo = await exists(manifestPath);
      if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw new Error("Unmanaged font directory must be preserved");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (![1, 2].includes(manifest.schemaVersion) || manifest.id !== metadata.id || manifest.sourceCommit !== metadata.sourceCommit) throw new Error("Existing font pack needs an explicit staged migration");
      for (const font of fonts) {
        const matches = manifest.fonts?.filter(entry => entry.id === font.id) ?? [];
        if (matches.length !== 1 || matches[0].file !== font.file || matches[0].sha256 !== font.sha256 || matches[0].family !== font.family) throw new Error(`Existing source contract changed: ${font.id}`);
        for (const file of [font.file, `${font.id}-OFL.txt`]) {
          const info = await exists(join(root, file));
          if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Missing or linked source: ${file}`);
        }
        validateSource(font, await readFile(join(root, font.file)), await readFile(join(root, `${font.id}-OFL.txt`)));
      }
      return { status: "UNCHANGED", root, schemaVersion: manifest.schemaVersion, sourcesVerified: fonts.length, scope: "Pinned derivation sources only; run fonts gate for physical render faces" };
    }
    if (!bootstrap) throw new Error("Absent font pack requires explicit bootstrap; target changed before lock acquisition");
    const stage = await mkdtemp(join(dirname(root), ".font-source-stage-"));
    try {
      const entries = [];
      for (const font of fonts) {
        const [bytes, license] = await Promise.all([fetchBytes(font.source), fetchBytes(font.licenseSource)]);
        validateSource(font, bytes, license);
        const licenseFile = `${font.id}-OFL.txt`;
        await writeFile(join(stage, font.file), bytes, { flag: "wx" });
        await writeFile(join(stage, licenseFile), license, { flag: "wx" });
        entries.push({ id: font.id, family: font.family, file: font.file, bytes: bytes.length, sha256: font.sha256, license: "OFL-1.1", licenseFile, licenseSha256: font.licenseSha256, source: font.source });
      }
      await writeFile(join(stage, "editkin-open-fonts.json"), JSON.stringify({ schemaVersion: 1, ...metadata, fonts: entries }, null, 2) + "\n", { flag: "wx" });
      if (await exists(root)) throw new Error("Font target appeared during staging; refusing replacement");
      await rename(stage, root);
      return { status: "SOURCES_STAGED", root, sourcesVerified: entries.length, scope: "Source pack only; build static faces and run fonts gate before product use" };
    } catch (error) {
      error.message += `; candidate retained for diagnosis: ${stage}`;
      throw error;
    }
  } finally {
    await lock.close();
    const currentLock = await exists(lockPath);
    if (currentLock && (!lockIdentity || currentLock.isSymbolicLink() || currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino)) throw new Error("Font acquisition lock ownership changed; replacement lock preserved");
    if (currentLock) await unlink(lockPath); // Only the exclusive lock created by this invocation.
  }
}
