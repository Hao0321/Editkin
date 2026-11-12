$ErrorActionPreference = 'Stop'
$script:PortableResourcePaths = @(
  'resources\agent-runtime-v3\opencode.exe',
  'resources\runtime\models\ggml-small-q5_1.bin',
  'resources\fonts\LXGWWenKaiMonoTC-Regular.ttf',
  'resources\fonts\NotoSansTC[wght].ttf',
  'resources\fonts\NotoSerifTC[wght].ttf'
)
$script:PortablePreviewPattern = '^portable-preview-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$'
if (-not ('PortableResourceStorage' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class PortableFileIdentity { public string Id; public uint Links; public long Bytes; }
public static class PortableResourceStorage {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateHardLinkW(string path, string source, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReplaceFileW(string path, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  public static PortableFileIdentity Identity(string path) {
    using (var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      Info info; if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new PortableFileIdentity { Id=info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8"), Links=info.Links, Bytes=((long)info.SizeHigh<<32)|info.SizeLow };
    }
  }
  public static void Link(string path, string source) { if (!CreateHardLinkW(path, source, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  // Native literal paths preserve [] font names; a backup is retained until bytes and identity are verified.
  // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew
  public static void Replace(string path, string replacement, string backup) {
    if (!ReplaceFileW(path, replacement, backup, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
}
function Get-PortableArtifactRoot([string]$ScriptRoot, [string]$TestArtifactRoot) {
  $project = [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..')).TrimEnd('\')
  if ([IO.Path]::GetFileName($project) -ne 'editkin-autopilot') { throw 'Unexpected project directory' }
  $root = [IO.Path]::GetFullPath((Join-Path $project '..\artifacts\autopilot-desk')).TrimEnd('\')
  if ($TestArtifactRoot) {
    $fixture = [IO.Path]::GetFullPath($TestArtifactRoot).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($fixture) -ne $root -or [IO.Path]::GetFileName($fixture) -notmatch '^resource-dedup-self-test-[a-z0-9]+$') { throw 'Unsafe test artifact root' }
    $root = $fixture
  }
  Assert-PortableRegular $root $true | Out-Null
  if ((New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($root))).DriveFormat -ne 'NTFS') { throw 'Resource compaction requires the verified local NTFS volume' }
  return $root
}
function Assert-PortableRegular([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Storage path is not a regular file or directory' }
  return $item
}
function Assert-PortableResource([string]$Root, [string]$Name, [string]$RelativePath, [bool]$AllowMissing = $false) {
  if ($Name -notmatch $script:PortablePreviewPattern -or $script:PortableResourcePaths -notcontains $RelativePath) { throw 'Resource is outside the immutable allowlist' }
  $package = [IO.Path]::GetFullPath((Join-Path $Root $Name)).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($package) -ne $Root) { throw 'Package escaped artifact root' }
  Assert-PortableRegular $package $true | Out-Null
  $path = [IO.Path]::GetFullPath((Join-Path $package $RelativePath))
  if (-not $path.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Resource escaped package' }
  $parent = [IO.Path]::GetDirectoryName($path)
  while ($parent -ne $Root) { Assert-PortableRegular $parent $true | Out-Null; $parent = [IO.Path]::GetDirectoryName($parent) }
  if (-not $AllowMissing -or (Test-Path -LiteralPath $path)) { Assert-PortableRegular $path $false | Out-Null }
  return $path
}
function Get-PortableRunningNames([string]$Root, [string[]]$Names) {
  $running = @()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.Name -eq 'AutopilotDesk-Community-Preview.exe' -and -not $process.ExecutablePath) { throw 'Preview process path is unavailable' }
    foreach ($name in $Names) {
      $prefix = (Join-Path $Root $name).TrimEnd('\') + '\'
      if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
          ($process.CommandLine -and $process.CommandLine.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { $running += $name }
    }
  }
  return @($running | Sort-Object -Unique)
}
function Get-PortableLoadedIdentities([string]$Root) {
  $prefix = $Root.TrimEnd('\') + '\'
  $loaded = @{}
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      Assert-PortableRegular $process.ExecutablePath $false | Out-Null
      $loaded[([PortableResourceStorage]::Identity($process.ExecutablePath)).Id] = $true
    }
  }
  return $loaded
}
function Assert-PortableObjectRoot([string]$Root, [bool]$Create) {
  $recovery = Join-Path $Root 'portable-preview-recovery'
  $objects = Join-Path $recovery 'objects'
  if ($Create) { New-Item -ItemType Directory -Path $objects -Force | Out-Null }
  foreach ($path in @($recovery, $objects)) { if (Test-Path -LiteralPath $path) { Assert-PortableRegular $path $true | Out-Null } }
  return $objects
}
function Get-PortableHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
function Get-PortableWorkflowHashes([string]$Root) {
  $paths = @(rg --files --hidden --no-ignore -g 'workflow-state.json' -g '!**/resources/**' -g '!**/webview2/**' -g '!**/cache/**' -g '!**/node_modules/**' $Root)
  if ($LASTEXITCODE -notin @(0, 1)) { throw 'Workflow inventory failed' }
  return @($paths | ForEach-Object { [pscustomobject]@{path=$_;sha256=Get-PortableHash $_} })
}
function Assert-PortableWorkflowHashes($Entries) { foreach ($entry in $Entries) { if ((Get-PortableHash $entry.path) -ne $entry.sha256) { throw 'Original workflow bytes changed' } } }
function Undo-PortableReplacement([string]$Target, [string]$Backup, [string]$Sha256) {
  if (Test-Path -LiteralPath $Backup) {
    Assert-PortableRegular $Backup $false | Out-Null
    if ((Get-PortableHash $Backup) -ne $Sha256) { throw 'Original transaction backup is corrupt; retain all transaction files' }
    if (Test-Path -LiteralPath $Target) { [PortableResourceStorage]::Replace($Target, $Backup, $null) }
    else { Move-Item -LiteralPath $Backup -Destination $Target }
  }
  if (-not (Test-Path -LiteralPath $Target) -or (Get-PortableHash $Target) -ne $Sha256) { throw 'Transaction rollback is unverified; retain all transaction files' }
}
