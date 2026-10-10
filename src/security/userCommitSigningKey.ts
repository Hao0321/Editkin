import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type UserCommitKeyProtection = "windows_dpapi_current_user" | "posix_owner_only";
export interface UserCommitKeyIdentity { keyId: string; protection: UserCommitKeyProtection }
export interface UserCommitDigestSignature extends UserCommitKeyIdentity { issuerProof: string }

const DIGEST = /^[a-f0-9]{64}$/;
const DOMAIN = "original-motion-commit:v2:";
const KEY_FILE = "signing-key.v2";

/* This helper owns the plaintext key. Only its public identity and a requested
 * domain-separated HMAC leave the child. CurrentUser is deliberately NOT the
 * DPAPI LocalMachine scope. Directory handles deny delete sharing throughout
 * the operation; OPEN_REPARSE_POINT checks the actual leaf handle as well.
 * Sources: Microsoft ProtectedData, CreateFileW and FileStream ACL constructor.
 */
const WINDOWS_KEY_HELPER = String.raw`
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class EditkinUserCommitKey {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
  static readonly SecurityIdentifier SystemUser = new SecurityIdentifier("S-1-5-18");
  static readonly byte[] Entropy = Encoding.UTF8.GetBytes("editkin-original-motion-commit-key:v2");
  const uint Reparse = 0x400, DirectoryAttribute = 0x10;
  static Exception Fail(string code) { return new InvalidOperationException("user-commit-key:" + code); }

  static FileInfo Info(SafeFileHandle handle) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info)) throw Fail("handle-info-unavailable");
    return info;
  }
  static bool Same(FileInfo a, FileInfo b) {
    return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow
      && a.SizeHigh == b.SizeHigh && a.SizeLow == b.SizeLow
      && a.Write.dwHighDateTime == b.Write.dwHighDateTime && a.Write.dwLowDateTime == b.Write.dwLowDateTime;
  }
  static SafeFileHandle Pin(string path, bool directory) {
    // Do not grant FILE_SHARE_DELETE. Readers also deny FILE_SHARE_WRITE.
    var handle = CreateFileW(path, directory ? 0x80u : 0x80000000u,
      directory ? 3u : 1u, IntPtr.Zero, 3u, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error(); handle.Dispose();
      if (error == 2 || error == 3) throw new FileNotFoundException("user-commit-key:missing");
      throw Fail("safe-open-failed");
    }
    var info = Info(handle);
    if ((info.Attributes & Reparse) != 0 || ((info.Attributes & DirectoryAttribute) != 0) != directory
      || (!directory && info.Links != 1)) {
      handle.Dispose(); throw Fail("link-or-file-type-rejected");
    }
    return handle;
  }
  static DirectorySecurity DirectoryAcl() {
    var acl = new DirectorySecurity(); acl.SetOwner(User); acl.SetAccessRuleProtection(true, false);
    var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    acl.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(SystemUser, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
    return acl;
  }
  static FileSecurity FileAcl() {
    var acl = new FileSecurity(); acl.SetOwner(User); acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(SystemUser, FileSystemRights.FullControl, AccessControlType.Allow));
    return acl;
  }
  static void AssertPrivateAcl(FileSystemSecurity acl) {
    if (!User.Equals(acl.GetOwner(typeof(SecurityIdentifier))) || !acl.AreAccessRulesProtected) throw Fail("owner-or-acl-rejected");
    bool ownerFull = false;
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType != AccessControlType.Allow) continue;
      if (rule.IsInherited || (!User.Equals(rule.IdentityReference) && !SystemUser.Equals(rule.IdentityReference))) throw Fail("broad-acl-rejected");
      if (User.Equals(rule.IdentityReference) && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl) ownerFull = true;
    }
    if (!ownerFull) throw Fail("owner-access-rejected");
  }
  static string TrustRoot(string isolatedTestRoot) {
    // The Node production entry never supplies isolatedTestRoot. The OS folder
    // query, rather than caller/workspace/environment, chooses the user store.
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    var root = String.IsNullOrEmpty(isolatedTestRoot) ? Path.Combine(local, "Editkin", "Trust", "original-motion-commit-v2") : isolatedTestRoot;
    if (String.IsNullOrEmpty(local) || !Path.IsPathRooted(root) || root.StartsWith("\\\\", StringComparison.Ordinal)) throw Fail("user-root-unavailable");
    var full = Path.GetFullPath(root);
    if (!String.Equals(full.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw Fail("noncanonical-root");
    return full;
  }
  static List<SafeFileHandle> PinAncestry(string root, bool create) {
    var paths = new Stack<string>(); var next = root;
    while (next != null) { paths.Push(next); var p = Path.GetDirectoryName(next); next = String.IsNullOrEmpty(p) ? null : p; }
    var pinned = new List<SafeFileHandle>();
    try {
      while (paths.Count > 0) {
        var path = paths.Pop();
        try { pinned.Add(Pin(path, true)); }
        catch (FileNotFoundException) {
          if (!create) throw;
          Directory.CreateDirectory(path, DirectoryAcl());
          pinned.Add(Pin(path, true));
        }
      }
      AssertPrivateAcl(Directory.GetAccessControl(root));
      return pinned;
    } catch { foreach (var handle in pinned) handle.Dispose(); throw; }
  }
  static byte[] ReadKey(string path) {
    using (var handle = Pin(path, false)) {
      var before = Info(handle);
      if (before.SizeHigh != 0 || before.SizeLow < 32 || before.SizeLow > 4096) throw Fail("invalid-size");
      using (var stream = new FileStream(handle, FileAccess.Read)) {
        AssertPrivateAcl(stream.GetAccessControl());
        byte[] encrypted = new byte[(int)before.SizeLow];
        try {
          int count = 0;
          while (count < encrypted.Length) { int read = stream.Read(encrypted, count, encrypted.Length - count); if (read == 0) throw Fail("changed-during-read"); count += read; }
          if (stream.ReadByte() != -1 || !Same(before, Info(handle))) throw Fail("changed-during-read");
          byte[] key;
          try { key = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser); }
          catch (CryptographicException) { throw Fail("dpapi-unprotect-failed"); }
          if (key.Length != 32) { Array.Clear(key, 0, key.Length); throw Fail("invalid-key"); }
          AssertPrivateAcl(stream.GetAccessControl());
          return key;
        } finally { Array.Clear(encrypted, 0, encrypted.Length); }
      }
    }
  }
  static void CreateFirstKey(string path) {
    byte[] key = new byte[32], encrypted = null;
    string temporary = path + "." + Guid.NewGuid().ToString("N") + ".new";
    bool ownTemporary = false;
    try {
      using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(key);
      encrypted = ProtectedData.Protect(key, Entropy, DataProtectionScope.CurrentUser);
      using (var stream = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.Write,
        FileShare.None, 4096, FileOptions.WriteThrough, FileAcl())) {
        ownTemporary = true; stream.Write(encrypted, 0, encrypted.Length); stream.Flush(true);
      }
      // File.Move has no overwrite overload here. A concurrent prepare keeps
      // the winner and reads it; it never changes an already-created key.
      try { File.Move(temporary, path); ownTemporary = false; }
      catch (IOException) { using (var winner = Pin(path, false)) { } }
    } finally {
      Array.Clear(key, 0, key.Length);
      if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
      if (ownTemporary) File.Delete(temporary);
    }
  }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
  public static string Run(string operation, string digest, string expectedKeyId, string isolatedTestRoot) {
    if (operation != "prepare" && operation != "sign") throw Fail("invalid-operation");
    var root = TrustRoot(isolatedTestRoot); var path = Path.Combine(root, "signing-key.v2");
    var pinned = PinAncestry(root, operation == "prepare"); byte[] key = null;
    try {
      try { key = ReadKey(path); }
      catch (FileNotFoundException) {
        if (operation != "prepare") throw;
        CreateFirstKey(path); key = ReadKey(path);
      }
      string id;
      using (var sha = SHA256.Create()) id = Hex(sha.ComputeHash(key));
      if (!String.IsNullOrEmpty(expectedKeyId) && !String.Equals(id, expectedKeyId, StringComparison.Ordinal)) throw Fail("key-identity-changed");
      string proof = null;
      if (operation == "sign") {
        using (var hmac = new HMACSHA256(key)) proof = Hex(hmac.ComputeHash(Encoding.UTF8.GetBytes("original-motion-commit:v2:" + digest)));
      }
      AssertPrivateAcl(Directory.GetAccessControl(root));
      return "{\"keyId\":\"" + id + "\",\"protection\":\"windows_dpapi_current_user\"" +
        (proof == null ? "}" : ",\"issuerProof\":\"" + proof + "\"}");
    } finally {
      if (key != null) Array.Clear(key, 0, key.Length);
      foreach (var handle in pinned) handle.Dispose();
    }
  }
}
`;

