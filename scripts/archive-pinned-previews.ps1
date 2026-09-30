param([ValidateRange(1,20)][int]$Keep=3,[switch]$Apply,[string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$root=Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$previews=@(Get-ChildItem -LiteralPath $root -Directory|Where-Object{
  if($_.Name -notmatch $script:PortablePreviewPattern){return $false}
  if(Test-Path -LiteralPath (Join-Path $_.FullName 'AutopilotDesk-Community-Preview.exe')){return $true}
  $marker=Join-Path $_.FullName 'ARCHIVED-KIT-SOURCE.json'
  if(Test-Path -LiteralPath $marker){Assert-PortableRegular $marker $false|Out-Null;return (Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json).status -ne 'complete'}
  return $false
}|Sort-Object Name -Descending)
$latest=@($previews|Select-Object -First $Keep|ForEach-Object Name)
$running=@(Get-PortableRunningNames $root $previews.Name)
$workflows=@(Get-PortableWorkflowHashes $root)
$pins=@{}
foreach($workflow in $workflows){
  $state=Get-Content -LiteralPath $workflow.path -Raw -Encoding UTF8|ConvertFrom-Json
  if(-not $state.governance.skill_path){continue}
  $skill=[IO.Path]::GetFullPath($state.governance.skill_path)
  foreach($preview in $previews){
    if($skill.StartsWith($preview.FullName+'\',[StringComparison]::OrdinalIgnoreCase)){
      $kit=Join-Path $preview.FullName 'resources\video-autopilot-kit'
      if(-not $skill.StartsWith($kit+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Pinned governance is outside the supported Kit source tree'}
      $pins[$preview.Name]=$true
      # Keep cleanup conservative when a durable state names other old-package resources.
      $stateText=Get-Content -LiteralPath $workflow.path -Raw -Encoding UTF8
      if($stateText.Replace('\\','\').Contains($preview.FullName+'\resources\runtime\') -or
         $stateText.Replace('\\','\').Contains($preview.FullName+'\resources\fonts\')){throw 'Workflow depends on old execution resources; preserve package'}
    }
  }
}
$targets=@($previews|Where-Object{$latest -notcontains $_.Name -and $running -notcontains $_.Name -and $pins.ContainsKey($_.Name)})
$summary=[ordered]@{mode=if($Apply){'apply'}else{'dry-run'};latest=$latest;protectedRunning=$running;pinnedArchiveCount=$targets.Count}
if(-not $Apply){$summary|ConvertTo-Json -Compress;return}
$manifestPath=Join-Path $root ('pinned-preview-archive-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json')
$log=[ordered]@{schema='editkin-pinned-preview-archive/v1';workflowHashes=$workflows;latest=$latest;protectedRunning=$running;archived=@();status='running'}
function Save-Archive { $log|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $manifestPath -Encoding UTF8 }
Save-Archive
try{
  foreach($preview in $targets){
    if(@(Get-PortableRunningNames $root @($preview.Name)).Count){throw 'Package started before archive'}
    $marker=Join-Path $preview.FullName 'ARCHIVED-KIT-SOURCE.json'
    $resuming=Test-Path -LiteralPath $marker
    if($resuming){
      Assert-PortableRegular $marker $false|Out-Null
      $prior=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json
      $expected=Join-Path $root "portable-preview-recovery\$($preview.Name).json"
      if($prior.schema -ne 'editkin-kit-source-archive/v1' -or $prior.name -ne $preview.Name -or $prior.recoveryManifest -ne $expected){throw 'Invalid interrupted archive'}
      $backup=[pscustomobject]@{manifest=$expected}
    }else{$backup=& "$PSScriptRoot\backup-portable-preview.ps1" -Names @($preview.Name) -TestArtifactRoot $TestArtifactRoot | ConvertFrom-Json}
    $data=Get-Content -LiteralPath $backup.manifest -Raw -Encoding UTF8|ConvertFrom-Json
    if($data.schema -ne 'editkin-portable-preview-recovery/v1' -or $data.name -ne $preview.Name){throw 'Invalid original package backup'}
    foreach($file in $data.files){
      if([IO.Path]::IsPathRooted($file.path) -or $file.path -match '(^|[\\/])\.\.([\\/]|$)|:' -or [IO.Path]::GetFileName($file.path) -match '^(\.env|\.dev\.vars|id_rsa|id_ed25519)$|\.(pem|key)$'){throw 'Unsafe backup path'}
      if($file.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-PortableHash (Join-Path (Join-Path $root 'portable-preview-recovery\objects') $file.sha256)) -ne $file.sha256){throw 'Backup failed resume verification'}
    }
    $keepFiles=@($data.files|Where-Object{$_.path -match '^resources[\\/]video-autopilot-kit[\\/]'})
    if(-not @($keepFiles|Where-Object{$_.path -match '[\\/]SKILL\.md$'}).Count){throw 'Pinned Kit source is incomplete'}
    $record=[ordered]@{schema='editkin-kit-source-archive/v1';name=$preview.Name;recoveryManifest=$backup.manifest;kept=$keepFiles;status='running'}
    $record|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $marker -Encoding UTF8
    if(@(Get-PortableRunningNames $root @($preview.Name)).Count){throw 'Package started during backup'}
    # Remove the EXE first after protection was rechecked; an archived package cannot be launched midway.
    $orderedFiles=@($data.files|Sort-Object @{Expression={if($_.path -eq 'AutopilotDesk-Community-Preview.exe'){0}else{1}}})
    foreach($file in $orderedFiles){
      if($keepFiles.path -contains $file.path){continue}
      $path=[IO.Path]::GetFullPath((Join-Path $preview.FullName $file.path))
      if(-not $path.StartsWith($preview.FullName+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Archive escaped package'}
      if($resuming -and -not(Test-Path -LiteralPath $path)){continue}
      Assert-PortableRegular $path $false | Out-Null
      if((Get-PortableHash $path) -ne $file.sha256){throw 'Package changed after backup'}
      Remove-Item -LiteralPath $path -Force
    }
    $directories=@(Get-ChildItem -LiteralPath $preview.FullName -Directory -Recurse|Sort-Object {$_.FullName.Length} -Descending)
    foreach($directory in $directories){Assert-PortableRegular $directory.FullName $true|Out-Null;if(@(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -eq 0){Remove-Item -LiteralPath $directory.FullName -Force}}
    foreach($file in $keepFiles){if((Get-PortableHash (Join-Path $preview.FullName $file.path)) -ne $file.sha256){throw 'Original Kit source changed'}}
    $record.status='complete';$record|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $marker -Encoding UTF8
    $log.archived+=$record;Save-Archive
  }
  Assert-PortableWorkflowHashes $workflows
  $log.status='complete';Save-Archive
}catch{$log.status='partial';Save-Archive;throw}
$summary.archived=$log.archived.Count;$summary.manifest=$manifestPath;$summary.status=$log.status
$summary|ConvertTo-Json -Compress
