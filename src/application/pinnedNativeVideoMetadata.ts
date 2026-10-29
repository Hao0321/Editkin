// Node-only selected renderer metadata probe. The serving renderer has a
// separate lifetime and is not protected by this operation.
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ExecutableIdentity { executableSha256: string; executableBytes: number }
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 2 * 1024 ** 3;
const HELPER_TIMEOUT_MS = 20_000;

// Uses the existing protected signing helper's CreateFileW pin pattern. The
// operation owns every pin and the fixed child; it exposes no command runner.
const WINDOWS_PINNED_METADATA_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class EditkinPinnedNativeVideoMetadata {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

  const int OutputLimit = 65536, ChildTimeoutMs = 5000;
  const uint Reparse = 0x400, DirectoryAttribute = 0x10;
  static Exception Fail(string code) { return new InvalidOperationException("selected-native-metadata:" + code); }
  static FileInfo Info(SafeFileHandle handle) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info)) throw Fail("handle-info-unavailable");
    return info;
  }
  static bool Same(FileInfo a, FileInfo b) {
    return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow
      && a.Attributes == b.Attributes && a.Links == b.Links
      && a.SizeHigh == b.SizeHigh && a.SizeLow == b.SizeLow
      && a.Creation.dwHighDateTime == b.Creation.dwHighDateTime && a.Creation.dwLowDateTime == b.Creation.dwLowDateTime
      && a.Write.dwHighDateTime == b.Write.dwHighDateTime && a.Write.dwLowDateTime == b.Write.dwLowDateTime;
  }
  static SafeFileHandle Pin(string path, bool directory) {
    // Both ancestors and the leaf permit only READ sharing. Ancestor write
    // sharing would permit in-place reparse mutation without a rename.
    var handle = CreateFileW(path, directory ? 0x80u : 0x80000000u,
      1u, IntPtr.Zero, 3u,
      0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw Fail("safe-open-failed"); }
    try {
      var info = Info(handle);
      if ((info.Attributes & Reparse) != 0 || ((info.Attributes & DirectoryAttribute) != 0) != directory
        || (!directory && info.Links != 1)) throw Fail("link-or-file-type-rejected");
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  static string LocalCanonicalPath(string path) {
    if (String.IsNullOrEmpty(path) || path.Length < 4 || !Char.IsLetter(path[0])
      || path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0
      || path.IndexOf('/') >= 0 || path.IndexOf('\0') >= 0) throw Fail("local-absolute-path-required");
    var full = Path.GetFullPath(path);
    if (!String.Equals(full, path, StringComparison.OrdinalIgnoreCase)) throw Fail("canonical-path-required");
    foreach (var component in path.Substring(3).Split('\\')) {
      if (component.Length == 0 || component.EndsWith(".", StringComparison.Ordinal)
        || component.EndsWith(" ", StringComparison.Ordinal)) throw Fail("canonical-path-required");
    }
    return full;
  }
  static List<SafeFileHandle> PinExistingAncestry(string directory) {
    var paths = new Stack<string>(); var next = directory;
    while (next != null) { paths.Push(next); var parent = Path.GetDirectoryName(next); next = String.IsNullOrEmpty(parent) ? null : parent; }
    var pinned = new List<SafeFileHandle>();
    try {
      while (paths.Count > 0) pinned.Add(Pin(paths.Pop(), true));
      return pinned;
    } catch { foreach (var handle in pinned) handle.Dispose(); throw; }
  }
  static SafeFileHandle ChildJob() {
    var job = CreateJobObjectW(IntPtr.Zero, null);
    if (job.IsInvalid) { job.Dispose(); throw Fail("child-job-unavailable"); }
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      job.Dispose(); throw Fail("child-job-unavailable");
    }
    return job;
  }
  sealed class PipeDrain {
    readonly Stream stream; readonly bool retain;
    public readonly Task Completion;
    public int Overflow, Failed;
    public byte[] Bytes;
    public PipeDrain(Stream input, bool keep) {
      stream = input; retain = keep;
      Completion = Task.Factory.StartNew(Read, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }
    void Read() {
      var buffer = new byte[4096]; int count = 0;
      using (var kept = new MemoryStream()) {
        try {
          while (true) {
            int n = stream.Read(buffer, 0, buffer.Length); if (n == 0) break;
            if (count > OutputLimit - n) Interlocked.Exchange(ref Overflow, 1);
            else { count += n; if (retain && Volatile.Read(ref Overflow) == 0) kept.Write(buffer, 0, n); }
          }
          if (retain) Bytes = kept.ToArray();
        } catch { Interlocked.Exchange(ref Failed, 1); }
      }
    }
    public void Close() { try { stream.Dispose(); } catch { } }
  }
  static void KillAndWait(Process child, SafeFileHandle job, bool started) {
    if (child == null || !started) return;
    try {
      if (!child.HasExited) {
        if (job != null && !job.IsInvalid) TerminateJobObject(job, 1);
        if (!child.HasExited) child.Kill();
      }
      // A successful kill is not completion. Keep the pins until the direct
      // child has actually exited; outer helper death closes its kill job.
      child.WaitForExit();
    } catch { throw Fail("child-cleanup-failed"); }
  }
  static void FinishDrains(PipeDrain output, PipeDrain diagnostic) {
    if (output == null || diagnostic == null) return;
    var tasks = new Task[] { output.Completion, diagnostic.Completion };
    if (!Task.WaitAll(tasks, 1000)) {
      output.Close(); diagnostic.Close();
      if (!Task.WaitAll(tasks, 1000)) throw Fail("child-pipe-close-failed");
      throw Fail("child-pipe-eof-unavailable");
    }
    if (Volatile.Read(ref output.Overflow) != 0 || Volatile.Read(ref diagnostic.Overflow) != 0) throw Fail("child-output-overflow");
    if (Volatile.Read(ref output.Failed) != 0 || Volatile.Read(ref diagnostic.Failed) != 0) throw Fail("child-output-unavailable");
  }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
  public static string Run(string executablePath, string expectedSha256, long expectedBytes) {
    if (expectedSha256 == null || expectedSha256.Length != 64) throw Fail("expected-identity-invalid");
    foreach (char c in expectedSha256) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw Fail("expected-identity-invalid");
    if (expectedBytes <= 0 || expectedBytes > 2147483648L) throw Fail("expected-identity-invalid");
    var path = LocalCanonicalPath(executablePath);
    var ancestors = PinExistingAncestry(Path.GetDirectoryName(path));
    Process child = null; SafeFileHandle job = null; PipeDrain output = null, diagnostic = null;
    bool started = false;
    try {
      using (var handle = Pin(path, false)) {
        var before = Info(handle);
        long size = ((long)before.SizeHigh << 32) | before.SizeLow;
        if (size != expectedBytes) throw Fail("pinned-executable-identity-mismatch");
        using (var stream = new FileStream(handle, FileAccess.Read)) {
          string actual;
          using (var sha = SHA256.Create()) actual = Hex(sha.ComputeHash(stream));
          if (stream.Position != size || !Same(before, Info(handle)) || actual != expectedSha256) throw Fail("pinned-executable-identity-mismatch");
          job = ChildJob();
          // OWNED_FIXTURE_BARRIER_AFTER_PINNED_HASH
          child = new Process();
          child.StartInfo = new ProcessStartInfo {
            FileName = path, Arguments = "video-runtime-identity", UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            RedirectStandardInput = true
          };
          try {
            var lifetime = Stopwatch.StartNew();
            if (!child.Start()) throw Fail("child-start-failed");
            started = true;
            // Process.Start precedes job assignment. This is not an atomic
            // suspended launch or a process-tree containment certification.
            if (!AssignProcessToJobObject(job, child.Handle)) throw Fail("child-job-assignment-failed");
            child.StandardInput.Close();
            output = new PipeDrain(child.StandardOutput.BaseStream, true);
            diagnostic = new PipeDrain(child.StandardError.BaseStream, false);
            while (!child.WaitForExit(10)) {
              if (lifetime.ElapsedMilliseconds >= ChildTimeoutMs) throw Fail("child-timed-out");
              if (Volatile.Read(ref output.Overflow) != 0 || Volatile.Read(ref diagnostic.Overflow) != 0) throw Fail("child-output-overflow");
              if (Volatile.Read(ref output.Failed) != 0 || Volatile.Read(ref diagnostic.Failed) != 0) throw Fail("child-output-unavailable");
            }
            if (lifetime.ElapsedMilliseconds >= ChildTimeoutMs) throw Fail("child-timed-out");
            if (child.ExitCode != 0) throw Fail("child-exited-unsuccessfully");
            // A successful direct child must not leave pipe-holding descendants.
            if (!TerminateJobObject(job, 1)) throw Fail("child-job-cleanup-failed");
            FinishDrains(output, diagnostic);
            // OWNED_FIXTURE_BARRIER_AFTER_CHILD_EXIT
            if (!Same(before, Info(handle))) throw Fail("pinned-executable-changed");
            if (output.Bytes == null || output.Bytes.Length == 0 || output.Bytes.Length > OutputLimit) throw Fail("child-metadata-empty");
            return new UTF8Encoding(false, true).GetString(output.Bytes);
          } finally {
            try { KillAndWait(child, job, started); }
            finally {
              if (output != null) output.Close();
              if (diagnostic != null) diagnostic.Close();
              // Process and kill-job ownership end while file/ancestor pins are held.
              if (child != null) child.Dispose();
              if (job != null) { job.Dispose(); job = null; }
            }
          }
        }
      }
    } finally {
      if (job != null) job.Dispose();
      foreach (var handle in ancestors) handle.Dispose();
    }
  }
}
`;

const WINDOWS_PINNED_METADATA_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition $request.source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll')
  $result = [EditkinPinnedNativeVideoMetadata]::Run($request.executablePath, $request.executableSha256, $request.executableBytes)
  [Console]::Out.Write($result)
} catch {
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  $code = 'selected-native-metadata:protected-operation-failed'
  if ($failure.Message -match '^selected-native-metadata:[a-z-]+$') { $code = $failure.Message }
  [Console]::Error.WriteLine($code)
  exit 1
}
`;

async function trustedWindowsPowerShellPath(): Promise<string> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot) || resolve(systemRoot) !== systemRoot || systemRoot.startsWith("\\\\")) {
    throw new Error("Windows protected metadata helper requires the OS SystemRoot");
  }
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const root of [process.cwd(), moduleDirectory]) {
    const fromWorkspace = relative(root, executable);
    if (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace)) throw new Error("Windows metadata helper cannot be a workspace executable");
  }
  const ancestry: Array<{ path: string; dev: number; ino: number }> = [];
  for (let current = dirname(executable); ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)).toLowerCase() !== resolve(current).toLowerCase()) {
      throw new Error("Windows metadata helper ancestry must be regular OS directories");
    }
    ancestry.push({ path: current, dev: info.dev, ino: info.ino });
    if (dirname(current) === current) break;
  }
  const leaf = await lstat(executable);
  if (!leaf.isFile() || leaf.isSymbolicLink() || (await realpath(executable)).toLowerCase() !== resolve(executable).toLowerCase()) {
    throw new Error("Windows metadata helper must be a regular OS file");
  }
  for (const before of ancestry) {
    const info = await lstat(before.path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino) {
      throw new Error("Windows metadata helper OS ancestry changed");
    }
  }
  return executable;
}

