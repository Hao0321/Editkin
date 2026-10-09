$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lib\portable-recovery-compression.ps1')
$art=Get-PortableArtifactRoot $PSScriptRoot ''
$testRoot=Join-Path $art ('resource-dedup-self-test-'+[guid]::NewGuid().ToString('N'))
$names=@(1..4|ForEach-Object{'portable-preview-2000-01-0'+$_+'T00-00-00-000Z'})
function Assert($condition,$message){if(-not $condition){throw $message}}
$fixtureProcess=$null
try{
  foreach($name in $names){
    $package=Join-Path $testRoot $name
    New-Item -ItemType Directory -Path (Join-Path $package 'resources') -Force|Out-Null
    [IO.File]::WriteAllText((Join-Path $package 'AutopilotDesk-Community-Preview.exe'),$name+('x'*2097152))
    Set-Content -LiteralPath (Join-Path $package 'resources\fixture.txt') -Value 'original fixture resource'
  }
  & (Join-Path $PSScriptRoot 'backup-portable-preview.ps1') -Names $names -TestArtifactRoot $testRoot|Out-Null
  $oldManifestPath=Join-Path $testRoot ('portable-preview-recovery\'+$names[0]+'.json')
  $old=Get-Content -LiteralPath $oldManifestPath -Raw -Encoding UTF8|ConvertFrom-Json
  $sha=@($old.files|Where-Object{$_.path -eq 'AutopilotDesk-Community-Preview.exe'})[0].sha256
  $cold=Get-ColdRecoveryObject $testRoot $sha
  $oldPackage=[IO.Path]::GetFullPath((Join-Path $testRoot $names[0]))
  Assert ([IO.Path]::GetDirectoryName($oldPackage) -eq $testRoot) 'Old fixture package escaped root'
  Remove-Item -LiteralPath $oldPackage -Recurse -Force
  $protectedExe=Join-Path $testRoot ($names[3]+'\AutopilotDesk-Community-Preview.exe')
  $protectedSha=Get-PortableHash $protectedExe
  $protectedObject=Get-ColdRecoveryObject $testRoot $protectedSha
  $protectedBytes=[IO.File]::ReadAllBytes($protectedObject)
  Assert ([IO.Path]::GetDirectoryName($protectedObject) -eq (Join-Path $testRoot 'portable-preview-recovery\objects')) 'Protected fixture object escaped root'
  Remove-Item -LiteralPath $protectedObject -Force
  [IO.File]::WriteAllBytes($protectedObject,$protectedBytes)
  $anchor=Join-Path $testRoot 'shared-fixture.bin';[IO.File]::WriteAllText($anchor,'z'*2097152)
  $sharedSha=Get-PortableHash $anchor;$shared=Join-Path $testRoot ('portable-preview-recovery\objects\'+$sharedSha)
  [PortableResourceStorage]::Link($shared,$anchor)
  $old.files+=@([pscustomobject]@{path='resources\shared-fixture.bin';sha256=$sharedSha;bytes=(Get-Item -LiteralPath $anchor).Length})
  $old|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $oldManifestPath -Encoding UTF8
  $identity=[PortableResourceStorage]::Identity($cold)
  $dry=& (Join-Path $PSScriptRoot 'compress-cold-preview-recovery.ps1') -TestArtifactRoot $testRoot|ConvertFrom-Json
  Assert ($dry.mode -eq 'dry-run' -and $dry.objects -eq 1 -and -not((Get-Item -LiteralPath $cold).Attributes -band [IO.FileAttributes]::Compressed)) 'Dry-run changed storage or failed protections'
  $fixtureProcess=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('-e','"setTimeout(()=>{},20000)"',$cold) -WindowStyle Hidden -PassThru
  $busyRejected=$false
  try{& (Join-Path $PSScriptRoot 'compress-cold-preview-recovery.ps1') -TestArtifactRoot $testRoot -Apply|Out-Null}catch{$busyRejected=$true}
  Assert ($busyRejected -and -not((Get-Item -LiteralPath $cold).Attributes -band [IO.FileAttributes]::Compressed)) 'Process reference was not protected'
  if(-not $fixtureProcess.HasExited){$fixtureProcess|Stop-Process -Force;if(-not $fixtureProcess.WaitForExit(5000)){throw 'Owned fixture did not exit'}};$fixtureProcess=$null
  $applied=& (Join-Path $PSScriptRoot 'compress-cold-preview-recovery.ps1') -TestArtifactRoot $testRoot -Apply|ConvertFrom-Json
  Assert ($applied.status -eq 'complete' -and $applied.objects -eq 1 -and $applied.reclaimedBytesEstimate -gt 1000000) 'Cold compression did not reduce storage'
  Assert ((Get-PortableHash $cold) -eq $sha -and ([PortableResourceStorage]::Identity($cold)).Id -eq $identity.Id) 'Compression changed bytes or identity'
  Assert (-not((Get-Item -LiteralPath $shared).Attributes -band [IO.FileAttributes]::Compressed) -and -not((Get-Item -LiteralPath $protectedObject).Attributes -band [IO.FileAttributes]::Compressed)) 'Shared or latest recovery object was compressed'
  $restored=& (Join-Path $PSScriptRoot 'restore-portable-preview.ps1') -Manifest $oldManifestPath|ConvertFrom-Json
  Assert ($restored.status -eq 'RESTORED' -and (Get-PortableHash (Join-Path $oldPackage 'AutopilotDesk-Community-Preview.exe')) -eq $sha) 'Original package restore failed on compressed CAS'
  Assert ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($oldPackage)) -eq $testRoot) 'Restored package escaped fixture root'
  Remove-Item -LiteralPath $oldPackage -Recurse -Force
  $reversed=& (Join-Path $PSScriptRoot 'restore-cold-preview-recovery.ps1') -Manifest $applied.manifest -TestArtifactRoot $testRoot|ConvertFrom-Json
  Assert ($reversed.status -eq 'RESTORED' -and (Get-PortableHash $cold) -eq $sha -and -not((Get-Item -LiteralPath $cold).Attributes -band [IO.FileAttributes]::Compressed)) 'Compression reversal failed'
  [IO.File]::WriteAllText($cold,'q'*(Get-Item -LiteralPath $cold).Length)
  $corruptRejected=$false;try{& (Join-Path $PSScriptRoot 'compress-cold-preview-recovery.ps1') -TestArtifactRoot $testRoot -Apply|Out-Null}catch{$corruptRejected=$true}
  Assert $corruptRejected 'Corrupt referenced object was accepted'
  $unsafeRejected=$false;try{& (Join-Path $PSScriptRoot 'compress-cold-preview-recovery.ps1') -TestArtifactRoot $art|Out-Null}catch{$unsafeRejected=$true}
  Assert $unsafeRejected 'Test scope escaped its fixture root'
  [ordered]@{status='PASS';checks=@('dry-run','latest-three-protection','shared-object-protection','live-reference-protection','byte-and-identity-preserved','original-package-restore','compression-reversal','corrupt-object-rejection','isolated-root')}|ConvertTo-Json -Compress
}finally{
  if($fixtureProcess -and -not $fixtureProcess.HasExited){$fixtureProcess|Stop-Process -Force;if(-not $fixtureProcess.WaitForExit(5000)){throw 'Owned fixture did not exit'}}
  if((Test-Path -LiteralPath $testRoot) -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($testRoot)) -eq $art -and [IO.Path]::GetFileName($testRoot) -match '^resource-dedup-self-test-[a-f0-9]+$'){Remove-Item -LiteralPath $testRoot -Recurse -Force}
}
