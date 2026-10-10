import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real owned console EXEs and the production PowerShell/CreateFile/Process.Start
// path. No injected MetadataExecutor qualifies these controls. This file is a
// candidate for src/application; .rd is intentionally not a current test suite.
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ownedParent = join(app, ".rd", "benchmarks", "selected-native-metadata-pin-20261005", "test-runtime");
const baselineSource = join(app, ".rd", "benchmarks", "selected-native-metadata-pin-20261005", "test-candidate", "baselineSelectedNativeVideoRuntime.ts");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const ps = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const exec = promisify(execFile);
const children = new Set<ReturnType<typeof spawn>>();
const fixturePids = new Set<number>();
let root: string, a: string, b: string, aBytes: Buffer, bBytes: Buffer;
let helperSource: string, oldSource: string;
const beforeMarker = "// OWNED_FIXTURE_BARRIER_AFTER_PINNED_HASH";
const afterMarker = "// OWNED_FIXTURE_BARRIER_AFTER_CHILD_EXIT";
const csString = (s: string) => '@"' + s.replaceAll('"', '""') + '"';
const psString = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const absent = async (p: string) => { await expect(lstat(p)).rejects.toMatchObject({ code: "ENOENT" }); };
/** Holds an ordinary read/write handle on the file while `run` executes. */
async function whileWriterHolds(path: string, run: () => Promise<void>): Promise<void> {
  const writer = await open(path, "r+");
  try { await run(); } finally { await writer.close(); }
}

function consoleSource(kind: "A" | "B") {
  return String.raw`using System; using System.IO; using System.Diagnostics; using System.Security.Cryptography; using System.Threading;
public static class Fixture${kind} {
 public static int Main(string[] args) {
  string exe = Process.GetCurrentProcess().MainModule.FileName; string dir = Path.GetDirectoryName(exe);
  File.AppendAllText(Path.Combine(dir,"${kind}.started"), Process.GetCurrentProcess().Id.ToString()+"\n");
  string modeFile = Path.Combine(dir,"mode.txt"), mode = File.Exists(modeFile) ? File.ReadAllText(modeFile) : "normal";
  if(mode=="timeout") { Thread.Sleep(15000); File.WriteAllText(Path.Combine(dir,"late-marker"),"unexpected-survival"); }
  if(mode=="failure") { Console.Error.Write("owned-failure"); return 7; }
  if(mode=="overflow") { Console.Write(new string('X', 65537)); return 0; }
  ${kind === "B" ? 'Console.Write(File.ReadAllText(Path.Combine(dir,"expected-a-metadata.json"))); return 0;' : String.raw`byte[] bytes = File.ReadAllBytes(exe); string digest;
  using(SHA256 h=SHA256.Create()) digest=BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
  Console.Write("{\"schema\":\"editkin.native-video-runtime-metadata/v1\",\"platform\":\"win32\",\"executableSha256\":\""+digest+"\",\"executableBytes\":"+bytes.Length+",\"videoInteropProtocol\":\"media-foundation-d3d11-d3d12-wgpu/v1\",\"nativeFloatingVideoFrameContract\":\"editkin.native-floating-frame-material/v1\",\"offscreenVideoProtocol\":\"editkin.resident-offscreen-video-target/v1\",\"displayPaintSchema\":\"editkin.native-motion-paint-track/v2\",\"videoTargetAdmission\":{\"schema\":\"editkin.shared-video-target-admission/v1\",\"requiredBackend\":\"Dx12\",\"factory\":\"new_dx12_video\",\"selection\":\"deferred-until-target-bind\",\"offscreenProtocol\":\"editkin.resident-offscreen-video-target/v1\"},\"actualTargetMeasured\":false,\"noNativeWindowCreated\":true}"); return 0;`}
 }
}`;
}
function metadataFor(bytes: Buffer) {
  return { schema: "editkin.native-video-runtime-metadata/v1", platform: "win32", executableSha256: sha(bytes), executableBytes: bytes.length,
    videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1", nativeFloatingVideoFrameContract: "editkin.native-floating-frame-material/v1",
    offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", displayPaintSchema: "editkin.native-motion-paint-track/v2",
    videoTargetAdmission: { schema: "editkin.shared-video-target-admission/v1", requiredBackend: "Dx12", factory: "new_dx12_video", selection: "deferred-until-target-bind", offscreenProtocol: "editkin.resident-offscreen-video-target/v1" },
    actualTargetMeasured: false, noNativeWindowCreated: true };
}

