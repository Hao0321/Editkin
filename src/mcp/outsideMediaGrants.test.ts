import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideOutsideMediaRead, mediaPathSyntax, outsideMediaRefusalMessage, OUTSIDE_MEDIA_GRANTS_SCHEMA, parseOutsideMediaGrantStore,
  type OutsideMediaRefusal,
} from "./outsideMediaGrants";

const BS = "\\";
const win = (path: string) => path.replaceAll("/", BS);

describe("outside media grants: path syntax is decided from text alone", () => {
  it("refuses UNC, verbatim, device, NT-object, // and relative-to-drive forms on Windows", () => {
    for (const path of [
      win("//attacker/share/clip.mov"), `${BS}${BS}attacker${BS}share${BS}clip.mov`, `${BS}${BS}?${BS}UNC${BS}attacker${BS}share${BS}clip.mov`,
      `${BS}${BS}?${BS}C:${BS}media${BS}clip.mov`, `${BS}${BS}.${BS}C:${BS}media${BS}clip.mov`, `${BS}${BS}.${BS}pipe${BS}x.mov`,
      `${BS}??${BS}C:${BS}media${BS}clip.mov`, "//attacker/share/clip.mov", win("C:/media/NUL.mov"), win("C:/media/com1.mp4"),
      win("C:/media/clip.mov:stream"), "C:media\\clip.mov", win("/media/clip.mov"), "", "C:\\media\\a\0b.mov",
    ]) expect(mediaPathSyntax(path, "win32"), path).toBe("not_local");
    expect(mediaPathSyntax(win("C:/media/clip.mov"), "win32")).toBe("local_absolute");
    expect(mediaPathSyntax("D:/media/音樂/song.flac", "win32")).toBe("local_absolute");
    expect(mediaPathSyntax(win("media/clip.mov"), "win32")).toBe("relative");
    expect(mediaPathSyntax("//host/share/x.mov", "linux")).toBe("not_local");
    expect(mediaPathSyntax("/srv/media/x.mov", "linux")).toBe("local_absolute");
  });

  it("refusals stay compact and never carry a path", () => {
    for (const reason of ["not_local", "not_media", "missing", "unreadable", "link_escape", "changed_since_import", "not_granted"] as OutsideMediaRefusal[]) {
      const message = outsideMediaRefusalMessage("x".repeat(500), reason);
      expect(message.startsWith(`OUTSIDE_MEDIA_NOT_GRANTED (${reason})`)).toBe(true);
      expect(Buffer.byteLength(message, "utf8")).toBeLessThan(2048);
      expect(message).toContain("EDITKIN_EXTRA_MEDIA_ROOTS");
    }
  });

  it("tells the agent the only ways in: 允許 in the opened project, or EDITKIN_EXTRA_MEDIA_ROOTS (opening alone grants nothing)", () => {
    const message = outsideMediaRefusalMessage("clip-1", "not_granted");
    expect(message).toContain("請在 Editkin 桌面版開啟這個專案，並在「要允許 AI 助手讀取它們嗎？」的提示選「允許」");
    expect(message).toContain("或把它所在的資料夾加入 EDITKIN_EXTRA_MEDIA_ROOTS");
    expect(message).toContain("還沒有在 Editkin 桌面版允許");
    expect(outsideMediaRefusalMessage("clip-1", "changed_since_import")).toContain("需要再允許一次");
    // The old advice (opening the project once grants it) is gone from every refusal.
    for (const reason of ["not_local", "not_media", "missing", "unreadable", "link_escape", "changed_since_import", "not_granted"] as OutsideMediaRefusal[]) {
      expect(outsideMediaRefusalMessage("clip-1", reason)).not.toContain("開啟這個專案一次");
    }
  });
});

