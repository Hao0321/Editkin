$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$artifactRoot=Get-PortableArtifactRoot $PSScriptRoot ''
$root=Join-Path $artifactRoot ('resource-dedup-self-test-' + [Guid]::NewGuid().ToString('N'))
$names=@('portable-preview-2000-01-01T00-00-00-000Z','portable-preview-2000-01-02T00-00-00-000Z','portable-preview-2000-01-03T00-00-00-000Z')
function Assert($Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Reject([scriptblock]$Action) { $rejected=$false;try {& $Action | Out-Null}catch{$rejected=$true};Assert $rejected 'Unsafe operation accepted' }
try {
  $null=New-Item -ItemType Directory -Path $root
  foreach($name in $names) {
    $package=Join-Path $root $name
    foreach($relative in $script:PortableResourcePaths) {
      $path=Join-Path $package $relative
      $null=New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($path)) -Force
      [IO.File]::WriteAllText($path,'identical immutable fixture resource')
    }
    [IO.File]::WriteAllText((Join-Path $package 'AutopilotDesk-Community-Preview.exe'),$name)
    $kit=Join-Path $package 'resources\video-autopilot-kit'
    $null=New-Item -ItemType Directory -Path $kit
    [IO.File]::WriteAllText((Join-Path $kit 'SKILL.md'),'original pinned governance')
  }
  $workflow=Join-Path $root 'fixture-run\workflow-state.json'
  $null=New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($workflow))
  [IO.File]::WriteAllText($workflow,(@{governance=@{skill_path=Join-Path $root "$($names[0])\resources\video-autopilot-kit\SKILL.md"}}|ConvertTo-Json -Depth 4))
  $workflowHash=Get-PortableHash $workflow
  $first=Join-Path $root "$($names[0])\resources\fonts\NotoSansTC[wght].ttf"
  $second=Join-Path $root "$($names[1])\resources\fonts\NotoSansTC[wght].ttf"
  $protected=Join-Path $root "$($names[2])\resources\fonts\NotoSansTC[wght].ttf"
  $protectedId=([PortableResourceStorage]::Identity($protected)).Id
  $before=([PortableResourceStorage]::Identity($second)).Id
  $dry=& "$PSScriptRoot\compact-portable-resources.ps1" -Names $names -PreserveNames @($names[2]) -TestArtifactRoot $root | ConvertFrom-Json
  Assert ($dry.replaceCount -eq 9 -and ([PortableResourceStorage]::Identity($second)).Id -eq $before) 'Dry-run changed files or missed shared bytes'
  $compact=& "$PSScriptRoot\compact-portable-resources.ps1" -Names $names -PreserveNames @($names[2]) -TestArtifactRoot $root -Apply | ConvertFrom-Json
  Assert ($compact.status -eq 'complete' -and $compact.replaced -eq 9) 'Compaction failed'
  Assert (([PortableResourceStorage]::Identity($first)).Id -eq ([PortableResourceStorage]::Identity($second)).Id) 'Bracket font paths did not become hard links'
  Assert (([PortableResourceStorage]::Identity($protected)).Id -eq $protectedId) 'Explicitly protected package changed'
  Assert ((Get-PortableHash $workflow) -eq $workflowHash) 'Workflow bytes changed'
  $idempotent=& "$PSScriptRoot\compact-portable-resources.ps1" -Names $names -PreserveNames @($names[2]) -TestArtifactRoot $root | ConvertFrom-Json
  Assert ($idempotent.replaceCount -eq 0) 'Second compaction is not idempotent'
  $restored=& "$PSScriptRoot\restore-portable-resources.ps1" -Manifest $compact.manifest -TestArtifactRoot $root | ConvertFrom-Json
  Assert ($restored.status -eq 'complete' -and $restored.restored -eq 9) 'Restore count differs'
  Assert (([PortableResourceStorage]::Identity($second)).Links -eq 1) 'Restore left a shared copy'
  [IO.File]::WriteAllText($second,'independent editable restoration')
  Assert ((Get-PortableHash $first) -ne (Get-PortableHash $second)) 'Restoration modified another package'
  # A live CAS executable can be reached through a different package or transaction link.
  # Inventory must protect its file identity even when no requested package name is running.
  $fixtureLoadedImage=Join-Path $root ('portable-preview-recovery\objects\' + (Get-PortableHash $first))
  function Get-CimInstance { param($ClassName, $ErrorAction)
    [pscustomobject]@{Name='opencode.exe';ExecutablePath=$fixtureLoadedImage;CommandLine='fixture';ProcessId=2147483647}
  }
  try {
    $protectedDry=& "$PSScriptRoot\compact-portable-resources.ps1" -Names @($names[0]) -TestArtifactRoot $root | ConvertFrom-Json
    Assert ($protectedDry.loadedResourcesProtected -eq 5 -and $protectedDry.replaceCount -eq 0 -and $protectedDry.protectedRunning.Count -eq 0) 'Loaded identity was not protected across package names'
    $protectedApply=& "$PSScriptRoot\compact-portable-resources.ps1" -Names @($names[0]) -TestArtifactRoot $root -Apply | ConvertFrom-Json
    Assert ($protectedApply.status -eq 'complete' -and $protectedApply.loadedResourcesProtected -gt 0 -and $protectedApply.replaced -eq 0) 'Loaded CAS anchor was replaced'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root $names[0]) -Recurse -File | Where-Object {$_.Name -like '*.dedup-new-*'}).Count -eq 0) 'Protected identity created a transaction link'
  } finally { Remove-Item -LiteralPath Function:Get-CimInstance }
  # Simulate a terminated transaction whose target name is temporarily missing.
  $interrupted=Get-Content -LiteralPath $compact.manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $entry=@($interrupted.entries | Where-Object {$_.name -eq $names[0] -and $_.relativePath -eq 'resources\fonts\NotoSansTC[wght].ttf'})[0]
  $entry.state='replacing'
  $interrupted.entries=@($entry);$interrupted.status='running';$interrupted.ownerPid=2147483647
  Assert ([IO.Path]::GetDirectoryName($entry.backupPath) -eq [IO.Path]::GetDirectoryName($first)) 'Fixture backup escaped'
  Move-Item -LiteralPath $first -Destination $entry.backupPath
  $interrupted | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $compact.manifest -Encoding UTF8
  $recovered=& "$PSScriptRoot\restore-portable-resources.ps1" -Manifest $compact.manifest -TestArtifactRoot $root | ConvertFrom-Json
  Assert ($recovered.restored -eq 1 -and (Test-Path -LiteralPath $first) -and ([PortableResourceStorage]::Identity($first)).Links -eq 1) 'Interrupted target did not recover independently'
  Assert ((Get-PortableHash $first) -eq $entry.sha256 -and -not (Test-Path -LiteralPath $entry.backupPath)) 'Interrupted backup was not validated and retired'
  Reject {& "$PSScriptRoot\compact-portable-resources.ps1" -Names @('..\escape') -TestArtifactRoot $root -Apply}
  Reject {& "$PSScriptRoot\compact-portable-resources.ps1" -Names $names -TestArtifactRoot $artifactRoot -Apply}
  $manifest=Get-Content -LiteralPath $compact.manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifest.entries[0].relativePath='..\secret'
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $compact.manifest -Encoding UTF8
  Reject {& "$PSScriptRoot\restore-portable-resources.ps1" -Manifest $compact.manifest -TestArtifactRoot $root}
  [pscustomobject]@{status='PASS';checks=@('dry-run','literal bracket names','pinned workflow preserved','explicit protection','loaded CAS identity protection','idempotence','independent byte-exact restore','cross-package independence','interrupted missing-target recovery','unsafe names/root/manifest rejection')} | ConvertTo-Json -Compress
} finally {
  if(Test-Path -LiteralPath $root) {
    if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ne $artifactRoot -or [IO.Path]::GetFileName($root) -notmatch '^resource-dedup-self-test-[a-z0-9]+$') {throw 'Unsafe fixture cleanup'}
    Assert-PortableRegular $root $true | Out-Null
    Remove-Item -LiteralPath $root -Recurse -Force
  }
}