async function currentChild(entry: string, request: object): Promise<{ stdout: string; code: number | null; stderr: string }> {
  const loader = pathToFileURL(join(app, "node_modules", "tsx", "dist", "loader.mjs")).href;
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", loader, entry, JSON.stringify(request)], { cwd: app, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, bounded = true;
    const timer = setTimeout(() => { bounded = false; child.kill(); }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 64 * 1024) { bounded = false; child.kill(); } else stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) { bounded = false; child.kill(); } else stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on("close", async code => {
      clearTimeout(timer); children.delete(child);
      try {
        await writeFile(join(dirname(entry), "CHILD_RESPONSE.json"), JSON.stringify({ pid: child.pid, code, stdout, stderr, bounded, stdoutBytes, stderrBytes }));
        if (!bounded) reject(new Error("Owned fixture parent exceeded 20s/64KiB; descendants require readback before cleanup")); else done({ stdout, stderr, code });
      } catch (error) { reject(error); }
    });
  });
}
async function fixture(id: string) {
  const caseRoot = join(root, id), parent = join(caseRoot, "selected-parent"), exe = join(parent, "selected.exe");
  await mkdir(parent, { recursive: true }); await copyFile(a, exe); await copyFile(b, join(parent, "B.exe"));
  await writeFile(join(parent, "expected-a-metadata.json"), JSON.stringify(metadataFor(aBytes)));
  return { caseRoot, parent, exe, expected: { executableSha256: sha(aBytes), executableBytes: aBytes.length } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function helperEntry(f: Fixture, before = "", after = "", privateClass = "") {
  if (helperSource.split(beforeMarker).length !== 2 || helperSource.split(afterMarker).length !== 2) throw new Error("Exact private barrier marker identity changed");
  const entry = join(f.caseRoot, "private-helper-entry.ts");
  let transformed = helperSource.replace(beforeMarker, beforeMarker + "\n" + before).replace(afterMarker, afterMarker + "\n" + after);
  if (privateClass) {
    const classAnchor = "public static class EditkinPinnedNativeVideoMetadata {";
    if (transformed.split(classAnchor).length !== 2) throw new Error("Exact private C# class insertion boundary changed");
    transformed = transformed.replace(classAnchor, privateClass + "\n" + classAnchor);
  }
  await writeFile(entry, transformed + '\nconst request = JSON.parse(process.argv[2]);\ntry { const text = await executePinnedNativeVideoMetadata(request.path, request.expected); process.stdout.write(JSON.stringify({text})); } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }\n');
  await writeFile(join(f.caseRoot, "source-copy-identity.json"), JSON.stringify({ productionSourceSha256: sha(helperSource), privateEntrySha256: sha(await readFile(entry)), privateTransform: "two uniquely matched inert comment barriers + appended entry; optional owned reparse interop class at unique C# class anchor", configuredPath: f.exe }));
  return entry;
}
function denyBarrier(f: Fixture, operation: string) {
  return `bool denied=false; try { ${operation} File.WriteAllText(${csString(join(f.caseRoot, "ATTACK_ALLOWED"))},"allowed"); } catch(IOException error) { if((error.HResult & 0xFFFF)!=32) throw; denied=true; } catch(UnauthorizedAccessException error) { if((error.HResult & 0xFFFF)!=32) throw; denied=true; } File.WriteAllText(${csString(join(f.caseRoot, "attack-result.txt"))}, denied ? "sharing-error32-before-spawn" : "ALLOWED");`;
}
async function requireAOnly(f: Fixture, response: Awaited<ReturnType<typeof currentChild>>) {
  expect(response.code).toBe(0); const parsed = JSON.parse(response.stdout);
  expect(JSON.parse(parsed.text)).toEqual(metadataFor(aBytes));
  const starts = (await readFile(join(f.parent, "A.started"), "utf8")).trim().split("\n"); expect(starts).toHaveLength(1);
  for (const value of starts) fixturePids.add(Number(value));
  await absent(join(f.parent, "B.started")); expect(sha(await readFile(f.exe))).toBe(sha(aBytes));
}
async function denyAndA(f: Fixture, operation: string, restoration: string) {
  const entry = await helperEntry(f, denyBarrier(f, operation)); const response = await currentChild(entry, { path: f.exe, expected: f.expected });
  expect(await readFile(join(f.caseRoot, "attack-result.txt"), "utf8")).toBe("sharing-error32-before-spawn");
  await absent(join(f.caseRoot, "ATTACK_ALLOWED")); await requireAOnly(f, response);
  const source = join(f.caseRoot, "postlease-operation.cs"), script = join(f.caseRoot, "postlease-operation.ps1");
  await writeFile(source, `using System; using System.IO; public static class OwnedPostLease { public static string Run(string executablePath) { try { ${operation} return "same-operation-succeeded-after-release"; } finally { ${restoration} } } }`);
  const scriptText = '$ErrorActionPreference="Stop"\nAdd-Type -TypeDefinition ([IO.File]::ReadAllText(' + psString(source) + ')) -ReferencedAssemblies @("System.dll","System.Core.dll")\n[Console]::Out.Write([OwnedPostLease]::Run(' + psString(f.exe) + '))\n'; await writeFile(script, scriptText);
  const calibration = await exec(ps, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", scriptText], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  expect(calibration.stdout).toBe("same-operation-succeeded-after-release"); expect(sha(await readFile(f.exe))).toBe(sha(aBytes));
  await writeFile(join(f.caseRoot, "postlease-operation.json"), JSON.stringify({ stdout: calibration.stdout, stderr: calibration.stderr, actualSameOperation: true, restoredA: true }));
}
async function rememberExitedA(f: Fixture) {
  const pid = Number((await readFile(join(f.parent, "A.started"), "utf8")).trim()); fixturePids.add(pid);
  expect(() => process.kill(pid, 0)).toThrow();
  const moved = f.exe + ".released"; await rename(f.exe, moved); await rename(moved, f.exe);
  expect(sha(await readFile(f.exe))).toBe(sha(aBytes)); await absent(join(f.parent, "B.started"));
}

beforeAll(async () => {
  if (process.platform !== "win32") return;
  await mkdir(ownedParent, { recursive: true }); root = await mkdtemp(join(ownedParent, "owned-"));
  helperSource = await readFile(new URL("./pinnedNativeVideoMetadata.ts", import.meta.url), "utf8");
  oldSource = await readFile(baselineSource, "utf8");
  a = join(root, "A.exe"); b = join(root, "B.exe");
  for (const [kind, target] of [["A", a], ["B", b]] as const) {
    const source = join(root, kind + ".cs"), script = join(root, "compile-" + kind + ".ps1"); await writeFile(source, consoleSource(kind));
    const scriptText = '$ErrorActionPreference="Stop"\nAdd-Type -TypeDefinition ([IO.File]::ReadAllText(' + psString(source) + ')) -OutputAssembly ' + psString(target) + ' -OutputType ConsoleApplication\n'; await writeFile(script, scriptText);
    await exec(ps, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", scriptText], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  }
  aBytes = await readFile(a); bBytes = await readFile(b); expect(sha(aBytes)).not.toBe(sha(bBytes));
  await writeFile(join(root, "FIXTURE_SOURCE_IDENTITIES.json"), JSON.stringify({ A: { bytes: aBytes.length, sha256: sha(aBytes) }, B: { bytes: bBytes.length, sha256: sha(bBytes) }, helperSourceSha256: sha(helperSource), vulnerableBaselineSourceSha256: sha(oldSource), scope: "selected executable metadata execution only; serving renderer path remains OPEN" }));
}, 45_000);

afterAll(async () => {
  if (process.platform !== "win32" || !root) return;
  if (children.size !== 0) throw new Error("Owned child still live; retain precise fixture directory");
  // Directory entries carry their own type, so each file is read without a separate path check first.
  async function collectPids(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unretired fixture reparse entry");
      if (entry.isDirectory()) await collectPids(path);
      else if (path.endsWith(".started")) for (const text of (await readFile(path, "utf8")).trim().split("\n")) { const pid = Number(text); if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Malformed fixture PID evidence"); fixturePids.add(pid); }
    }
  }
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Unretired fixture reparse entry");
  await collectPids(root);
  for (const pid of fixturePids) { try { process.kill(pid, 0); throw new Error("Owned fixture PID still live; retain evidence"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  const within = relative(ownedParent, root); if (!within || within.startsWith("..") || resolve(ownedParent, within) !== root) throw new Error("Owned cleanup path rejected");
  if (sha(await readFile(a)) !== sha(aBytes) || sha(await readFile(b)) !== sha(bBytes)) throw new Error("Fixture templates drifted; retain precise evidence");
  // Refuse unexpected reparse entries before recursive cleanup. Tests remove
  // their one known junction explicitly; no walk can traverse another target.
  async function noLinks(path: string): Promise<void> { const s = await lstat(path); if (s.isSymbolicLink()) throw new Error("Unretired fixture reparse entry"); if (s.isDirectory()) for (const name of await readdir(path)) await noLinks(join(path, name)); }
  await noLinks(root);
  // Keep precise small evidence, including failed controls, outside the owned
  // executable cleanup window. Do not delete the only denial/marker record.
  const evidenceRoot = join(ownedParent, "retained-" + basename(root)); await mkdir(evidenceRoot);
  const identities: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function preserve(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await preserve(path); continue; }
      const bytes = await readFile(path), name = relative(root, path); identities.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
      if (bytes.length <= 64 * 1024 && !name.endsWith(".exe")) { const target = join(evidenceRoot, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
    }
  }
  await preserve(root); await writeFile(join(evidenceRoot, "OWNED_CLEANUP_IDENTITIES.json"), JSON.stringify({ resolvedRoot: root, allOwnedDirectChildrenClosed: true, fixturePids: [...fixturePids], identities }));
  await rm(root, { recursive: true, force: false });
});

describe.skipIf(process.platform !== "win32")("selected native metadata real Windows sharing admission", () => {
  it("calibrates the original vulnerable A→B→A helper: B really executes yet original after-hash accepts A", async () => {
    const f = await fixture("vulnerable-baseline"), entry = join(f.caseRoot, "private-old-entry.ts"), saved = f.exe + ".saved-a";
    const call = "const text = await (options.executeMetadata ?? executeMetadata)(executablePath);";
    if (oldSource.split(call).length !== 2) throw new Error("Baseline metadata execution boundary changed");
    const canonicalImport = 'import { canonicalJson } from "../shared/canonicalJson";';
    if (oldSource.split(canonicalImport).length !== 2) throw new Error("Baseline relocation import changed");
    const relocated = oldSource.replace(canonicalImport, 'import { canonicalJson } from ' + JSON.stringify(join(app, "src", "shared", "canonicalJson.ts").replaceAll("\\", "/")) + ';');
    const changed = relocated.replace(call, `await rename(executablePath, ${JSON.stringify(saved)}); await copyFile(${JSON.stringify(join(f.parent, "B.exe"))}, executablePath);\n${call}\nawait unlink(executablePath); await rename(${JSON.stringify(saved)}, executablePath);`);
    await writeFile(entry, 'import {copyFile,rename,unlink} from "node:fs/promises";\n' + changed + '\nconst r=JSON.parse(process.argv[2]); try { process.stdout.write(JSON.stringify(await readSelectedNativeVideoRuntime({executablePath:r.path}))); } catch(e) { process.stderr.write(String(e)); process.exitCode=1; }\n');
    const response = await currentChild(entry, { path: f.exe }); expect(response.code).toBe(0);
    expect(JSON.parse(response.stdout).identity.executableSha256).toBe(sha(aBytes));
    const bPid = Number((await readFile(join(f.parent, "B.started"), "utf8")).trim()); expect(bPid).toBeGreaterThan(0); fixturePids.add(bPid); await absent(join(f.parent, "A.started"));
    expect(sha(await readFile(f.exe))).toBe(sha(aBytes));
  }, 25_000);
  it("executes actual A once with full-byte metadata and releases pins", async () => {
    const f = await fixture("positive"), entry = await helperEntry(f); await requireAOnly(f, await currentChild(entry, { path: f.exe, expected: f.expected })); await rememberExitedA(f);
  }, 25_000);
  it("denies leaf rename at the actual pinned hash→spawn boundary before B can replace A", async () => {
    const f = await fixture("leaf-rename"); await denyAndA(f, `File.Move(executablePath, executablePath+".saved-a"); File.Copy(${csString(join(f.parent, "B.exe"))}, executablePath);`, 'if(File.Exists(executablePath+".saved-a")) { File.Delete(executablePath); File.Move(executablePath+".saved-a",executablePath); }');
  }, 25_000);
  it("denies leaf overwrite at the actual boundary before execution", async () => {
    const f = await fixture("leaf-overwrite"); await denyAndA(f, `using(FileStream writer=new FileStream(executablePath,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)) { byte[] changed=File.ReadAllBytes(${csString(join(f.parent, "B.exe"))}); writer.Write(changed,0,changed.Length); }`, `File.WriteAllBytes(executablePath,File.ReadAllBytes(${csString(a)}));`);
  }, 25_000);
  it("rejects an existing hardlink count before execution of the selected inode", async () => {
    const f = await fixture("hardlink-write"), alias = join(f.caseRoot, "hardlink.exe"); await link(f.exe, alias);
    const response = await currentChild(await helperEntry(f), { path: f.exe, expected: f.expected });
    expect(response.code).not.toBe(0); expect(response.stderr).toContain("selected-native-metadata:link-or-file-type-rejected");
    await absent(join(f.parent, "A.started")); await absent(join(f.parent, "B.started"));
    expect(sha(await readFile(alias))).toBe(sha(aBytes));
  }, 25_000);
  it("denies selected parent namespace rename before a B replacement directory can appear", async () => {
    const f = await fixture("ancestor-rename"); await denyAndA(f, `Directory.Move(${csString(f.parent)}, ${csString(f.parent + ".moved")}); Directory.CreateDirectory(${csString(f.parent)}); File.Copy(${csString(b)}, executablePath);`, `if(Directory.Exists(${csString(f.parent + ".moved")})) { File.Delete(executablePath); Directory.Delete(${csString(f.parent)},false); Directory.Move(${csString(f.parent + ".moved")},${csString(f.parent)}); }`);
  }, 25_000);
  it("denies the actual parent directory WRITE handle needed for in-place FSCTL_SET_REPARSE_POINT", async () => {
    const f = await fixture("ancestor-inplace-reparse"), target = join(f.caseRoot, "owned-junction-target"), result = join(f.caseRoot, "inplace-reparse-result.txt"); await mkdir(target);
    const privateClass = String.raw`public static class OwnedInplaceReparse {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,uint n,IntPtr output,uint outputBytes,out uint returned,IntPtr overlapped);
 public static string AssertWritableAfterRelease(string directory) {
  using(var handle=CreateFileW(directory,0x40000000u,7u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero)) {
   if(handle.IsInvalid) throw new InvalidOperationException("after-release-directory-write-open-failed:"+Marshal.GetLastWin32Error());
   return "write-handle-opened-after-release";
  }
 }
 public static void Attempt(string directory,string target,string result) {
  using(var handle=CreateFileW(directory,0x40000000u,7u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero)) {
   if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); File.WriteAllText(result,code==32 ? "sharing-denied-before-spawn" : "write-open-error:"+code); return; }
   byte[] substitute=Encoding.Unicode.GetBytes("\\??\\"+target), print=Encoding.Unicode.GetBytes(target);
   byte[] buffer=new byte[16+substitute.Length+2+print.Length+2];
   Array.Copy(BitConverter.GetBytes(0xA0000003u),0,buffer,0,4); Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length-8)),0,buffer,4,2);
   Array.Copy(BitConverter.GetBytes((ushort)substitute.Length),0,buffer,10,2); Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length+2)),0,buffer,12,2); Array.Copy(BitConverter.GetBytes((ushort)print.Length),0,buffer,14,2);
   Array.Copy(substitute,0,buffer,16,substitute.Length); Array.Copy(print,0,buffer,16+substitute.Length+2,print.Length);
   uint returned; bool changed=DeviceIoControl(handle,0x900A4u,buffer,(uint)buffer.Length,IntPtr.Zero,0,out returned,IntPtr.Zero); int mutationCode=Marshal.GetLastWin32Error();
   bool restored=false; if(changed) { byte[] deletion=new byte[8]; Array.Copy(BitConverter.GetBytes(0xA0000003u),deletion,4); restored=DeviceIoControl(handle,0x900ACu,deletion,8,IntPtr.Zero,0,out returned,IntPtr.Zero); }
   File.WriteAllText(result,"WRITE_HANDLE_UNSAFELY_OPENED;fsctl="+changed+";error="+mutationCode+";restored="+restored);
  }
 }
}`;
    const entry = await helperEntry(f, `OwnedInplaceReparse.Attempt(${csString(f.parent)},${csString(target)},${csString(result)});`, "", privateClass);
    const response = await currentChild(entry, { path: f.exe, expected: f.expected });
    expect(await readFile(result, "utf8")).toBe("sharing-denied-before-spawn"); await requireAOnly(f, response);
    // The same real GENERIC_WRITE directory open must succeed after the lease
    // ends, proving denial came from sharing admission rather than fixture ACL.
    const calibrationSource = join(f.caseRoot, "after-release-interop.cs"), calibrationScript = join(f.caseRoot, "after-release-interop.ps1");
    await writeFile(calibrationSource, "using System; using System.IO; using System.Text; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;\n" + privateClass);
    const scriptText = '$ErrorActionPreference="Stop"\nAdd-Type -TypeDefinition ([IO.File]::ReadAllText(' + psString(calibrationSource) + ')) -ReferencedAssemblies @("System.dll","System.Core.dll")\n[Console]::Out.Write([OwnedInplaceReparse]::AssertWritableAfterRelease(' + psString(f.parent) + '))\n'; await writeFile(calibrationScript, scriptText);
    const calibration = await exec(ps, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", scriptText], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
    expect(calibration.stdout).toBe("write-handle-opened-after-release");
    await writeFile(join(f.caseRoot, "after-release-write-calibration.json"), JSON.stringify({ stdout: calibration.stdout, stderr: calibration.stderr, operation: "same CreateFileW GENERIC_WRITE/share7/BACKUP_SEMANTICS|OPEN_REPARSE_POINT after pins released" }));
  }, 25_000);
  it("fails closed before spawn when a writer already owns the selected file", async () => {
    const f = await fixture("preexisting-writer");
    await whileWriterHolds(f.exe, async () => { const response = await currentChild(await helperEntry(f), { path: f.exe, expected: f.expected }); expect(response.code).not.toBe(0); expect(response.stderr).toContain("selected-native-metadata:safe-open-failed"); await absent(join(f.parent, "A.started")); await absent(join(f.parent, "B.started")); });
    expect(sha(await readFile(f.exe))).toBe(sha(aBytes));
  }, 25_000);
  it("rejects a genuine parent junction without executing either fixture", async () => {
    const f = await fixture("parent-reparse"), alias = join(f.caseRoot, "junction"); await symlink(f.parent, alias, "junction");
    try { const response = await currentChild(await helperEntry(f), { path: join(alias, "selected.exe"), expected: f.expected }); expect(response.code).not.toBe(0); expect(response.stderr).toContain("selected-native-metadata:link-or-file-type-rejected"); await absent(join(f.parent, "A.started")); await absent(join(f.parent, "B.started")); }
    finally { await unlink(alias); }
  }, 25_000);
  for (const mode of ["failure", "timeout", "overflow"] as const) it(`releases file/ancestor pins only after actual child ${mode} exits`, async () => {
    const f = await fixture("child-" + mode); await writeFile(join(f.parent, "mode.txt"), mode);
    const response = await currentChild(await helperEntry(f), { path: f.exe, expected: f.expected }); expect(response.code).not.toBe(0);
    expect(response.stderr).toContain("selected-native-metadata:" + ({ failure: "child-exited-unsuccessfully", timeout: "child-timed-out", overflow: "child-output-overflow" } as const)[mode]);
    await rememberExitedA(f); await absent(join(f.parent, "late-marker"));
  }, 25_000);
});
