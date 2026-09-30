import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listRemoteProviderConnectors } from "./remoteProviderConnectors";
import { errorResult } from "./toolRuntime";
import { prepareRemoteSetupInputSchema } from "./remoteOnboarding/proposal";
import { getRemoteSetupStatus } from "./remoteOnboarding/status";
import { configureRemoteAccess, prepareRemoteSetup } from "./remoteOnboarding/setup";
import { verifyRemoteAccess } from "./remoteOnboarding/verify";
import { configureOutputSchema, connectorListOutputSchema, prepareOutputSchema, statusOutputSchema, verifyOutputSchema } from "./remoteOnboarding/toolSchemas";

function structuredResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function listRemoteProviderConnectorStatus() {
  return {
    schema: "editkin.remote-provider-connector-list/v1" as const,
    status: "RESEARCH_ONLY_NO_EXTERNAL_ACTION" as const,
    connectors: listRemoteProviderConnectors().map((connector) => ({
      connectorId: connector.connectorId,
      connectorRevision: connector.connectorRevision,
      manifestSha256: connector.manifestSha256,
      providerId: connector.providerId,
      providerDisplayName: connector.providerDisplayName,
      productName: connector.productName,
      transport: connector.transport,
      availability: connector.availability,
      approvalAvailable: connector.approvalAvailable,
      attested: connector.attested,
      executionOwner: connector.executionOwner,
      authMode: connector.authMode,
      stableHttpsName: connector.stableHttpsName,
      supportedPublicPorts: connector.supportedPublicPorts,
      limitations: connector.limitations,
      sourceUrls: connector.sourceUrls,
    })),
    externalMutationToolAvailable: false as const,
    nextAction: "AI 只能選擇清單中的 connector 建立 proposal；目前沒有已 attested 且 enabled 的 connector，因此不能核准、登入或部署" as const,
  };
}

export function registerRemoteOnboardingTools(
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env,
  options: { includeConfigure?: boolean; includeVerify?: boolean } = {},
): void {
  server.registerTool("get_remote_setup_status", {
    description: "讀取 Editkin Remote 的 LAN／使用者自備跨網路設定與最後一次真實驗證 receipt；不讀取或回傳任何供應商密鑰。",
    inputSchema: z.object({}).strict(),
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return structuredResult(await getRemoteSetupStatus(environment)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("list_remote_provider_connectors", {
    description: "唯讀列出 Editkin closed registry 內的 Remote connector 研究狀態、限制與 manifest identity。不登入、不執行 provider CLI、不建立／刪除資源，也不開放 external mutation。",
    inputSchema: z.object({}).strict(),
    outputSchema: connectorListOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return structuredResult(listRemoteProviderConnectorStatus()); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_remote_setup", {
    description: "從 closed registry 選擇 connector，驗證並保存一份綁定 connector manifest 與 exact plan digest、有來源／價格／配額／權限／預計變更的非機密 Remote provider proposal v2。這一步不登入供應商、不部署、不付款、不寫正式設定，也不宣稱路由或手機連線已完成。",
    inputSchema: prepareRemoteSetupInputSchema,
    outputSchema: prepareOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try { return structuredResult(await prepareRemoteSetup(input, environment)); }
    catch (error) { return errorResult(error); }
  });

  if (options.includeConfigure !== false) {
    server.registerTool("configure_remote_access", {
      description: "只保留給舊版 confirmation receipt 的相容遷移：建立無密鑰公開 HTTPS origin 短效候選，仍須桌面核准。新版 provider proposal 沒有 proposal-bound approval／deployment receipt 時會明確拒絕；不接受 token、API key、cookie、密碼或自動部署。",
      inputSchema: z.object({
        confirmationId: z.string().uuid(),
        origin: z.string().url().max(2_048),
        userConfirmedDeployment: z.literal(true),
        userConfirmedProviderCosts: z.literal(true),
        userConfirmedProviderPermissions: z.literal(true),
      }).strict(),
      outputSchema: configureOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      try { return structuredResult(await configureRemoteAccess(input, environment)); }
      catch (error) { return errorResult(error); }
    });
  }

  if (options.includeVerify !== false) {
    server.registerTool("verify_remote_access", {
      description: "對桌面已核准的非機密 HTTPS origin，以預解析且固定的公開 IP 建立兩個全新 TLS socket，量測 route latency 與 jitter。真 Editkin challenge 也只會回 PARTIAL；沒有手機配對與斷線重連證據絕不宣稱端到端完成。",
      inputSchema: z.object({}).strict(),
      outputSchema: verifyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async () => {
      try { return structuredResult(await verifyRemoteAccess(environment)); }
      catch (error) { return errorResult(error); }
    });
  }
}
