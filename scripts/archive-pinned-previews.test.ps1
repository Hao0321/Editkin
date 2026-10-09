$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$artifactRoot=Get-PortableArtifactRoot $PSScriptRoot ''
$root=Join-Path $artifactRoot ('resource-dedup-self-test-'+[Guid]::NewGuid().ToString('N'))
$names=@('portable-preview-2000-01-01T00-00-00-000Z','portable-preview-2000-01-02T00-00-00-000Z')
function Assert($value,$message){if(-not $value){throw $message}}
try{
 foreach($name in $names){$package=Join-Path $root $name;$kit=Join-Path $package 'resources\video-autopilot-kit';New-Item -ItemType Directory -Path $kit -Force|Out-Null;[IO.File]::WriteAllText((Join-Path $kit 'SKILL.md'),'pinned source');[IO.File]::WriteAllText((Join-Path $kit 'workflow_contract.json'),'{"fixture":true}');[IO.File]::WriteAllText((Join-Path $package 'AutopilotDesk-Community-Preview.exe'),$name);[IO.File]::WriteAllText((Join-Path $package 'resources\runtime.mjs'),'old execution resources')}
 $state=Join-Path $root 'fixture-run\workflow-state.json';New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($state))|Out-Null
 [IO.File]::WriteAllText($state,(@{governance=@{skill_path=Join-Path $root "$($names[0])\resources\video-autopilot-kit\SKILL.md"}}|ConvertTo-Json -Depth 4))
 $before=Get-PortableHash $state
 $dry=& "$PSScriptRoot\archive-pinned-previews.ps1" -Keep 1 -TestArtifactRoot $root|ConvertFrom-Json
 Assert ($dry.pinnedArchiveCount -eq 1) 'Pinned old version was not selected'
 $result=& "$PSScriptRoot\archive-pinned-previews.ps1" -Keep 1 -TestArtifactRoot $root -Apply|ConvertFrom-Json
 Assert ($result.status -eq 'complete' -and $result.archived -eq 1) 'Archive did not finish'
 Assert (-not(Test-Path -LiteralPath (Join-Path $root "$($names[0])\AutopilotDesk-Community-Preview.exe"))) 'Old EXE remains'
 Assert ((Test-Path -LiteralPath (Join-Path $root "$($names[0])\resources\video-autopilot-kit\SKILL.md")) -and (Get-PortableHash $state) -eq $before) 'Original governance or workflow changed'
 $backup=Join-Path $root "portable-preview-recovery\$($names[0]).json"
 $restored=& "$PSScriptRoot\restore-portable-preview.ps1" -Manifest $backup -ReplaceKitArchive|ConvertFrom-Json
 Assert ($restored.status -eq 'RESTORED' -and $restored.files -eq 4) 'Archived package did not restore independently'
 Assert ([IO.File]::ReadAllText((Join-Path $root "$($names[0])\AutopilotDesk-Community-Preview.exe")) -eq $names[0]) 'Restored EXE differs'
 $again=& "$PSScriptRoot\archive-pinned-previews.ps1" -Keep 1 -TestArtifactRoot $root -Apply|ConvertFrom-Json
 $marker=Join-Path $root "$($names[0])\ARCHIVED-KIT-SOURCE.json"
 $partial=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json;$partial.status='running';$partial|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $marker -Encoding UTF8
 $resumed=& "$PSScriptRoot\archive-pinned-previews.ps1" -Keep 1 -TestArtifactRoot $root -Apply|ConvertFrom-Json
 Assert ($resumed.archived -eq 1 -and $resumed.status -eq 'complete') 'Interrupted archive could not resume from its original backup'
 [pscustomobject]@{status='PASS';checks=@('latest-version retention','archive selection','backup-before-remove','original Kit path and workflow bytes','full byte-exact archive restoration','interrupted archive resume')}|ConvertTo-Json -Compress
}finally{if(Test-Path -LiteralPath $root){if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -ne $artifactRoot){throw 'Unsafe fixture root'};Assert-PortableRegular $root $true|Out-Null;Remove-Item -LiteralPath $root -Recurse -Force}}
