import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { designRequestSchema, assertDesignDecisionBinding, type DesignRequest } from "../application/autopilotDesignContract";
import type { CurrentAutopilotPlan } from "../application/autopilotPlan";
import { readLiveAutopilotIdentity, resolveLiveVideoAutopilotSkillPath, sha256Canonical } from "../application/autopilotInvocationIdentity";
import { assertMotionTreatmentBinding } from "../application/motionTreatment";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { readProject } from "./storage";

export interface CurrentDesignBrief {
  schema: "hao.editkin.current-design-brief/v1";
  request: DesignRequest;
  sources: { path: string; sha256: string }[];
  sourceSha256: string;
  context: unknown;
  recipes: { beatId: string; recipe: { route: { primary_family: string }; [key: string]: unknown } }[];
}
export async function compileCurrentDesign(request: DesignRequest, options: { skillPath?: string; pluginRoots?: string[] } = {}): Promise<CurrentDesignBrief> {
  const skillPath = await resolveLiveVideoAutopilotSkillPath(options.skillPath);
  await readLiveAutopilotIdentity({ skillPath, pluginRoots: options.pluginRoots });
  const script = resolve(dirname(skillPath), "editkin_design_bridge.py");
  const { stdout } = await promisify(execFile)(process.env.EDITKIN_PYTHON_EXECUTABLE ?? "python", ["-X", "utf8", script, "--request-json", JSON.stringify(request)], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  const brief = JSON.parse(stdout) as CurrentDesignBrief;
  if (brief.schema !== "hao.editkin.current-design-brief/v1" ||
      sha256Canonical(brief.request) !== sha256Canonical(request) ||
      !Array.isArray(brief.sources) || brief.sources.length === 0 ||
      brief.sources.some(row => !row || typeof row.path !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) ||
      brief.sourceSha256 !== sha256Canonical(brief.sources) ||
      !Array.isArray(brief.recipes) || brief.recipes.length !== request.beats.length ||
      brief.recipes.some((row, i) => row.beatId !== request.beats[i].id || !row.recipe?.route?.primary_family)) {
    throw new Error("Current Skill design compiler returned an invalid brief");
  }
  return brief;
}

export function designIdentity(brief: CurrentDesignBrief, project: EditProject) {
  return { projectSha256: sha256Canonical(project), sourceSha256: brief.sourceSha256, briefSha256: sha256Canonical(brief) };
}

// Stateless and deterministic: a paused batch can re-read the same current brief
// after a host restart. Source/project drift invalidates it without rewriting plans.
export async function verifyAutopilotDesign(plan: CurrentAutopilotPlan, project: EditProject,
  compile = compileCurrentDesign) {
  const evidence = plan.designEvidence;
  if (!evidence) throw new Error("Current Skill designEvidence is required; call get_autopilot_design_brief before authoring the plan");
  if (!plan.editorial.motionTreatment) throw new Error("All ten motionTreatment families must explicitly use or omit with a reason");
  if (evidence.request.format !== plan.route.format || evidence.request.domain !== plan.route.domain) throw new Error("Design request route differs from the plan");
  const beats = plan.editorial.narrative.beats;
  for (const beat of beats) {
    const designBeat = evidence.request.beats.find(row => row.id === beat.id);
    if (designBeat?.subject !== beat.primaryFocus || designBeat.energy !== beat.energy) throw new Error(`Design focus/energy differs from narrative beat ${beat.id}`);
  }
  const duration = Math.max(...beats.map(beat => beat.range.endFrame)) / project.fps;
  if (Math.abs(evidence.request.duration - duration) > 1 / project.fps + 1e-6) throw new Error("Design duration differs from the narrative timeline");
  assertDesignDecisionBinding(evidence, plan.commands as EditorCommand[], beats.map(beat => beat.id));
  assertMotionTreatmentBinding(plan.editorial.motionTreatment, plan.commands as EditorCommand[], beats.map(beat => beat.id));
  const brief = await compile(evidence.request);
  const identity = designIdentity(brief, project);
  for (const key of ["projectSha256", "sourceSha256", "briefSha256"] as const) {
    if (evidence[key] !== identity[key]) throw new Error(`Current design ${key} changed; read current sources and revise the plan`);
  }
  for (const row of evidence.decisions) {
    const recipe = brief.recipes.find(item => item.beatId === row.beatId)?.recipe;
    if (!recipe || row.recipeSha256 !== sha256Canonical(recipe)) throw new Error(`Design recipe mismatch for ${row.beatId}`);
    if (recipe.route.primary_family !== plan.aesthetic.primaryFamily) throw new Error(`Design family mismatch for ${row.beatId}`);
  }
  return { ...identity, beatCount: beats.length, sourceCount: brief.sources.length, state: "COMMAND_BOUND_REVIEW_REQUIRED" };
}

function page(text: string, offset: number, maxTokens: number) {
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))) throw new Error("Invalid design page offset");
  let end = offset, tokens = 0;
  // Conservative CJK/JSON estimate, plus space for the response envelope.
  for (const point of text.slice(offset)) {
    const cost = point.codePointAt(0)! > 127 ? 1 : 0.5;
    if (tokens + cost > maxTokens - 160) break;
    tokens += cost; end += point.length;
  }
  return { text: text.slice(offset, end), offset, nextOffset: end, hasMore: end < text.length, estimatedTokens: Math.ceil(tokens) };
}

export function registerAutopilotDesignTools(server: McpServer) {
  server.registerTool("get_autopilot_design_brief", {
    description: "從目前啟用的 Video Autopilot Skill 編譯段落設計配方；私人 Skill 可使用其學習記憶，公開 Kit 使用公開設計 DNA。分頁讀完 context 及每個 beat，將 identity、request、recipeSha256 與實際 commandIndexes 放入 v4 designEvidence。只讀，不認證美感。",
    inputSchema: z.object({ projectPath: z.string(), request: designRequestSchema,
      pageId: z.string().max(90).default("context"), offset: z.number().int().nonnegative().default(0),
      maxTokens: z.number().int().min(300).max(900).default(900) }),
  }, async ({ projectPath, request, pageId, offset, maxTokens }) => {
    try {
      const [project, brief] = await Promise.all([readProject(projectPath), compileCurrentDesign(request)]);
      const recipe = brief.recipes.find(row => `beat:${row.beatId}` === pageId);
      const content = pageId === "context" ? brief.context : recipe?.recipe;
      if (!content) throw new Error("Unknown design page; use context or beat:<narrative beat ID>");
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "GREEN",
        ...designIdentity(brief, project), pageId, recipeSha256: recipe ? sha256Canonical(recipe.recipe) : undefined,
        ...page(JSON.stringify(content), offset, maxTokens), quality: "REVIEW_REQUIRED" }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
}
