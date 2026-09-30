. (Join-Path $PSScriptRoot 'portable-resource-storage.ps1')
if(-not ('PortableRecoveryAllocation' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PortableRecoveryAllocation {
  // https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetCompressedFileSizeW(string path,out uint high);
  public static long Bytes(string path){uint high;uint low=GetCompressedFileSizeW(path.StartsWith(@"\\?\")?path:@"\\?\"+path,out high);int error=Marshal.GetLastWin32Error();
    if(low==uint.MaxValue&&error!=0)throw new Win32Exception(error);return ((long)high<<32)|low;}
}
'@
}
function Get-ColdRecoveryObject([string]$Root,[string]$Sha){
  if($Sha -notmatch '^[a-f0-9]{64}$'){throw 'Invalid cold recovery hash'}
  $objects=Assert-PortableObjectRoot $Root $false
  $path=[IO.Path]::GetFullPath((Join-Path $objects $Sha))
  if([IO.Path]::GetDirectoryName($path) -ne $objects){throw 'Cold object escaped recovery root'}
  Assert-PortableRegular $path $false|Out-Null
  return $path
}
function Set-ColdRecoveryCompression([string]$Path,[bool]$Compress){
  $command=Join-Path $env:SystemRoot 'System32\compact.exe'
  if(-not(Test-Path -LiteralPath $command)){throw 'Windows compact tool is unavailable'}
  $mode=if($Compress){'/C'}else{'/U'}
  # Exact hash filename, no recursive operation or directory compression flag.
  & $command $mode /A /F /Q $Path 2>&1|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Windows file compression failed; preserve the operation manifest'}
}
