export interface ProductAgentRuntimeResource {
  /** App-relative posix path of the source file. */
  source: string;
  /** Posix path relative to the delivered agent-runtime-v3 folder. */
  destination: string;
}

export const PRODUCT_AGENT_RUNTIME_DIRECTORY: "agent-runtime-v3";
export const PRODUCT_AGENT_LAUNCHER_SOURCE: "scripts/editkin-product-mcp-launcher.mjs";
export const PRODUCT_AGENT_LAUNCHER_DESTINATION: "launcher.mjs";
export const PRODUCT_AGENT_CONTRACT_SOURCE: "src/shared/agentSetupContract.json";
export const PRODUCT_AGENT_CONTRACT_DESTINATION: "agent-setup-contract.json";

export function productAgentLauncherModuleClosure(appRoot: string): ProductAgentRuntimeResource[];
export function productAgentRuntimeResources(appRoot: string): ProductAgentRuntimeResource[];
export function productAgentRuntimeInventory(appRoot: string): string[];
export function productAgentTauriResourceMappings(appRoot: string): Map<string, string>;
