import type { EditProject } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import type { EditorCommand } from "../domain/commandTypes";
import type { HaoDesktopApi } from "../desktop/apiTypes";
import { AutoReframeButtonV1 } from "./AutoReframeButtonV1";
import { autoReframeLabelsV1 } from "./autoReframeLabelsV1";
import { useI18n } from "./i18n/interfacePreferences";

/** Mount the existing package and styles. No second analysis algorithm or project/history owner. */
export function AutoReframeDesktopControlV1(props: {
  project: EditProject; session: ProjectSession; clipId: string; api?: HaoDesktopApi; disabled?: boolean;
  onPause(): void; onCommand(command: EditorCommand, revision: number): { status: "applied" | "cancelled" };
  onNewProject?: React.ComponentProps<typeof AutoReframeButtonV1>["onNewProject"];
}) {
  const { t, locale } = useI18n();
  const portrait = props.project.width * 16 === props.project.height * 9;
  return <AutoReframeButtonV1 project={props.project} projectSession={props.session} clipId={props.clipId}
    outputWidth={portrait ? props.project.width : 1080} outputHeight={portrait ? props.project.height : 1920}
    subject={{ kind: "saliency" }} labels={autoReframeLabelsV1(t)} locale={locale} disabled={props.disabled}
    engineHostReady={!!props.api?.runEngineTaskV1} onPause={props.onPause} onCommand={props.onCommand} onNewProject={props.onNewProject}
    onAnalyze={props.api?.runEngineTaskV1 ? async (project, request, controls) => {
      const reply = await props.api!.runEngineTaskV1!({ schema: "editkin.engine-task/v1", kind: "auto_reframe_v1", project, input: request }, {
        signal: controls.signal, onProgress: event => controls.onProgress(event.progress),
      });
      return reply.result;
    } : undefined} />;
}
