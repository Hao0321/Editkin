param([ValidateRange(1,10)][int]$Keep=3,[ValidateRange(65536,1073741824)][long]$MinBytes=1048576,[switch]$Apply,[string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-recovery-compression.ps1')
$root=Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$inventorySummary=& (Join-Path $PSScriptRoot 'review-preview-recovery-inventory.ps1') -Keep $Keep -TestArtifactRoot $TestArtifactRoot|ConvertFrom-Json
$inventory=Get-Content -LiteralPath $inventorySummary.report -Raw -Encoding UTF8|ConvertFrom-Json
if($inventory.missingObjects.Count){throw 'Recovery inventory has missing objects'}
$entries=@(foreach($item in $inventory.entries){
  if($item.protected -or $item.links -ne 1 -or $item.bytes -lt $MinBytes -or -not $item.references.Count){continue}
  $path=Get-ColdRecoveryObject $root $item.sha256;$file=Get-Item -LiteralPath $path
  if($file.Attributes -band ([IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::SparseFile)){continue}
  if((Get-PortableHash $path) -ne $item.sha256){throw 'Cold recovery object failed hash verification'}
  [pscustomobject]@{sha256=$item.sha256;bytes=$item.bytes;fileId=$item.fileId;beforeStorageBytes=[PortableRecoveryAllocation]::Bytes($path);afterStorageBytes=$null;state='planned'}
})
if(-not $Apply){[pscustomobject]@{mode='dry-run';objects=$entries.Count;logicalBytes=($entries|Measure-Object bytes -Sum).Sum;protectedPackages=$inventory.protectedPackages;inventory=$inventorySummary.report}|ConvertTo-Json -Depth 4 -Compress;return}
$manifestPath=Join-Path $root ('cold-recovery-compression-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json')
$workflowHashes=Get-PortableWorkflowHashes $root
$manifest=[ordered]@{schema='editkin-cold-recovery-compression/v1';status='running';ownerPid=$PID;inventory=$inventorySummary.report;entries=$entries;reclaimedBytesEstimate=0L;
  recovery='Byte-identical NTFS storage; original package manifests and restore-portable-preview.ps1 remain usable. restore-cold-preview-recovery.ps1 reverses the compression attribute.'}
function Save-ColdCompression {$manifest|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $manifestPath -Encoding UTF8}
Save-ColdCompression
try{
  foreach($entry in $entries){
    $path=Get-ColdRecoveryObject $root $entry.sha256;$identity=[PortableResourceStorage]::Identity($path)
    if($identity.Id -ne $entry.fileId -or $identity.Links -ne 1 -or $identity.Bytes -ne $entry.bytes -or (Get-PortableHash $path) -ne $entry.sha256){throw 'Cold object changed or became shared; preserve it'}
    # A new package link or a normal app using this CAS path must block compression.
    foreach($process in @(Get-CimInstance Win32_Process)){if(($process.ExecutablePath -eq $path)-or($process.CommandLine -and $process.CommandLine.IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0)){throw 'Cold object is in use'}}
    $entry.state='compressing';Save-ColdCompression
    Set-ColdRecoveryCompression $path $true
    $after=[PortableResourceStorage]::Identity($path)
    if((Get-PortableHash $path) -ne $entry.sha256 -or $after.Id -ne $entry.fileId -or $after.Links -ne 1 -or -not((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::Compressed)){throw 'Compressed object verification failed'}
    $entry.afterStorageBytes=[PortableRecoveryAllocation]::Bytes($path)
    $entry.state='compressed';$manifest.reclaimedBytesEstimate += $entry.beforeStorageBytes-$entry.afterStorageBytes;Save-ColdCompression
  }
  Assert-PortableWorkflowHashes $workflowHashes
  $manifest.status='complete'
}catch{$manifest.status='partial';throw}finally{Save-ColdCompression}
[pscustomobject]@{status=$manifest.status;objects=$entries.Count;reclaimedBytesEstimate=$manifest.reclaimedBytesEstimate;manifest=$manifestPath}|ConvertTo-Json -Compress
