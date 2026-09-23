import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function inspectAuthenticode(path) {
  if (process.platform !== "win32") return { status: "NOT_CHECKED", reason: "Authenticode check requires Windows" };
  const bytes = readFileSync(path);
  if (bytes.length < 64) return { Status: "InvalidFile", certificateTableBytes: 0 };
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 140 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    return { Status: "InvalidFile", certificateTableBytes: 0 };
  }
  const optionalHeader = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96);
  const certificateFileOffset = bytes.readUInt32LE(dataDirectories + 8 * 4);
  const certificateTableBytes = bytes.readUInt32LE(dataDirectories + 8 * 4 + 4);
  if (certificateFileOffset === 0 || certificateTableBytes === 0) return { Status: "NotSigned", certificateTableBytes: 0 };
  const command = "$value=Get-AuthenticodeSignature -LiteralPath $env:EDITKIN_SIGNATURE_TARGET; $cert=$value.SignerCertificate; $sha256=if($cert){[BitConverter]::ToString($cert.GetCertHash([Security.Cryptography.HashAlgorithmName]::SHA256)).Replace('-','').ToLowerInvariant()}else{$null}; $value | Select-Object Status,StatusMessage,@{n='SignerSubject';e={$cert.Subject}},@{n='Thumbprint';e={$cert.Thumbprint}},@{n='CertificateSha256';e={$sha256}} | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, EDITKIN_SIGNATURE_TARGET: path },
  });
  if (result.status !== 0 || !result.stdout.trim()) return { Status: "SignaturePresentUnverified", certificateTableBytes, reason: result.stderr.trim() || `exit ${result.status}` };
  try { return { ...JSON.parse(result.stdout), certificateTableBytes }; }
  catch { return { Status: "SignaturePresentUnverified", certificateTableBytes, reason: result.stdout.trim() }; }
}
