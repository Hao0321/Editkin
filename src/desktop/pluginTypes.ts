export interface PluginRegistrySummary {
  schema: "editkin.plugin-registry/v1";
  plugins: Array<{
    id: string; name: string; version: string; publisher: string; manifestSha256: string;
    permissions: Array<"project.read" | "project.write" | "media.read" | "render.effect" | "assets.read" | "knowledge.read" | "workflow.read">;
    capabilities: Array<{
      id: string; name: string; description: string; kind: string; automation: "full" | "assisted" | "manual";
      automationReady: boolean; planningReady: boolean; readiness: string; readinessDetail: string; semanticRoles: string[]; formats: string[];
      requires: string[]; avoidWhen: string[]; runtimeType: "editgraph_commands" | "native_effect" | "gpu_effect_graph" | "gpu_effect_module" | "asset_pack" | "knowledge_pack" | "skill_pack";
      packSha256?: string;
      commandScopes: Array<"clip" | "project">;
      parameters: Array<
        | { id: string; name: string; description?: string; type: "number"; default: number; min?: number; max?: number; step?: number }
        | { id: string; name: string; description?: string; type: "boolean"; default: boolean }
        | { id: string; name: string; description?: string; type: "string"; default: string; maxLength: number }
        | { id: string; name: string; description?: string; type: "enum"; default: string; options: Array<{ value: string; label: string }> }
        | { id: string; name: string; description?: string; type: "color"; default: string }
      >;
    }>;
  }>;
  diagnostics: Array<{ path: string; status: "BLOCKED"; error: string }>;
}
