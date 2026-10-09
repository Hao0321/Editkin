$ErrorActionPreference = 'Stop'
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\artifacts\autopilot-desk')).TrimEnd('\')
$name = 'cache-prune-self-test-' + [Guid]::NewGuid().ToString('N')
$root = [IO.Path]::GetFullPath((Join-Path $artifactRoot $name))
if ([IO.Path]::GetDirectoryName($root) -ne $artifactRoot) { throw 'Unsafe test root' }
$script = Join-Path $PSScriptRoot 'prune-review-caches.ps1'
$cache = Join-Path $root 'webview2'
$report = Join-Path $root 'report.json'
$project = Join-Path $root 'keep.editkin.json'
function Expect-Rejection([scriptblock]$Action) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  if (-not $rejected -or -not (Test-Path -LiteralPath $cache)) { throw 'Unsafe prune was not rejected before deletion' }
}
$manifestPath = $null
$fixtureProcess = $null
try {
  $null = New-Item -ItemType Directory -Path $cache
  [IO.File]::WriteAllBytes((Join-Path $cache 'scratch.bin'), [byte[]](1, 2, 3, 4))
  [IO.File]::WriteAllText($project, '{"id":"preserve"}')
  [IO.File]::WriteAllText($report, ('{"status":"PASS","appPid":' + $PID + '}'))
  Expect-Rejection { & $script -Names @($name) -Apply }
  $nativeExecutable=Join-Path $artifactRoot 'portable-preview-2000-01-01T00-00-00-000Z\AutopilotDesk-Community-Preview.exe'
  @{status='PASS';appPid=$PID;executable=$nativeExecutable}|ConvertTo-Json|Set-Content -LiteralPath $report -Encoding UTF8
  $reusedPlan=& $script -Names @($name)|ConvertFrom-Json
  if($reusedPlan.status -ne 'dry-run' -or -not(Get-Process -Id $PID)){throw 'Reused unrelated PID was not distinguished safely'}
  $fixtureProcess=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('-e','"setTimeout(()=>{},20000)"',$root) -WindowStyle Hidden -PassThru
  Expect-Rejection { & $script -Names @($name) -Apply }
  if(-not $fixtureProcess.HasExited){$fixtureProcess.Kill();if(-not $fixtureProcess.WaitForExit(5000)){throw 'Owned fixture did not exit'}};$fixtureProcess=$null
  [IO.File]::WriteAllText($report, '{"status":"RUNNING","appPid":0}')
  Expect-Rejection { & $script -Names @($name) -Apply }
  [IO.File]::WriteAllText($report, '{"status":"PASS","appPid":0}')
  Expect-Rejection { & $script -Names @('..\outside') -Apply }
  $hashes = @((Get-FileHash -LiteralPath $project).Hash, (Get-FileHash -LiteralPath $report).Hash)
  $plan = (& $script -Names @($name) | ConvertFrom-Json)
  if ($plan.status -ne 'dry-run' -or $plan.bytes -ne 4 -or -not (Test-Path -LiteralPath $cache)) { throw 'Dry run mutated fixture' }
  $result = (& $script -Names @($name) -Apply | ConvertFrom-Json)
  $manifestPath = $result.manifestPath
  if ($result.status -ne 'complete' -or $result.deleted -ne 1 -or $result.reclaimedBytes -ne 4 -or (Test-Path -LiteralPath $cache)) { throw 'Finished fixture cache was not cleaned' }
  $after = @((Get-FileHash -LiteralPath $project).Hash, (Get-FileHash -LiteralPath $report).Hash)
  if ([string]::Join(',', $hashes) -ne [string]::Join(',', $after)) { throw 'Evidence files changed' }
  [pscustomobject]@{ status = 'PASS'; checks = @('legacy live PID protection', 'unrelated PID reuse distinguished', 'live root-reference protection', 'unfinished report protection', 'path rejection', 'dry-run', 'cache-only deletion with preserved evidence') } | ConvertTo-Json -Compress
} finally {
  if($fixtureProcess -and -not $fixtureProcess.HasExited){$fixtureProcess.Kill();if(-not $fixtureProcess.WaitForExit(5000)){throw 'Owned fixture did not exit'}}
  $item = Get-Item -LiteralPath $root -ErrorAction SilentlyContinue
  if ($item) {
    if ([IO.Path]::GetDirectoryName($item.FullName) -ne $artifactRoot -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture cleanup' }
    Remove-Item -LiteralPath $root -Recurse -Force
  }
  if ($manifestPath) {
    $resolvedManifest = [IO.Path]::GetFullPath($manifestPath)
    if ([IO.Path]::GetDirectoryName($resolvedManifest) -ne $artifactRoot -or [IO.Path]::GetFileName($resolvedManifest) -notmatch '^review-cache-prune-\d{8}T\d{9}Z\.json$') { throw 'Unsafe fixture manifest' }
    Remove-Item -LiteralPath $resolvedManifest -Force
  }
}
