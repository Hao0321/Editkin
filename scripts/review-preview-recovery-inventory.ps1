param([ValidateRange(1,10)][int]$Keep=3,[string]$OutputName='',[string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$root=Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$objects=Assert-PortableObjectRoot $root $false
$manifests=@(Get-ChildItem -LiteralPath (Split-Path $objects -Parent) -File | Where-Object{$_.Name -match '^portable-preview-.*\.json$'})
$packages=@(Get-ChildItem -LiteralPath $root -Directory | Where-Object{$_.Name -match $script:PortablePreviewPattern})
$full=@($packages|Where-Object{Test-Path -LiteralPath (Join-Path $_.FullName 'AutopilotDesk-Community-Preview.exe')}|Sort-Object Name -Descending)
$running=@(Get-PortableRunningNames $root @($packages.Name))
$protectedNames=@(@($full|Select-Object -First $Keep|ForEach-Object{$_.Name})+$running|Sort-Object -Unique)
$refs=@{}; $protected=@{}; $sources=@{}; $missing=@()
foreach($path in $manifests){
  $manifest=Get-Content -LiteralPath $path.FullName -Raw -Encoding UTF8|ConvertFrom-Json
  if($manifest.schema -ne 'editkin-portable-preview-recovery/v1' -or $manifest.name+'.json' -ne $path.Name){throw 'Invalid recovery inventory manifest'}
  foreach($file in $manifest.files){
    if($file.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid recovery hash'}
    if(-not $refs.ContainsKey($file.sha256)){$refs[$file.sha256]=@()}
    $refs[$file.sha256]+=$manifest.name
    if($protectedNames -contains $manifest.name){$protected[$file.sha256]=$true}
    if(-not(Test-Path -LiteralPath (Join-Path $objects $file.sha256))){$missing+=$file.sha256}
  }
}
foreach($package in $packages){
  $marker=Join-Path $package.FullName 'ARCHIVED-KIT-SOURCE.json'
  if(Test-Path -LiteralPath $marker){
    $archive=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json
    if($archive.schema -ne 'editkin-kit-source-archive/v1' -or $archive.status -ne 'complete'){throw 'Incomplete Kit source archive'}
    foreach($file in $archive.kept){$sources[$file.sha256]=$true; $protected[$file.sha256]=$true}
  }
}
$entries=@(foreach($item in @(Get-ChildItem -LiteralPath $objects -File)){
  if($item.Name -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected recovery object name'}
  Assert-PortableRegular $item.FullName $false|Out-Null
  $identity=[PortableResourceStorage]::Identity($item.FullName)
  [pscustomobject]@{sha256=$item.Name;bytes=$item.Length;links=$identity.Links;fileId=$identity.Id;
    references=@($refs[$item.Name]|Sort-Object -Unique);protected=$protected.ContainsKey($item.Name);kitSource=$sources.ContainsKey($item.Name)}
})
$cold=@($entries|Where-Object{-not $_.protected -and $_.links -eq 1})
$report=[ordered]@{schema='editkin-preview-recovery-inventory/v1';status='READ_ONLY';createdAt=[DateTime]::UtcNow.ToString('o');
  root=$root;keep=$Keep;protectedPackages=$protectedNames;runningPackages=$running;manifestCount=$manifests.Count;
  objectCount=$entries.Count;logicalBytes=($entries|Measure-Object bytes -Sum).Sum;candidateColdObjectCount=$cold.Count;
  candidateColdBytes=($cold|Measure-Object bytes -Sum).Sum;missingObjects=@($missing|Sort-Object -Unique);entries=$entries;
  note='Referenced cold objects are complete historical rollback data, not disposable caches. No object was changed or removed.'}
if(-not $OutputName){$OutputName='preview-recovery-inventory-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json'}
if($OutputName -notmatch '^preview-recovery-inventory-[a-zA-Z0-9-]+\.json$'){throw 'Inventory output must be a named report in the artifact root'}
$output=Join-Path $root $OutputName
$report|ConvertTo-Json -Depth 7|Set-Content -LiteralPath $output -Encoding UTF8
[pscustomobject]@{status=$report.status;manifestCount=$report.manifestCount;objectCount=$report.objectCount;
  bytes=$report.logicalBytes;candidateColdBytes=$report.candidateColdBytes;missing=$report.missingObjects.Count;report=$output}|ConvertTo-Json -Compress
