// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
export type OpenCodeAttachment = {
  name: string;
  mimeType: string;
  text?: string;
  data?: string;
};

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "text/vtt"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function matchesImageSignature(mimeType: string, bytes: Buffer) {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export function openCodePromptParts(text: string, attachments: OpenCodeAttachment[] = []) {
  if (!Array.isArray(attachments) || attachments.length > 4) throw new Error("最多附加 4 個檔案");
  let totalBytes = 0;
  const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const item of attachments) {
    if (!item || typeof item.name !== "string" || !item.name || item.name.length > 180 || /[\\/\x00-\x1f]/u.test(item.name))
      throw new Error("附件名稱不合法");
    if (imageTypes.has(item.mimeType)) {
      if (typeof item.data !== "string" || item.text !== undefined || item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.data))
        throw new Error("圖片附件格式不合法");
      const bytes = Buffer.from(item.data, "base64");
      if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("圖片附件須小於 4 MiB");
      if (!matchesImageSignature(item.mimeType, bytes)) throw new Error("圖片內容與宣告格式不符");
      totalBytes += bytes.byteLength;
      parts.push({ type: "image", mimeType: item.mimeType, data: item.data,
        uri: `file:///editkin-attachment/${encodeURIComponent(item.name)}` });
    } else if (textTypes.has(item.mimeType)) {
      if (typeof item.text !== "string" || item.data !== undefined) throw new Error("文字附件格式不合法");
      const bytes = Buffer.byteLength(item.text, "utf8");
      if (!bytes || bytes > MAX_TEXT_BYTES) throw new Error("文字附件須小於 512 KiB");
      totalBytes += bytes;
      parts.push({ type: "resource", resource: { uri: `editkin-attachment://local/${encodeURIComponent(item.name)}`,
        mimeType: item.mimeType, text: item.text } });
    } else throw new Error("附件只支援文字、字幕、JSON 與 PNG/JPEG/GIF/WebP 圖片");
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("附件總量須小於 8 MiB");
  }
  return parts;
}
