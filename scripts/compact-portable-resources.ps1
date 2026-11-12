param(
  [Parameter(Mandatory = $true)][string[]]$Names,
  [string[]]$PreserveNames = @(),
  [switch]$Apply,
  [string]$TestArtifactRoot = ''
)
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$root = Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$names = @($Names | Select-Object -Unique)
foreach ($name in @($names) + @($PreserveNames)) {
  if ($name -notmatch $script:PortablePreviewPattern) { throw 'Invalid package name' }
  Assert-PortableRegular (Join-Path $root $name) $true | Out-Null
}
$running = @(Get-PortableRunningNames $root $names)
$protected = @($running + $PreserveNames | Sort-Object -Unique)
$objects = Assert-PortableObjectRoot $root $false
$loaded = Get-PortableLoadedIdentities $root
$plans = @(); $anchors = @{}
foreach ($name in $names) {
  if ($protected -contains $name) { continue }
  foreach ($relative in $script:PortableResourcePaths) {
    $candidate = Join-Path (Join-Path $root $name) $relative
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $path = Assert-PortableResource $root $name $relative
    $sha = Get-PortableHash $path
    $identity = [PortableResourceStorage]::Identity($path)
    $object = Join-Path $objects $sha
    if (-not $anchors.ContainsKey($sha)) {
      $anchor = if (Test-Path -LiteralPath $object) { $object } else { $path }
      Assert-PortableRegular $anchor $false | Out-Null
      if ((Get-PortableHash $anchor) -ne $sha) { throw 'Recovery object is corrupt' }
      $anchors[$sha] = $anchor
    }
    $anchorIdentity = [PortableResourceStorage]::Identity($anchors[$sha])
    $inUse = $loaded.ContainsKey($identity.Id) -or $loaded.ContainsKey($anchorIdentity.Id)
    $plans += [pscustomobject]@{name=$name;relativePath=$relative;sha256=$sha;bytes=$identity.Bytes;originalId=$identity.Id;
      originalLinks=$identity.Links;alreadyShared=($identity.Id -eq $anchorIdentity.Id);loadedIdentityProtected=$inUse;state='planned'}
  }
}
$candidates = @($plans | Where-Object { -not $_.alreadyShared -and -not $_.loadedIdentityProtected })
$summary = [ordered]@{mode=if ($Apply) {'apply'} else {'dry-run'};packages=$names.Count;protectedRunning=$running;
  protectedExplicit=$PreserveNames;resources=$plans.Count;loadedResourcesProtected=@($plans | Where-Object {$_.loadedIdentityProtected}).Count;replaceCount=$candidates.Count;
  plannedUniqueGiB=[math]::Round((($candidates | Where-Object {$_.originalLinks -eq 1} | Measure-Object bytes -Sum).Sum)/1GB,3)}
