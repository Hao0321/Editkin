import * as z from "zod/v4";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const parameterValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const pluginAutomationApplicationSchema = z.strictObject({
  applicationId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  pluginId: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  pluginVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  manifestSha256: sha256Schema,
  targetClipId: z.string().min(1).max(256),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), parameterValueSchema),
  commandIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
  commandsSha256: sha256Schema,
}).superRefine((application, context) => {
  if (Object.keys(application.parameters).length > 64) {
    context.addIssue({ code: "custom", path: ["parameters"], message: "外掛參數超過 64 個" });
  }
  if (new Set(application.commandIndexes).size !== application.commandIndexes.length) {
    context.addIssue({ code: "custom", path: ["commandIndexes"], message: "外掛 command index 不可重複" });
  }
  if (application.commandIndexes.some((value, index, values) => index > 0 && value <= values[index - 1])) {
    context.addIssue({ code: "custom", path: ["commandIndexes"], message: "外掛 command index 必須嚴格遞增" });
  }
});

export type PluginAutomationApplication = z.infer<typeof pluginAutomationApplicationSchema>;

export const autopilotExtensionsSchema = z.strictObject({
  skillSelection: z.unknown(),
  pluginApplications: z.array(pluginAutomationApplicationSchema).max(16),
});