describe("outside media grants: the store is read-only data that grants nothing when malformed", () => {
  const valid = { path: win("C:/media/clip.mov"), size: 10, mtimeMs: 1, headSha256: "a".repeat(64), headBytes: 10, grantedAtMs: 2, source: "import" };
  it("accepts only well-formed local media grants of the current schema", () => {
    const store = (grants: unknown[], extra: Record<string, unknown> = {}) => ({ schema: OUTSIDE_MEDIA_GRANTS_SCHEMA, schemaVersion: 1, grants, ...extra });
    expect(parseOutsideMediaGrantStore(store([valid])).size).toBe(1);
    expect(parseOutsideMediaGrantStore(store([valid], { schemaVersion: 2 })).size).toBe(0);
    expect(parseOutsideMediaGrantStore(store([valid], { schema: "something-else" })).size).toBe(0);
    expect(parseOutsideMediaGrantStore([valid]).size).toBe(0);
    expect(parseOutsideMediaGrantStore(null).size).toBe(0);
    for (const forged of [
      { ...valid, path: `${BS}${BS}attacker${BS}share${BS}clip.mov` }, { ...valid, path: "//attacker/share/clip.mov" },
      { ...valid, path: `${BS}${BS}?${BS}C:${BS}media${BS}clip.mov` }, { ...valid, path: win(["C:", "Users", "me", "secret.txt"].join("/")) },
      { ...valid, path: "media/clip.mov" }, { ...valid, headBytes: 9 }, { ...valid, headSha256: "A".repeat(64) },
      { ...valid, size: -1 }, { ...valid, mtimeMs: 1.5 }, { ...valid, source: "mcp" },
      // Recorded automatically on project open by the build before the consent fix: not the creator's choice.
      { ...valid, source: "project_open" },
    ]) expect(parseOutsideMediaGrantStore(store([forged])).size, JSON.stringify(forged)).toBe(0);
    for (const source of ["import", "relink", "project_consent"]) expect(parseOutsideMediaGrantStore(store([{ ...valid, source }])).size, source).toBe(1);
  });
});

/**
 * Cross-language proof, run on request after the Rust writer test wrote a real grant:
 *   cargo test --offline --locked outside_media_grants   (with EDITKIN_GRANT_INTEROP_DIR set)
 *   EDITKIN_GRANT_INTEROP_DIR=<same dir> vitest run src/mcp/outsideMediaGrants.test.ts
 */
describe.runIf(Boolean(process.env.EDITKIN_GRANT_INTEROP_DIR))("outside media grants: a grant written by the Rust desktop host", () => {
  it("is accepted by the MCP reader, and refused once the file changes", async () => {
    const directory = process.env.EDITKIN_GRANT_INTEROP_DIR!;
    const environment = { EDITKIN_APP_DATA_ROOT: join(directory, "appdata") };
    const clip = join(directory, "outside-media", "interop-clip.mov");
    const decision = await decideOutsideMediaRead(clip, environment);
    expect(decision).toEqual({ allowed: true, path: await realpath(clip), via: "grant" });
    expect(await decideOutsideMediaRead(join(directory, "outside-media", "other.mov"), environment)).toMatchObject({ allowed: false });
  });
});

describe("outside media grants: decisions on a real temporary filesystem", () => {
  let root = "", appData = "";
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "editkin-grant-unit-")));
    appData = join(root, "appdata");
    await mkdir(join(appData, "media-access"), { recursive: true });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("needs no app data root to refuse, and a missing store grants nothing", async () => {
    const clip = join(root, "clip.mp4");
    await writeFile(clip, "bytes");
    expect(await decideOutsideMediaRead(clip, {})).toEqual({ allowed: false, reason: "not_granted" });
    expect(await decideOutsideMediaRead(clip, { EDITKIN_APP_DATA_ROOT: appData })).toEqual({ allowed: false, reason: "not_granted" });
    expect(await decideOutsideMediaRead(join(root, "absent.mp4"), { EDITKIN_APP_DATA_ROOT: appData })).toEqual({ allowed: false, reason: "missing" });
  });

  it("grants exactly the canonical file with its size, time and first-64-KiB hash", async () => {
    const clip = join(root, "granted.mov");
    await writeFile(clip, Buffer.alloc(70_000, 7));
    const info = await stat(clip, { bigint: true });
    const head = (await readFile(clip)).subarray(0, 65_536);
    await writeFile(join(appData, "media-access", "outside-media-grants.json"), JSON.stringify({ schema: OUTSIDE_MEDIA_GRANTS_SCHEMA, schemaVersion: 1, grants: [{
      path: clip, size: 70_000, mtimeMs: Number(info.mtimeNs / 1_000_000n), headSha256: createHash("sha256").update(head).digest("hex"),
      headBytes: 65_536, grantedAtMs: Date.now(), source: "import" }] }));
    const environment = { EDITKIN_APP_DATA_ROOT: appData };
    expect(await decideOutsideMediaRead(clip, environment)).toEqual({ allowed: true, path: clip, via: "grant" });
    if (process.platform === "win32") expect(await decideOutsideMediaRead(clip.toUpperCase(), environment)).toMatchObject({ allowed: true, via: "grant" });
  });
});