if (-not $Apply) { $summary | ConvertTo-Json -Compress; return }
$objects = Assert-PortableObjectRoot $root $true
$manifestPath = Join-Path $root ('portable-resource-dedup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
$workflowHashes = @(Get-PortableWorkflowHashes $root)
$manifest = [ordered]@{schema='editkin-portable-resource-dedup/v1';createdAtUtc=[DateTime]::UtcNow.ToString('o');ownerPid=$PID;
  scope='five immutable vendor resource paths only; no editor/Kit/workflow/source changes';protectedRunning=$running;protectedExplicit=$PreserveNames;
  recovery='SHA-256 objects plus restore-portable-resources.ps1 create independent byte-exact files';entries=$plans;
  workflowHashes=$workflowHashes;reclaimedBytesEstimate=[long]0;status='running'}
function Save-ResourceManifest { $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8 }
Save-ResourceManifest
try {
  foreach ($entry in $plans) {
    $path = Assert-PortableResource $root $entry.name $entry.relativePath
    if ((Get-PortableHash $path) -ne $entry.sha256) { throw 'Resource changed after inventory' }
    if (@(Get-PortableRunningNames $root @($entry.name)).Count -gt 0) { throw 'Package started during compaction; stop with partial manifest' }
    $object = Join-Path $objects $entry.sha256
    if (-not (Test-Path -LiteralPath $object)) { [PortableResourceStorage]::Link($object, $path) }
    Assert-PortableRegular $object $false | Out-Null
    if ((Get-PortableHash $object) -ne $entry.sha256) { throw 'Recovery object verification failed' }
    $original = [PortableResourceStorage]::Identity($path)
    $shared = [PortableResourceStorage]::Identity($object)
    if ($original.Id -eq $shared.Id) { $entry.state='already-shared'; Save-ResourceManifest; continue }
    # Another running package can load the same CAS file through a different hard-link name.
    # Check file identity before creating transaction links, including a second live check.
    $loaded = Get-PortableLoadedIdentities $root
    if ($entry.loadedIdentityProtected -or $loaded.ContainsKey($original.Id) -or $loaded.ContainsKey($shared.Id)) {
      $entry.loadedIdentityProtected=$true; $entry.state='protected-loaded'; Save-ResourceManifest; continue
    }
    $suffix = [Guid]::NewGuid().ToString('N')
    $temporary = $path + '.dedup-new-' + $suffix
    $backup = $path + '.dedup-old-' + $suffix
    # Both transaction paths are literal siblings of the already validated allowlisted target.
    if ([IO.Path]::GetDirectoryName($temporary) -ne [IO.Path]::GetDirectoryName($path) -or
        [IO.Path]::GetDirectoryName($backup) -ne [IO.Path]::GetDirectoryName($path)) { throw 'Transaction escaped resource directory' }
    $entry | Add-Member -NotePropertyName backupPath -NotePropertyValue $backup
    $entry | Add-Member -NotePropertyName temporaryPath -NotePropertyValue $temporary
    $entry.state='replacing'; Save-ResourceManifest
    try {
      [PortableResourceStorage]::Link($temporary, $object)
      [PortableResourceStorage]::Replace($path, $temporary, $backup)
      if ((Get-PortableHash $path) -ne $entry.sha256 -or
          ([PortableResourceStorage]::Identity($path)).Id -ne $shared.Id -or (Get-PortableHash $backup) -ne $entry.sha256) { throw 'Replacement bytes or file identity differ' }
      $backupInfo = [PortableResourceStorage]::Identity($backup)
      $backupItem = Assert-PortableRegular $backup $false
      $reclaimed = [long]0
      # Count only an uncompressed, non-sparse last link. Previously shared files are not counted twice.
      if ($backupInfo.Links -eq 1 -and -not ($backupItem.Attributes -band ([IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::SparseFile))) {
        $reclaimed = $backupInfo.Bytes
      }
      Remove-Item -LiteralPath $backup -Force
      if (Test-Path -LiteralPath $backup) { throw 'Original transaction backup could not be retired' }
      $manifest.reclaimedBytesEstimate += $reclaimed
      $entry.state='deduplicated'; Save-ResourceManifest
    } catch {
      $replacementError = $_
      Undo-PortableReplacement $path $backup $entry.sha256
      if (Test-Path -LiteralPath $temporary) {
        Assert-PortableRegular $temporary $false | Out-Null
        try { Remove-Item -LiteralPath $temporary -Force }
        catch { $entry.state='rolled-back-cleanup-pending'; Save-ResourceManifest; throw }
      }
      $entry.state='rolled-back'; Save-ResourceManifest
      throw $replacementError
    }
  }
  foreach ($entry in $plans) {
    $path = Assert-PortableResource $root $entry.name $entry.relativePath
    if ((Get-PortableHash $path) -ne $entry.sha256) { throw 'Final resource hash changed' }
  }
  Assert-PortableWorkflowHashes $workflowHashes
  $manifest.status='complete'; Save-ResourceManifest
} catch { $manifest.status='partial'; Save-ResourceManifest; throw }
$summary.manifest=$manifestPath
$summary.replaced=@($plans | Where-Object {$_.state -eq 'deduplicated'}).Count
$summary.loadedResourcesProtected=@($plans | Where-Object {$_.state -eq 'protected-loaded'}).Count
$summary.reclaimedGiBEstimate=[math]::Round($manifest.reclaimedBytesEstimate/1GB,3)
$summary.status=$manifest.status
$summary | ConvertTo-Json -Compress
