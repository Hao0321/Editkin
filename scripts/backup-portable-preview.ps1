param([Parameter(Mandatory=$true)][string[]]$Names,[string]$TestArtifactRoot='')
. (Join-Path $PSScriptRoot 'lib\portable-resource-storage.ps1')
$root=Get-PortableArtifactRoot $PSScriptRoot $TestArtifactRoot
$objects=Assert-PortableObjectRoot $root $true
$results=@()
foreach($name in ($Names|Select-Object -Unique)) {
  if($name -notmatch $script:PortablePreviewPattern){throw 'Invalid backup package'}
  $package=[IO.Path]::GetFullPath((Join-Path $root $name))
  if([IO.Path]::GetDirectoryName($package) -ne $root){throw 'Backup escaped root'}
  Assert-PortableRegular $package $true | Out-Null
  $items=@(Get-ChildItem -LiteralPath $package -Force -Recurse)
  if(@($items|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Backup contains a reparse point'}
  $files=@($items|Where-Object{-not $_.PSIsContainer})
  if(@($files|Where-Object{$_.Name -match '^(\.env|\.dev\.vars|id_rsa|id_ed25519)$|\.(pem|key)$'}).Count){throw 'Secret-like package file; do not read it'}
  $manifestPath=Join-Path (Join-Path $root 'portable-preview-recovery') ($name+'.json')
  $entries=@()
  foreach($file in $files){
    $sha=Get-PortableHash $file.FullName
    $object=Join-Path $objects $sha
    if(-not(Test-Path -LiteralPath $object)){[PortableResourceStorage]::Link($object,$file.FullName)}
    Assert-PortableRegular $object $false | Out-Null
    if((Get-PortableHash $object) -ne $sha){throw 'Backup object failed verification'}
    $entries+=[pscustomobject]@{path=$file.FullName.Substring($package.Length+1);sha256=$sha;bytes=$file.Length}
  }
  if(-not @($entries|Where-Object{$_.path -eq 'AutopilotDesk-Community-Preview.exe'}).Count){throw 'No complete EXE to back up'}
  if(Test-Path -LiteralPath $manifestPath){
    $old=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
    if($old.schema -ne 'editkin-portable-preview-recovery/v1' -or ($old.files|ConvertTo-Json -Depth 4 -Compress) -ne ($entries|ConvertTo-Json -Depth 4 -Compress)){throw 'Existing backup differs; do not overwrite it'}
  } else {
    [pscustomobject]@{schema='editkin-portable-preview-recovery/v1';name=$name;files=$entries}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $manifestPath -Encoding UTF8
  }
  $results+=[pscustomobject]@{name=$name;files=$entries.Count;manifest=$manifestPath;status='VERIFIED'}
}
$results|ConvertTo-Json -Depth 4 -Compress
