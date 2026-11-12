param([Parameter(Mandatory=$true)][string]$Manifest, [string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$root = Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$manifestPath = [IO.Path]::GetFullPath($Manifest)
if ([IO.Path]::GetDirectoryName($manifestPath) -ne $root -or [IO.Path]::GetFileName($manifestPath) -notmatch '^portable-resource-dedup-\d{8}T\d{9}Z\.json$') { throw 'Invalid resource manifest path' }
Assert-PortableRegular $manifestPath $false | Out-Null
$data = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($data.schema -ne 'editkin-portable-resource-dedup/v1' -or $data.status -notin @('complete','partial','running')) { throw 'Compaction manifest is not recoverable' }
if ($data.status -eq 'running' -and (-not $data.ownerPid -or @(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$data.ownerPid)").Count -gt 0)) { throw 'Compaction owner still exists; do not restore concurrently' }
$objects = Assert-PortableObjectRoot $root $false
$entries = @($data.entries | Where-Object { $_.state -in @('deduplicated','replacing') })
$seen = @{}
foreach ($entry in $entries) {
  $target = Assert-PortableResource $root $entry.name $entry.relativePath $true
  if ($seen.ContainsKey($target) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid recovery entry' }
  $seen[$target]=$true
  if (@(Get-PortableRunningNames $root @($entry.name)).Count -gt 0) { throw 'Cannot restore a running package' }
  $object = Join-Path $objects $entry.sha256
  Assert-PortableRegular $object $false | Out-Null
  if ((Get-PortableHash $object) -ne $entry.sha256 -or ((Test-Path -LiteralPath $target) -and (Get-PortableHash $target) -ne $entry.sha256)) { throw 'Recovery or target differs; preserve it for review' }
  foreach ($transaction in @($entry.backupPath, $entry.temporaryPath)) {
    if (-not $transaction) { continue }
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($transaction)) -ne [IO.Path]::GetDirectoryName($target) -or
        $transaction -notmatch ('^' + [Regex]::Escape($target) + '\.dedup-(old|new)-[a-f0-9]{32}$')) { throw 'Invalid transaction path' }
    if (Test-Path -LiteralPath $transaction) { Assert-PortableRegular $transaction $false | Out-Null; if ((Get-PortableHash $transaction) -ne $entry.sha256) { throw 'Transaction file differs; preserve it' } }
  }
}
$log = [ordered]@{schema='editkin-resource-restore/v1';sourceManifest=$manifestPath;restored=@();status='running'}
$logPath = Join-Path $root ('portable-resource-restore-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
function Save-RestoreLog { $log | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $logPath -Encoding UTF8 }
Save-RestoreLog
try {
  foreach ($entry in $entries) {
    $path = Assert-PortableResource $root $entry.name $entry.relativePath $true
    if (@(Get-PortableRunningNames $root @($entry.name)).Count -gt 0) { throw 'Package started during restore' }
    $object = Join-Path $objects $entry.sha256
    $suffix = [Guid]::NewGuid().ToString('N')
    $temporary = $path + '.independent-new-' + $suffix
    $backup = $path + '.independent-old-' + $suffix
    try {
      Copy-Item -LiteralPath $object -Destination $temporary
      if ((Get-PortableHash $temporary) -ne $entry.sha256) { throw 'Independent copy hash differs' }
      if (Test-Path -LiteralPath $path) { [PortableResourceStorage]::Replace($path, $temporary, $backup) }
      else { Move-Item -LiteralPath $temporary -Destination $path }
      if ((Get-PortableHash $path) -ne $entry.sha256 -or ([PortableResourceStorage]::Identity($path)).Links -ne 1) { throw 'Independent restore failed' }
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
      foreach ($transaction in @($entry.backupPath, $entry.temporaryPath)) {
        if ($transaction -and (Test-Path -LiteralPath $transaction)) { Assert-PortableRegular $transaction $false | Out-Null; Remove-Item -LiteralPath $transaction -Force }
      }
      $log.restored += [pscustomobject]@{name=$entry.name;relativePath=$entry.relativePath;sha256=$entry.sha256}
      Save-RestoreLog
    } catch {
      Undo-PortableReplacement $path $backup $entry.sha256
      if (Test-Path -LiteralPath $temporary) { Assert-PortableRegular $temporary $false | Out-Null; Remove-Item -LiteralPath $temporary -Force }
      throw
    }
  }
  Assert-PortableWorkflowHashes $data.workflowHashes
  $log.status='complete'; Save-RestoreLog
} catch {$log.status='partial';Save-RestoreLog;throw}
[pscustomobject]@{status=$log.status;restored=$log.restored.Count;manifest=$logPath} | ConvertTo-Json -Compress
