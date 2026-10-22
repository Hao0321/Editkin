import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readLongformCaptionDraftV1 } from "../application/longformCaptionDraftV1";
import { longformWordRuntimeV1 } from "./longformWordTimingToolsV1";
import { errorResult, textResult } from "./toolRuntime";

export const longformCaptionDraftInputV1 = z.strictObject({ artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  maxCharacters: z.number().int().min(2).max(80).default(15),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(200).default(100) });
export const LONGFORM_CAPTION_DRAFT_RESPONSE_BYTES_V1 = 256 * 1024;
export function registerLongformCaptionDraftToolsV1(server: McpServer, environment: NodeJS.ProcessEnv = process.env,
  read: typeof readLongformCaptionDraftV1 = readLongformCaptionDraftV1) {
  server.registerTool("read_longform_caption_draft", {
    description: "唯讀分頁產生長片字幕草稿：套用既定詞彙修正與不斷詞規則，時間沿用實際辨識字詞，原始 ASR 快取保留。回來源詞索引、原始 ASR 問題數與換行問題；超長不可拆詞保留並標待確認。每頁最多200句，仍需作者核對內容，不套用或修改專案。",
    inputSchema: longformCaptionDraftInputV1,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const request = longformCaptionDraftInputV1.parse(input);
      const result = await read(longformWordRuntimeV1(environment), request.artifactId, request.maxCharacters, request.offset, request.limit);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > LONGFORM_CAPTION_DRAFT_RESPONSE_BYTES_V1)
        throw Error("CAPTION_DRAFT_RESPONSE_BUDGET: reduce limit; review an indivisible oversized word in the source");
      return textResult(result);
    } catch (error) { return errorResult(error); }
  });
}