const WINDOWS_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Security
  Add-Type -TypeDefinition $request.source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Security.dll')
  $result = [EditkinUserCommitKey]::Run($request.operation, $request.digest, $request.expectedKeyId, $request.isolatedTestRoot)
  [Console]::Out.WriteLine($result)
} catch {
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  $code = 'protected-operation-failed:' + $failure.GetType().Name
  if ($failure.Message -match '^user-commit-key:[a-z-]+$') { $code = $failure.Message }
  [Console]::Error.WriteLine($code)
  exit 1
}
`;

async function windowsPowerShellPath(): Promise<string> {
  // SystemRoot is product-host OS configuration, not a tool argument or trust
  // path override. Never search PATH or accept an arbitrary helper executable.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot) || resolve(systemRoot) !== systemRoot || systemRoot.startsWith("\\\\")) throw new Error("Windows SystemRoot unavailable");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), moduleDirectory];
  if (basename(moduleDirectory) === "security" && basename(dirname(moduleDirectory)) === "src") roots.push(resolve(moduleDirectory, "..", "..", "..", ".."));
  for (const root of roots) {
    const fromWorkspace = relative(root, executable);
    if (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace)) throw new Error("Windows signing helper cannot be a workspace executable");
  }
  const ancestors = await assertPosixAncestry(dirname(executable));
  const file = await lstat(executable);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Windows signing helper must be a regular OS file");
  await recheckPosixAncestry(ancestors);
  return executable;
}

async function windowsOperation(operation: "prepare" | "sign", digest?: string, expectedKeyId?: string, isolatedTestRoot?: string): Promise<UserCommitKeyIdentity | UserCommitDigestSignature> {
  const executable = await windowsPowerShellPath();
  const request = JSON.stringify({ source: WINDOWS_KEY_HELPER, operation, digest: digest ?? null, expectedKeyId: expectedKeyId ?? null, isolatedTestRoot: isolatedTestRoot ?? null });
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_COMMAND], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", diagnostic = "", size = 0, settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error("User commit signing key operation timed out")); }, 15_000);
    function finish(error?: Error, result?: UserCommitKeyIdentity | UserCommitDigestSignature) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolveResult(result!);
    }
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 8192) { child.kill(); finish(new Error("User commit signing key returned oversized metadata")); }
      else output += data.toString("utf8");
    });
    // Never expose helper stderr, encrypted blobs or plaintext in application
    // logs. A failed DPAPI/ACL/safe-open operation is a hard authentication fail.
    child.stderr.on("data", (data: Buffer) => {
      // Keep only a small explicit helper error code, never PowerShell's full
      // diagnostic/source dump. This contains no paths, key bytes or payload.
      const match = data.toString("utf8").match(/(?:user-commit-key:[a-z-]+|protected-operation-failed:[A-Za-z]+)/);
      if (match) diagnostic = match[0];
    });
    child.on("error", () => finish(new Error("Windows protected user signing key helper unavailable")));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`Windows protected user signing key operation failed (${diagnostic || "missing, damaged or unsafe store"})`));
      try {
        const result = JSON.parse(output) as UserCommitDigestSignature;
        const keys = Object.keys(result).sort().join(",");
        if (keys !== (operation === "sign" ? "issuerProof,keyId,protection" : "keyId,protection") || !DIGEST.test(result.keyId)
          || result.protection !== "windows_dpapi_current_user" || (operation === "sign" && !DIGEST.test(result.issuerProof))) throw new Error();
        if (expectedKeyId !== undefined && result.keyId !== expectedKeyId) throw new Error();
        finish(undefined, result);
      } catch { finish(new Error("Windows protected user signing key metadata rejected")); }
    });
    child.stdin.on("error", () => { /* close/error reports failure without dumping request */ });
    child.stdin.end(request);
  });
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
async function assertPosixAncestry(root: string): Promise<Array<{ path: string; stat: Stats }>> {
  const paths: string[] = [];
  for (let current = root; ; current = dirname(current)) { paths.unshift(current); if (dirname(current) === current) break; }
  const result = [];
  for (const path of paths) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("User commit key directory link rejected");
    result.push({ path, stat });
  }
  return result;
}
async function recheckPosixAncestry(before: Array<{ path: string; stat: Stats }>): Promise<void> {
  for (const entry of before) {
    const after = await lstat(entry.path);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(entry.stat, after)) throw new Error("User commit key directory changed");
  }
}
async function preparePosixDirectory(root: string): Promise<void> {
  const paths: string[] = [];
  for (let current = root; ; current = dirname(current)) { paths.unshift(current); if (dirname(current) === current) break; }
  for (const path of paths) {
    try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("User commit key directory link rejected"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700); }
      catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("User commit key directory link rejected");
    }
  }
}
async function posixKey(root: string, prepare: boolean): Promise<Buffer> {
  const uid = userInfo().uid;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("User commit key OS identity unavailable");
  if (prepare) await preparePosixDirectory(root);
  const ancestry = await assertPosixAncestry(root);
  const rootStat = ancestry[ancestry.length - 1].stat;
  if (rootStat.uid !== uid || (rootStat.mode & 0o777) !== 0o700) throw new Error("User commit key directory must be owner-only");
  const path = join(root, KEY_FILE);
  async function read(): Promise<Buffer> {
    const unsafe = "User commit key file is damaged or unsafe";
    // Open first, then bind the path to the opened inode. A check made before
    // opening could describe a different file from the one that is read.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ELOOP" || error.code === "EISDIR" ? new Error(unsafe) : error;
    });
    let bytes: Buffer | undefined;
    try {
      let opened = await handle.stat();
      // A creator atomically publishes a complete private file via link, then
      // removes its temporary link. Concurrent prepare may wait for that precise
      // two-link state; sign and every other unsafe state remain fail-closed.
      if (prepare && opened.nlink === 2) {
        const published = opened;
        for (let attempt = 0; attempt < 30 && opened.nlink === 2; attempt++) {
          if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o777) !== 0o600
            || opened.size !== 32 || opened.mtimeMs !== published.mtimeMs) throw new Error(unsafe);
          await recheckPosixAncestry(ancestry);
          await new Promise((done) => setTimeout(done, 10));
          opened = await handle.stat();
        }
        if (opened.mtimeMs !== published.mtimeMs) throw new Error("User commit key initialization changed");
      }
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size !== 32) throw new Error(unsafe);
      if (!sameFile(before, opened) || opened.nlink !== 1 || opened.size !== 32 || opened.uid !== uid || (opened.mode & 0o777) !== 0o600) throw new Error("User commit key file changed");
      bytes = Buffer.alloc(32);
      const result = await handle.read(bytes, 0, 32, 0);
      const extra = await handle.read(Buffer.alloc(1), 0, 1, 32);
      const after = await handle.stat();
      const leafAfter = await lstat(path);
      if (result.bytesRead !== 32 || extra.bytesRead !== 0 || !sameFile(opened, after) || !sameFile(opened, leafAfter)
        || after.nlink !== 1 || after.size !== 32 || after.mtimeMs !== opened.mtimeMs || (leafAfter.mode & 0o777) !== 0o600) throw new Error("User commit key file changed");
      await recheckPosixAncestry(ancestry);
      return bytes;
    } catch (error) { bytes?.fill(0); throw error; }
    finally { await handle.close(); }
  }
  try { return await read(); }
  catch (error) { if (!prepare || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(root, `${KEY_FILE}.${randomBytes(16).toString("hex")}.new`);
  const key = randomBytes(32);
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    ownsTemporary = true;
    try { await handle.chmod(0o600); await handle.writeFile(key); await handle.sync(); }
    finally { await handle.close(); }
    await recheckPosixAncestry(ancestry);
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    key.fill(0);
    if (ownsTemporary) await unlink(temporary);
  }
  // The atomic no-overwrite link is fully written before publication. A
  // concurrent prepare can briefly observe the winner's second temporary link;
  // wait for its unlink, never replace or regenerate the winner.
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await lstat(path);
    if (current.nlink !== 2) return read();
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("User commit key initialization did not finish");
}

function posixTrustRoot(): string {
  const home = userInfo().homedir;
  if (!home || !isAbsolute(home)) throw new Error("User commit key OS home unavailable");
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Editkin", "Trust", "original-motion-commit-v2")
    : join(home, ".local", "share", "Editkin", "Trust", "original-motion-commit-v2");
}

/* Private construction is also exercised by an isolated test entry appended to
 * an exact source copy. No trust path override is exported or read from ENV. */
function createUserCommitSigningKeyStore(isolatedTestRoot?: string) {
  if (isolatedTestRoot !== undefined && (!isAbsolute(isolatedTestRoot) || resolve(isolatedTestRoot) !== isolatedTestRoot || parse(isolatedTestRoot).root === isolatedTestRoot)) throw new Error("Isolated key test root rejected");
  async function prepare(): Promise<UserCommitKeyIdentity> {
    if (process.platform === "win32") return windowsOperation("prepare", undefined, undefined, isolatedTestRoot);
    const key = await posixKey(isolatedTestRoot ?? posixTrustRoot(), true);
    try { return { keyId: createHash("sha256").update(key).digest("hex"), protection: "posix_owner_only" }; }
    finally { key.fill(0); }
  }
  async function sign(receiptSha256: string, expectedKeyId?: string): Promise<UserCommitDigestSignature> {
    if (!DIGEST.test(receiptSha256) || (expectedKeyId !== undefined && !DIGEST.test(expectedKeyId))) throw new Error("User commit signing requires SHA-256 identities");
    if (process.platform === "win32") return windowsOperation("sign", receiptSha256, expectedKeyId, isolatedTestRoot) as Promise<UserCommitDigestSignature>;
    const key = await posixKey(isolatedTestRoot ?? posixTrustRoot(), false);
    try {
      const keyId = createHash("sha256").update(key).digest("hex");
      if (expectedKeyId !== undefined && expectedKeyId !== keyId) throw new Error("User commit signing key identity changed");
      return { keyId, protection: "posix_owner_only", issuerProof: createHmac("sha256", key).update(`${DOMAIN}${receiptSha256}`).digest("hex") };
    } finally { key.fill(0); }
  }
  return { prepare, sign };
}

const userStore = createUserCommitSigningKeyStore();
/** Explicit preflight: create the OS user's first protected key, or validate
 * the existing key. A damaged or unsafe existing file is never replaced. */
export function prepareUserCommitSigningKey(): Promise<UserCommitKeyIdentity> { return userStore.prepare(); }
/** Read-only authentication operation. Missing keys do not create a new store. */
export function signUserCommitDigest(receiptSha256: string, expectedKeyId?: string): Promise<UserCommitDigestSignature> { return userStore.sign(receiptSha256, expectedKeyId); }
