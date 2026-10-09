param([Parameter(Mandatory = $true)][string]$Manifest,[switch]$ReplaceKitArchive)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$artifactRoot = Join-Path $workspaceRoot 'artifacts\autopilot-desk'
$manifestPath = [IO.Path]::GetFullPath($Manifest)
$recoveryRoot = [IO.Path]::GetDirectoryName($manifestPath)
$targetRoot = [IO.Path]::GetDirectoryName($recoveryRoot)
if ([IO.Path]::GetFileName($recoveryRoot) -ne 'portable-preview-recovery' -or
    ($targetRoot -ne $artifactRoot -and
      ([IO.Path]::GetDirectoryName($targetRoot) -ne $artifactRoot -or [IO.Path]::GetFileName($targetRoot) -notmatch '^(prune-self-test-[a-z0-9-]+|resource-dedup-self-test-[a-z0-9]+)$'))) {
  throw 'Recovery manifest is outside the preview artifact root'
}
$objectsRoot = Join-Path $recoveryRoot 'objects'
foreach ($directory in @($targetRoot, $recoveryRoot, $objectsRoot)) {
  $item = Get-Item -LiteralPath $directory
  if (-not $item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Recovery path is not a regular directory' }
}
$backup = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($backup.schema -ne 'editkin-portable-preview-recovery/v1' -or
    $backup.name -notmatch '^portable-preview-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$' -or
    [IO.Path]::GetFileName($manifestPath) -ne "$($backup.name).json" -or $backup.files.Count -lt 1) {
  throw 'Invalid preview recovery manifest'
}
$destination = Join-Path $targetRoot $backup.name
$archive = $null
if (Test-Path -LiteralPath $destination) {
  if(-not $ReplaceKitArchive){throw 'Restore destination already exists'}
  $item=Get-Item -LiteralPath $destination
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Archive is not a regular directory'}
  $markerPath=Join-Path $destination 'ARCHIVED-KIT-SOURCE.json'
  $markerItem=Get-Item -LiteralPath $markerPath
  if($markerItem.PSIsContainer -or ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Archive marker is not a regular file'}
  $archive=Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8|ConvertFrom-Json
  if($archive.schema -ne 'editkin-kit-source-archive/v1' -or $archive.name -ne $backup.name -or $archive.status -ne 'complete' -or $archive.recoveryManifest -ne $manifestPath){throw 'Existing directory is not the verified archive'}
  foreach($file in $archive.kept){
    $path=[IO.Path]::GetFullPath((Join-Path $destination $file.path))
    if(-not $path.StartsWith($destination+'\') -or $file.path -notmatch '^resources[\\/]video-autopilot-kit[\\/]'){throw 'Invalid kept source path'}
    if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Archived source changed; preserve it'}
  }
  $allItems=@(Get-ChildItem -LiteralPath $destination -Recurse -Force)
  $actual=@($allItems|Where-Object{-not $_.PSIsContainer})
  if(@($allItems|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -or $actual.Count -ne $archive.kept.Count+1){throw 'Archive contains unexpected files'}
  foreach($process in @(Get-CimInstance Win32_Process)){
    if(($process.ExecutablePath -and $process.ExecutablePath.StartsWith($destination+'\')) -or ($process.CommandLine -and $process.CommandLine.Contains($destination+'\'))){throw 'Archive is in use'}
  }
}
$seen = @{}
foreach ($file in $backup.files) {
  if ([IO.Path]::IsPathRooted($file.path) -or $file.path -match '(^|[\\/])\.\.([\\/]|$)|:' -or
      $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($file.path)) { throw 'Unsafe recovery file entry' }
  $resolvedFile = [IO.Path]::GetFullPath((Join-Path $destination $file.path))
  if (-not $resolvedFile.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery file escaped destination' }
  $seen[$file.path] = $true
  $object = Join-Path $objectsRoot $file.sha256
  $item = Get-Item -LiteralPath $object
  if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -ne $file.bytes -or
      (Get-FileHash -LiteralPath $object -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Recovery object is missing or corrupt' }
}
if (-not $seen.ContainsKey('AutopilotDesk-Community-Preview.exe') -or
    -not @($backup.files | Where-Object { $_.path -match '^resources[\\/]' }).Count) { throw 'Recovery manifest has no complete executable/resources package' }
$stage = Join-Path $targetRoot ('.restore-' + [guid]::NewGuid().ToString('N'))
$archiveStage=Join-Path $targetRoot ('.archive-restore-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($file in $backup.files) {
    $output = Join-Path $stage $file.path
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($output)) -Force | Out-Null
    # Restore independent copies so running/editing a restored package cannot alter recovery objects.
    Copy-Item -LiteralPath (Join-Path $objectsRoot $file.sha256) -Destination $output
    if ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Restored file failed verification' }
  }
  if ($archive) {
    if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($archiveStage)) -ne $targetRoot){throw 'Archive staging escaped root'}
    Move-Item -LiteralPath $destination -Destination $archiveStage
    try{Move-Item -LiteralPath $stage -Destination $destination}
    catch{Move-Item -LiteralPath $archiveStage -Destination $destination;throw}
    Remove-Item -LiteralPath $archiveStage -Recurse -Force
  } else {
    if (Test-Path -LiteralPath $destination) { throw 'Restore destination appeared during recovery' }
    Move-Item -LiteralPath $stage -Destination $destination
  }
  [ordered]@{ status = 'RESTORED'; name = $backup.name; files = $backup.files.Count } | ConvertTo-Json -Compress
} finally {
  if ((Test-Path -LiteralPath $stage) -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -eq $targetRoot) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
