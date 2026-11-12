// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { openCodePromptParts } from "./openCodePrompt";

describe("OpenCode ACP prompt attachments", () => {
  it("keeps a lyric sheet as an embedded resource and an image as a native image block", () => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const parts = openCodePromptParts("請依歌詞分析鏡頭", [
      { name: "lyrics.lrc", mimeType: "text/plain", text: "[00:01.00]第一句" },
      { name: "reference.png", mimeType: "image/png", data: pixel },
    ]);
    expect(parts).toEqual([
      { type: "text", text: "請依歌詞分析鏡頭" },
      { type: "resource", resource: { uri: "editkin-attachment://local/lyrics.lrc", mimeType: "text/plain", text: "[00:01.00]第一句" } },
      { type: "image", mimeType: "image/png", data: pixel, uri: "file:///editkin-attachment/reference.png" },
    ]);
  });

  it("rejects unsafe names, unsupported content and oversized text before sending", () => {
    expect(() => openCodePromptParts("x", [{ name: "../secret.txt", mimeType: "text/plain", text: "x" }])).toThrow("附件名稱不合法");
    expect(() => openCodePromptParts("x", [{ name: "song.mp3", mimeType: "audio/mpeg", data: "aW1hZ2U=" }])).toThrow("附件只支援");
    expect(() => openCodePromptParts("x", [{ name: "large.txt", mimeType: "text/plain", text: "a".repeat(512 * 1024 + 1) }])).toThrow("文字附件須小於");
    expect(() => openCodePromptParts("x", [{ name: "invalid.png", mimeType: "image/png", data: Buffer.from("bad image").toString("base64") }])).toThrow("圖片內容與宣告格式不符");
  });
});
