$ErrorActionPreference = 'Stop'
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\artifacts\autopilot-desk')).TrimEnd('\')
$testRoot = Join-Path $artifactRoot ('prune-self-test-' + [guid]::NewGuid().ToString('N'))
$names = @('portable-preview-2000-01-01T00-00-00-000Z', 'portable-preview-2000-01-02T00-00-00-000Z', 'portable-preview-2000-01-03T00-00-00-000Z')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
  foreach ($name in $names) {
    $directory = Join-Path $testRoot $name
    New-Item -ItemType Directory -Path (Join-Path $directory 'resources') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $directory 'AutopilotDesk-Community-Preview.exe') -Value $name
    Set-Content -LiteralPath (Join-Path $directory 'resources\shared[lang].bin') -Value 'immutable shared resource'
  }
  $stateRoot = Join-Path $testRoot 'fixture-run'
  New-Item -ItemType Directory -Path $stateRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $stateRoot '.gitignore') -Value '*'
  $stateJson = @{ governance = @{ skill_path = Join-Path $testRoot "$($names[0])\resources\SKILL.md" } } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText((Join-Path $stateRoot 'workflow-state.json'), $stateJson, (New-Object Text.UTF8Encoding $false))
  $dry = & "$PSScriptRoot\prune-portable-previews.ps1" -Keep 1 -TestArtifactRoot $testRoot | ConvertFrom-Json
  Assert ($dry.obsoleteCount -eq 1 -and $dry.protectedWorkflow -contains $names[0]) 'Ignored workflow pin was not protected'
  $protected = & "$PSScriptRoot\prune-portable-previews.ps1" -OnlyDiscard -Discard $names[0] -Apply -TestArtifactRoot $testRoot | ConvertFrom-Json
  Assert ($protected.obsoleteCount -eq 0 -and (Test-Path -LiteralPath (Join-Path $testRoot $names[0]))) 'Explicit discard bypassed a workflow pin'
  $beforeHash = (Get-FileHash -LiteralPath (Join-Path $testRoot "$($names[1])\AutopilotDesk-Community-Preview.exe")).Hash
  # A different package can load a CAS hard link to a resource in this obsolete package.
  $resource=Join-Path $testRoot "$($names[1])\resources\shared[lang].bin"
  $objectRoot=Join-Path $testRoot 'portable-preview-recovery\objects'
  New-Item -ItemType Directory -Path $objectRoot -Force | Out-Null
  $fixtureLoadedPath=Join-Path $objectRoot ((Get-FileHash -LiteralPath $resource).Hash.ToLowerInvariant())
  [EditkinPreviewRecoveryLinks]::Create($fixtureLoadedPath,$resource)
  function Get-CimInstance { param($ClassName,$ErrorAction)
    [pscustomobject]@{Name='opencode.exe';ExecutablePath=$fixtureLoadedPath;CommandLine='fixture';ProcessId=2147483647}
  }
  try {
    $loadedRejected=$false
    try { & "$PSScriptRoot\prune-portable-previews.ps1" -Keep 1 -Apply -TestArtifactRoot $testRoot | Out-Null }
    catch { $loadedRejected=$_.Exception.Message -like '*shared package resource is loaded*' }
    Assert ($loadedRejected -and (Get-ChildItem -LiteralPath (Join-Path $testRoot $names[1]) -Recurse -File).Count -eq 2) 'Loaded shared image was not rejected before deletion'
  } finally { Remove-Item -LiteralPath Function:Get-CimInstance }
  $applied = & "$PSScriptRoot\prune-portable-previews.ps1" -Keep 1 -Apply -TestArtifactRoot $testRoot | ConvertFrom-Json
  Assert ($applied.deletedCount -eq 1 -and -not (Test-Path -LiteralPath (Join-Path $testRoot $names[1]))) 'Unused package was not pruned'
  $restored = & "$PSScriptRoot\restore-portable-preview.ps1" -Manifest (Join-Path $testRoot "portable-preview-recovery\$($names[1]).json") | ConvertFrom-Json
  Assert ($restored.status -eq 'RESTORED') 'Package did not restore'
  Assert ((Get-FileHash -LiteralPath (Join-Path $testRoot "$($names[1])\AutopilotDesk-Community-Preview.exe")).Hash -eq $beforeHash) 'Restored EXE differs from original'
  $restoredTarget = [IO.Path]::GetFullPath((Join-Path $testRoot $names[1]))
  Assert ([IO.Path]::GetDirectoryName($restoredTarget) -eq $testRoot) 'Fixture restore escaped test root'
  $existingManifestPath=Join-Path $testRoot "portable-preview-recovery\$($names[1]).json"
  $existingManifestBytes=[IO.File]::ReadAllBytes($existingManifestPath)
  $changed=Get-Content -LiteralPath $existingManifestPath -Raw -Encoding UTF8|ConvertFrom-Json
  $changed.files[0].sha256='0'*64
  $changed|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $existingManifestPath -Encoding UTF8
  $mismatchRejected=$false
  try{& "$PSScriptRoot\prune-portable-previews.ps1" -Keep 1 -Apply -TestArtifactRoot $testRoot|Out-Null}catch{$mismatchRejected=$true}
  Assert ($mismatchRejected -and (Test-Path -LiteralPath $restoredTarget)) 'Mismatched existing backup did not preserve its package'
  [IO.File]::WriteAllBytes($existingManifestPath,$existingManifestBytes)
  $existingManifestHash=(Get-FileHash -LiteralPath $existingManifestPath -Algorithm SHA256).Hash
  $reused=& "$PSScriptRoot\prune-portable-previews.ps1" -Keep 1 -Apply -TestArtifactRoot $testRoot|ConvertFrom-Json
  Assert ($reused.deletedCount -eq 1 -and -not(Test-Path -LiteralPath $restoredTarget)) 'Verified existing backup could not be reused'
  Assert ((Get-FileHash -LiteralPath $existingManifestPath -Algorithm SHA256).Hash -eq $existingManifestHash) 'Existing backup was rewritten'
  $restoredAgain=& "$PSScriptRoot\restore-portable-preview.ps1" -Manifest $existingManifestPath|ConvertFrom-Json
  Assert ($restoredAgain.status -eq 'RESTORED' -and (Get-FileHash -LiteralPath (Join-Path $restoredTarget 'AutopilotDesk-Community-Preview.exe')).Hash -eq $beforeHash) 'Reused backup did not restore exact bytes'
  Remove-Item -LiteralPath $restoredTarget -Recurse -Force
  $invalidPathRejected = $false
  try { & "$PSScriptRoot\prune-portable-previews.ps1" -TestArtifactRoot $artifactRoot | Out-Null } catch { $invalidPathRejected = $true }
  Assert $invalidPathRejected 'Test override escaped its isolated scope'
  $badManifestPath = Join-Path $testRoot "portable-preview-recovery\$($names[1]).json"
  $badManifest = Get-Content -LiteralPath $badManifestPath -Raw | ConvertFrom-Json
  $badManifest.name = $names[1]
  $badManifest.files[0].path = '..\escape.exe'
  $badManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $badManifestPath
  $escapeRejected = $false
  try { & "$PSScriptRoot\restore-portable-preview.ps1" -Manifest $badManifestPath | Out-Null } catch { $escapeRejected = $true }
  Assert $escapeRejected 'Unsafe restore manifest was accepted'
  [ordered]@{ status = 'PASS'; checks = @('ignored-workflow-pin', 'explicit-discard-protection', 'loaded-shared-image-protection', 'prune', 'byte-exact-restore', 'existing-backup-mismatch-rejection', 'existing-backup-reuse-and-restore', 'isolated-root', 'unsafe-restore-rejection') } | ConvertTo-Json -Compress
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($testRoot)) -eq $artifactRoot -and
      [IO.Path]::GetFileName($testRoot) -match '^prune-self-test-[a-z0-9-]+$') { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
