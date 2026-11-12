param([Parameter(Mandatory=$true)][string]$Manifest,[string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-recovery-compression.ps1')
$root=Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$manifestPath=[IO.Path]::GetFullPath($Manifest)
if([IO.Path]::GetDirectoryName($manifestPath) -ne $root -or [IO.Path]::GetFileName($manifestPath) -notmatch '^cold-recovery-compression-\d{8}T\d{9}Z\.json$'){throw 'Invalid cold restore manifest'}
Assert-PortableRegular $manifestPath $false|Out-Null
$data=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if($data.schema -ne 'editkin-cold-recovery-compression/v1' -or $data.status -notin @('complete','partial','running')){throw 'Invalid cold restore state'}
if($data.status -eq 'running' -and (-not $data.ownerPid -or @(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$data.ownerPid)").Count)){throw 'Compression owner still exists'}
$entries=@($data.entries|Where-Object{$_.state -in @('compressed','compressing')})
$seen=@{}
foreach($entry in $entries){
  $path=Get-ColdRecoveryObject $root $entry.sha256;$identity=[PortableResourceStorage]::Identity($path)
  if($seen.ContainsKey($entry.sha256) -or $identity.Id -ne $entry.fileId -or $identity.Links -ne 1 -or (Get-PortableHash $path) -ne $entry.sha256){throw 'Cold restore object differs or became shared'}
  $seen[$entry.sha256]=$true
}
foreach($entry in $entries){
  $path=Get-ColdRecoveryObject $root $entry.sha256;$identity=[PortableResourceStorage]::Identity($path)
  if($identity.Id -ne $entry.fileId -or $identity.Links -ne 1 -or (Get-PortableHash $path) -ne $entry.sha256){throw 'Cold restore object changed'}
  foreach($process in @(Get-CimInstance Win32_Process)){if(($process.ExecutablePath -eq $path)-or($process.CommandLine -and $process.CommandLine.IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0)){throw 'Cold object is in use'}}
  Set-ColdRecoveryCompression $path $false
  if((Get-PortableHash $path) -ne $entry.sha256 -or ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::Compressed)){throw 'Cold restore failed verification'}
}
[pscustomobject]@{status='RESTORED';objects=$entries.Count;sourceManifest=$manifestPath}|ConvertTo-Json -Compress
