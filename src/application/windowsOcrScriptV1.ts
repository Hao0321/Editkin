/** Fixed program; image and language are separate -File arguments, never code.
 * Windows OCR executes inside this process; no external child or network route. */
export const WINDOWS_OCR_SCRIPT_V1 = String.raw`param([Parameter(Mandatory=$true)][string]$ImagePath,[Parameter(Mandatory=$true)][string]$LanguageTag)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$taskAsTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' } | Select-Object -First 1
function Get-TaskResult($Operation,[Type]$ResultType){
  $task=$taskAsTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  if(-not $task.Wait(5000)){throw 'OCR_OPERATION_TIMEOUT'}
  return $task.Result
}
$taskLanguage=New-Object Windows.Globalization.Language($LanguageTag)
$taskEngine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($taskLanguage)
if($null -eq $taskEngine){throw 'OCR_LANGUAGE_NOT_INSTALLED'}
if($taskEngine.RecognizerLanguage.LanguageTag -ne $LanguageTag){throw 'OCR_LANGUAGE_SUBSTITUTION'}
$taskFile=Get-TaskResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$taskStream=$null;$taskBitmap=$null;$taskConverted=$null
try{
  $taskStream=Get-TaskResult ($taskFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $taskDecoder=Get-TaskResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($taskStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  if($taskDecoder.PixelWidth -gt 1280 -or $taskDecoder.PixelHeight -gt 1280 -or $taskDecoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $taskDecoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'OCR_IMAGE_DIMENSION'}
  $taskScale=2
  $taskTransform=New-Object Windows.Graphics.Imaging.BitmapTransform
  $taskTransform.ScaledWidth=[uint32]($taskDecoder.PixelWidth*$taskScale)
  $taskTransform.ScaledHeight=[uint32]($taskDecoder.PixelHeight*$taskScale)
  $taskTransform.InterpolationMode=[Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
  if($taskTransform.ScaledWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $taskTransform.ScaledHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'OCR_RECOGNITION_DIMENSION'}
  $taskBitmap=Get-TaskResult ($taskDecoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,$taskTransform,[Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $taskConverted=[Windows.Graphics.Imaging.SoftwareBitmap]::Convert($taskBitmap,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)
  $taskResult=Get-TaskResult ($taskEngine.RecognizeAsync($taskConverted)) ([Windows.Media.Ocr.OcrResult])
  $taskLines=@();$taskLineIndex=0;$taskWordCount=0;$taskTextCount=0
  foreach($taskLine in $taskResult.Lines){
    if($taskLineIndex -ge 512){throw 'OCR_LINE_BUDGET'}
    $taskWords=@();$taskWordIndex=0
    foreach($taskWord in $taskLine.Words){
      $taskWordCount++;$taskTextCount+=$taskWord.Text.Length
      if($taskWordCount -gt 4096){throw 'OCR_WORD_BUDGET'}
      $taskRect=$taskWord.BoundingRect
      $taskWords += [pscustomobject]@{index=$taskWordIndex;text=$taskWord.Text;x=$taskRect.X/$taskScale;y=$taskRect.Y/$taskScale;width=$taskRect.Width/$taskScale;height=$taskRect.Height/$taskScale}
      $taskWordIndex++
    }
    $taskTextCount+=$taskLine.Text.Length
    if($taskTextCount -gt 65536){throw 'OCR_TEXT_BUDGET'}
    $taskLines += [pscustomobject]@{index=$taskLineIndex;text=$taskLine.Text;words=$taskWords}
    $taskLineIndex++
  }
  $taskRuntime=[pscustomobject]@{powershellVersion=$PSVersionTable.PSVersion.ToString();osVersion=[Environment]::OSVersion.VersionString;maximumImageDimension=[Windows.Media.Ocr.OcrEngine]::MaxImageDimension;languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})}
  $taskProcessing=[pscustomobject]@{scale=$taskScale;recognitionWidth=$taskConverted.PixelWidth;recognitionHeight=$taskConverted.PixelHeight;interpolation='cubic';coordinates='recognition-rectangles-divided-by-scale'}
  [pscustomobject]@{engine='Windows.Media.Ocr';language=$taskEngine.RecognizerLanguage.LanguageTag;width=$taskDecoder.PixelWidth;height=$taskDecoder.PixelHeight;processing=$taskProcessing;textAngle=$taskResult.TextAngle;runtime=$taskRuntime;lines=$taskLines} | ConvertTo-Json -Depth 7 -Compress
}finally{
  if($null -ne $taskConverted){$taskConverted.Dispose()};if($null -ne $taskBitmap){$taskBitmap.Dispose()};if($null -ne $taskStream){$taskStream.Dispose()}
}
`;