/** Only this fixed metadata operation is exposed. Hash/size come from the
 * selected file's full-byte identity, never from its metadata response. */
export async function executePinnedNativeVideoMetadata(executablePath: string, expected: ExecutableIdentity): Promise<string> {
  if (process.platform !== "win32") throw new Error("Selected native renderer protected metadata execution requires Windows");
  if (typeof executablePath !== "string" || !/^[a-z]:\\/i.test(executablePath) || executablePath.includes("/")
    || executablePath.includes("\0") || resolve(executablePath).toLowerCase() !== executablePath.toLowerCase()) {
    throw new Error("Selected native renderer metadata path must be canonical and local absolute");
  }
  if (!expected || typeof expected.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.executableSha256) || !Number.isSafeInteger(expected.executableBytes)
    || expected.executableBytes < 1 || expected.executableBytes > MAX_EXECUTABLE_BYTES) {
    throw new Error("Selected native renderer protected metadata requires its full-byte identity");
  }
  const executable = await trustedWindowsPowerShellPath();
  const request = JSON.stringify({ source: WINDOWS_PINNED_METADATA_SOURCE, executablePath,
    executableSha256: expected.executableSha256, executableBytes: expected.executableBytes });
  return new Promise<string>((resolveResult, reject) => {
    const host = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_PINNED_METADATA_COMMAND], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0, diagnostic = "", failure: Error | undefined, settled = false;
    const timer = setTimeout(() => {
      failure ??= new Error("Selected native renderer protected metadata helper timed out");
      host.kill();
    }, HELPER_TIMEOUT_MS);
    const finish = (error?: Error, text?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolveResult(text!);
    };
    host.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > MAX_METADATA_BYTES) {
        failure ??= new Error("Selected native renderer protected metadata exceeds 64 KiB");
        host.kill();
      } else chunks.push(data);
    });
    // Drain continuously, retain only one short allowlisted code. Paths,
    // executable stderr and PowerShell source/diagnostics are not surfaced.
    host.stderr.on("data", (data: Buffer) => {
      const code = data.toString("utf8").match(/selected-native-metadata:[a-z-]+/);
      if (code && code[0].length <= 120) diagnostic = code[0];
    });
    host.on("error", () => finish(new Error("Windows protected metadata helper unavailable")));
    host.on("close", code => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new Error(`Windows protected metadata operation failed (${diagnostic || "selected-native-metadata:protected-operation-failed"})`));
      try { finish(undefined, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { finish(new Error("Windows protected metadata operation returned invalid UTF-8")); }
    });
    host.stdin.on("error", () => { /* host close/error owns the result */ });
    host.stdin.end(request);
  });
}
