param(
  [ValidateRange(1, 20)][int]$Keep = 3,
  [string[]]$Discard = @(),
  [switch]$OnlyDiscard,
  [switch]$Apply,
  [string]$TestArtifactRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
if (-not ('EditkinPreviewRecoveryLinks' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class EditkinPreviewRecoveryLinks {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateHardLinkW(string path, string target, IntPtr security);
  public static void Create(string path, string target) {
    if (!CreateHardLinkW(path, target, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if ([IO.Path]::GetFileName($projectRoot) -ne 'editkin-autopilot') { throw 'Unexpected project directory' }
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..')).TrimEnd('\')
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'artifacts\autopilot-desk')).TrimEnd('\')
if ($TestArtifactRoot) {
  $testPath = [IO.Path]::GetFullPath($TestArtifactRoot).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($testPath) -ne $artifactRoot -or [IO.Path]::GetFileName($testPath) -notmatch '^prune-self-test-[a-z0-9-]+$') {
    throw 'Test artifact root must be an isolated prune-self-test directory under the artifact root'
  }
  $artifactRoot = $testPath
}
$rootItem = Get-Item -LiteralPath $artifactRoot -ErrorAction Stop
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Artifact root is not a regular directory' }

$pattern = '^portable-preview-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$'
$previews = @(Get-ChildItem -LiteralPath $artifactRoot -Directory -Force | Where-Object { $_.Name -match $pattern -and -not (Test-Path -LiteralPath (Join-Path $_.FullName 'ARCHIVED-KIT-SOURCE.json')) } | Sort-Object Name -Descending)
foreach ($name in $Discard) {
  if ($name -notmatch $pattern -or $previews.Name -notcontains $name) { throw "Discard name is not an existing portable preview: $name" }
}
if ($OnlyDiscard -and $Discard.Count -eq 0) { throw 'OnlyDiscard requires explicit preview names' }
$eligible = @($previews | Where-Object { $Discard -notcontains $_.Name })
$kept = @($eligible | Select-Object -First $Keep)
$obsolete = if ($OnlyDiscard) { @($previews | Where-Object { $Discard -contains $_.Name }) }
  else { @($previews | Where-Object { $kept.Name -notcontains $_.Name }) }
function Get-PreviewProtection {
  $runningNames = @()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.Name -eq 'AutopilotDesk-Community-Preview.exe' -and -not $process.ExecutablePath) {
      throw 'A running preview has no readable executable path'
    }
    if (-not $process.ExecutablePath) { continue }
    foreach ($preview in $previews) {
      if ($process.ExecutablePath.StartsWith($preview.FullName.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $runningNames += $preview.Name
      }
    }
  }
  # Read only durable workflow state, never credentials, caches or media.
  $statePaths = @(rg --files --hidden --no-ignore -g 'workflow-state.json' -g '!**/resources/**' -g '!**/webview2/**' -g '!**/cache/**' -g '!**/node_modules/**' $artifactRoot)
  if ($LASTEXITCODE -notin @(0, 1)) { throw 'Could not inventory Kit workflow bindings' }
  $pinnedNames = @()
  foreach ($statePath in $statePaths) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $skillPath = $state.governance.skill_path
    if (-not $skillPath) { continue }
    if (-not [IO.Path]::IsPathRooted($skillPath)) { throw "Unresolved Kit skill path in $statePath" }
    $skillPath = [IO.Path]::GetFullPath($skillPath)
    foreach ($preview in $previews) {
      if ($skillPath.StartsWith($preview.FullName.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $pinnedNames += $preview.Name
      }
    }
  }
  return [pscustomobject]@{ Running = @($runningNames | Sort-Object -Unique); Pinned = @($pinnedNames | Sort-Object -Unique) }
}
$protection = Get-PreviewProtection
$protected = @($obsolete | Where-Object { $protection.Running -contains $_.Name -or $protection.Pinned -contains $_.Name })
$targets = @($obsolete | Where-Object { $protected.Name -notcontains $_.Name })

function Assert-PreviewTarget([IO.DirectoryInfo]$Directory) {
  $resolved = [IO.Path]::GetFullPath($Directory.FullName).TrimEnd('\')
  $parent = [IO.Path]::GetDirectoryName($resolved).TrimEnd('\')
  if (-not [string]::Equals($parent, $artifactRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Preview escaped artifact root: $resolved" }
  if ($Directory.Name -notmatch $pattern) { throw "Unexpected preview name: $resolved" }
  if ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Preview is a reparse point: $resolved" }
  $nestedLink = Get-ChildItem -LiteralPath $resolved -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
  if ($nestedLink) { throw "Preview contains a reparse point: $resolved" }
  return $resolved
}

$entries = @()
foreach ($directory in $targets) {
  $path = Assert-PreviewTarget $directory
  $files = @(Get-ChildItem -LiteralPath $path -File -Force -Recurse)
  $exe = Join-Path $path 'AutopilotDesk-Community-Preview.exe'
  $entries += [pscustomobject]@{
    name = $directory.Name
    bytes = [long](($files | Measure-Object Length -Sum).Sum)
    files = $files.Count
    exeSha256 = if (Test-Path -LiteralPath $exe -PathType Leaf) { (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  }
}
$plannedBytes = [long](($entries | Measure-Object Bytes -Sum).Sum)
$summary = [ordered]@{
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  totalVersions = $previews.Count
  selectionMode = if ($OnlyDiscard) { 'explicit-only' } else { 'keep-latest' }
  keepLatest = @($kept | ForEach-Object Name)
  discardRequested = @($Discard)
  protectedRunning = @($protection.Running)
  protectedWorkflow = @($protection.Pinned)
  obsoleteCount = $targets.Count
  plannedGiB = [math]::Round($plannedBytes / 1GB, 2)
}
if (-not $Apply -or $targets.Count -eq 0) { $summary | ConvertTo-Json -Compress; return }

$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$manifestPath = Join-Path $artifactRoot "portable-preview-prune-$timestamp.json"
$manifest = [ordered]@{
  schema = 'editkin-portable-preview-prune/v1'
  createdAtUtc = [DateTime]::UtcNow.ToString('o')
  projectCommit = (git -C $projectRoot rev-parse HEAD).Trim()
  rebuildCommand = 'npm run desk:portable-preview'
  keepLatest = $summary.keepLatest
  discardRequested = $summary.discardRequested
  selectionMode = $summary.selectionMode
  protectedRunning = $summary.protectedRunning
  protectedWorkflow = $summary.protectedWorkflow
  planned = $entries
  deleted = @()
  status = 'planned'
}
($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Prune manifest was not saved' }

$deletedBytes = 0L
$reclaimedBytes = 0L
$recoveryAddedBytes = 0L
$accountedRecoveryHashes = @{}
$recoveryRoot = Join-Path $artifactRoot 'portable-preview-recovery'
$objectsRoot = Join-Path $recoveryRoot 'objects'
New-Item -ItemType Directory -Path $objectsRoot -Force | Out-Null
if ((Get-Item -LiteralPath $recoveryRoot).Attributes -band [IO.FileAttributes]::ReparsePoint -or
    (Get-Item -LiteralPath $objectsRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Recovery directory is a reparse point' }
$retained = @($previews | Where-Object { $targets.Name -notcontains $_.Name })
foreach ($directory in $retained) { Assert-PreviewTarget $directory | Out-Null }
try {
  foreach ($entry in $entries) {
    $directory = Get-Item -LiteralPath (Join-Path $artifactRoot $entry.name) -ErrorAction Stop
    $path = Assert-PreviewTarget $directory
    # Protect a process or workflow created since the initial inventory as well.
    $currentProtection = Get-PreviewProtection
    if ($currentProtection.Running -contains $entry.name -or $currentProtection.Pinned -contains $entry.name) {
      throw "Preview became protected before deletion: $($entry.name)"
    }
    $recoveryFiles = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $path -File -Force -Recurse)) {
      $relative = $file.FullName.Substring($path.Length + 1)
      $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $object = Join-Path $objectsRoot $hash
      $objectExists = Test-Path -LiteralPath $object -PathType Leaf
      if (-not $objectExists -or -not $accountedRecoveryHashes.ContainsKey($hash)) {
        # Share immutable matching bytes with a retained package; unique files stay recoverable.
        $linkSource = $file.FullName
        $shared = $false
        foreach ($preview in $retained) {
          $candidate = Join-Path $preview.FullName $relative
          if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Get-Item -LiteralPath $candidate).Length -eq $file.Length -and
              (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash) {
            $linkSource = $candidate
            $shared = $true
            break
          }
        }
        # Native literal paths avoid PowerShell treating font names containing [] as wildcards.
        if (-not $objectExists) { [EditkinPreviewRecoveryLinks]::Create($object, $linkSource) }
        if (-not $shared -and -not $accountedRecoveryHashes.ContainsKey($hash)) { $recoveryAddedBytes += $file.Length }
        $accountedRecoveryHashes[$hash] = $true
      }
      $objectItem = Get-Item -LiteralPath $object
      if ($objectItem.Attributes -band [IO.FileAttributes]::ReparsePoint -or $objectItem.Length -ne $file.Length -or
          (Get-FileHash -LiteralPath $object -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
        throw "Recovery object failed verification: $hash"
      }
      $recoveryFiles += [pscustomobject]@{ path = $relative; sha256 = $hash; bytes = $file.Length }
    }
    $recoveryManifest = Join-Path $recoveryRoot "$($entry.name).json"
    $backup = [ordered]@{ schema = 'editkin-portable-preview-recovery/v1'; name = $entry.name; files = $recoveryFiles }
    if (Test-Path -LiteralPath $recoveryManifest) {
      Assert-PortableRegular $recoveryManifest $false | Out-Null
      $existing=Get-Content -LiteralPath $recoveryManifest -Raw -Encoding UTF8|ConvertFrom-Json
      if($existing.schema -ne $backup.schema -or $existing.name -ne $entry.name -or @($existing.files).Count -ne $recoveryFiles.Count){throw 'Existing recovery manifest differs; preserve the package'}
      $expected=@{};foreach($file in $recoveryFiles){$expected[$file.path]=$file}
      $seen=@{}
      foreach($file in $existing.files){
        if(-not $expected.ContainsKey($file.path) -or $seen.ContainsKey($file.path) -or
          $file.sha256 -ne $expected[$file.path].sha256 -or $file.bytes -ne $expected[$file.path].bytes){throw 'Existing recovery manifest differs; preserve the package'}
        $seen[$file.path]=$true
      }
      $entry|Add-Member -NotePropertyName reusedExistingBackup -NotePropertyValue $true
    } else {
      ($backup | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $recoveryManifest -Encoding UTF8
    }
    $recoveryManifestHash=Get-PortableHash $recoveryManifest
    $verifiedBackup = Get-Content -LiteralPath $recoveryManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($verifiedBackup.files.Count -ne $recoveryFiles.Count) { throw 'Recovery manifest is incomplete' }
    $entry | Add-Member -NotePropertyName recoveryManifest -NotePropertyValue $recoveryManifest
    ($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    $currentProtection = Get-PreviewProtection
    if ($currentProtection.Running -contains $entry.name -or $currentProtection.Pinned -contains $entry.name) {
      throw "Preview became protected while recovery was being prepared: $($entry.name)"
    }
    $entryReclaimedBytes = 0L
    $currentFiles=@(Get-ChildItem -LiteralPath $path -File -Force -Recurse)
    if($currentFiles.Count -ne $recoveryFiles.Count){throw 'Package file inventory changed before deletion'}
    $loadedIdentities=Get-PortableLoadedIdentities $artifactRoot
    foreach($file in $currentFiles) {
      $relative=$file.FullName.Substring($path.Length+1)
      $saved=@($recoveryFiles|Where-Object{$_.path -eq $relative})[0]
      if(-not $saved -or (Get-PortableHash $file.FullName) -ne $saved.sha256){throw 'Package bytes changed before deletion'}
      $original=[PortableResourceStorage]::Identity($file.FullName)
      if($loadedIdentities.ContainsKey($original.Id)){throw 'A shared package resource is loaded by another version; preserve this package'}
      $recovery=[PortableResourceStorage]::Identity((Join-Path $objectsRoot $saved.sha256))
      if($original.Id -ne $recovery.Id -and $original.Links -eq 1 -and
         -not($file.Attributes -band ([IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::SparseFile))) {$entryReclaimedBytes += $original.Bytes}
    }
    if((Get-PortableHash $recoveryManifest) -ne $recoveryManifestHash){throw 'Recovery manifest changed before deletion'}
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $path) { throw "Preview still exists after removal: $path" }
    $manifest.deleted += $entry.name
    $deletedBytes += $entry.bytes
    $reclaimedBytes += $entryReclaimedBytes
    ($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  }
  $manifest.status = 'complete'
  foreach ($directory in $kept) {
    $path = Assert-PreviewTarget (Get-Item -LiteralPath $directory.FullName -ErrorAction Stop)
    if (-not (Test-Path -LiteralPath (Join-Path $path 'AutopilotDesk-Community-Preview.exe') -PathType Leaf)) { throw "Kept preview is missing its executable: $path" }
    if (-not (Test-Path -LiteralPath (Join-Path $path 'resources') -PathType Container)) { throw "Kept preview is missing resources: $path" }
  }
} catch {
  $manifest.status = 'partial'
  throw
} finally {
  ($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}
$summary['deletedCount'] = $manifest.deleted.Count
$summary['deletedGiB'] = [math]::Round($deletedBytes / 1GB, 2)
$summary['recoveryUniqueGiB'] = [math]::Round($recoveryAddedBytes / 1GB, 3)
$summary['reclaimedGiB'] = [math]::Round($reclaimedBytes / 1GB, 3)
$summary['reclaimedEstimate'] = 'last-link uncompressed bytes whose file identity differs from recovery; previously shared resources are excluded'
$summary['manifest'] = $manifestPath
$summary | ConvertTo-Json -Compress
