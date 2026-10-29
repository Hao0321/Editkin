import type { EditorCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { createMotionTemplateTextPreparer, type MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";
import { prepareMotionGraphicCreation, type MotionGraphicCreationInput } from "./motionGraphicCreation";
import type { ProjectSession, ProjectTask } from "./projectSession";

export interface MotionGraphicCreationOwnerOptions {
  session: ProjectSession;
  onCommand(command: EditorCommand, message: string): boolean;
  onStatus(message: string): void;
  createTextPreparer?(options: { signal: AbortSignal }): MotionTemplateTextPreparer;
}

interface CreationOperation {
  generation: number;
  attachment: object;
  task: ProjectTask;
  project: EditProject;
  projectContent: string;
  input: MotionGraphicCreationInput;
  controller: AbortController;
  preparer?: MotionTemplateTextPreparer;
  released: boolean;
  preparerDisposed: boolean;
}

/** Owns preparation, never later editor content. Reattaching the same owner
 * permits StrictMode's effect replay without reviving its cancelled operation. */
export function createMotionGraphicCreationOwner(options: MotionGraphicCreationOwnerOptions) {
  let generation = 0;
  let attachment: object | undefined;
  let unsubscribe: (() => void) | undefined;
  let active: CreationOperation | undefined;

  const release = (operation: CreationOperation) => {
    if (!operation.released) {
      operation.released = true;
      operation.controller.abort();
    }
    // A synchronous preparer factory may itself trigger cancellation. Dispose
    // that returned preparer too, without disposing a replacement operation.
    if (operation.preparer && !operation.preparerDisposed) {
      operation.preparerDisposed = true;
      operation.preparer.dispose();
    }
  };
  const owns = (operation: CreationOperation) => active === operation
    && attachment === operation.attachment && generation === operation.generation;
  const current = (operation: CreationOperation) => owns(operation)
    && !operation.controller.signal.aborted && operation.task.isCurrent()
    && options.session.getSnapshot().history.present.revision === operation.input.expectedRevision
    && canonicalJson(options.session.getSnapshot().history.present) === operation.projectContent;
  const cancelActive = (message?: string) => {
    const operation = active;
    if (!operation) return;
    active = undefined;
    release(operation);
    if (message && attachment === operation.attachment && operation.task.isSessionCurrent()) options.onStatus(message);
  };

  return {
    attach(): () => void {
      unsubscribe?.();
      unsubscribe = undefined;
      cancelActive();
      generation += 1;
      const token = {};
      attachment = token;
      unsubscribe = options.session.subscribe(() => {
        const operation = active;
        if (operation && !current(operation)) {
          cancelActive("圖卡準備期間專案版本或內容已改變，沒有套用舊結果；請以目前畫面重新建立。");
        }
      });
      return () => {
        if (attachment !== token) return;
        attachment = undefined;
        generation += 1;
        unsubscribe?.();
        unsubscribe = undefined;
        cancelActive();
      };
    },
    async start(input: MotionGraphicCreationInput): Promise<boolean> {
      cancelActive();
      const token = attachment;
      const startedGeneration = ++generation;
      if (!token) return false;
      let operation: CreationOperation | undefined;
      try {
        const project = options.session.getSnapshot().history.present;
        const ownedInput = structuredClone(input);
        if (ownedInput.expectedRevision !== project.revision) {
          throw new Error("專案版本已改變，請以目前畫面重新建立圖卡。");
        }
        operation = { generation: startedGeneration, attachment: token,
          task: options.session.beginTask(project), project, projectContent: canonicalJson(project), input: ownedInput,
          controller: new AbortController(), released: false, preparerDisposed: false };
        active = operation;
        options.onStatus("正在準備實體字形與可讀的影格範圍；按 Esc 可取消。");
        if (!current(operation)) return false;
        operation.preparer = (options.createTextPreparer ?? createMotionTemplateTextPreparer)({ signal: operation.controller.signal });
        if (!current(operation)) return false;
        const prepared = await prepareMotionGraphicCreation(operation.project, operation.input, {
          prepareText: operation.preparer.prepareText.bind(operation.preparer), signal: operation.controller.signal,
        });
        if (!current(operation)) {
          if (owns(operation)) cancelActive("圖卡準備期間專案版本或內容已改變，沒有套用舊結果；請重新建立。");
          return false;
        }
        if (prepared.commands.length !== 1 || prepared.commands[0].type !== "add_motion_graphic"
          || prepared.commands[0].graphic.id !== operation.input.graphicId) {
          throw new Error("圖卡準備未回傳單一且相符的建立命令，沒有套用。");
        }
        // No await between the last ownership/content check and submission.
        // The synchronous command publishes a new session content owner, so
        // detach this completed operation before that legitimate publication.
        active = undefined;
        const accepted = options.onCommand(prepared.commands[0], "已加入新版動態圖卡，實體字形已準備，可一次復原。");
        if (!accepted && attachment === token && generation === startedGeneration && operation.task.isSessionCurrent()) {
          options.onStatus("圖卡沒有套用；目前專案已變更或命令被拒絕，請重新建立。");
        }
        return accepted;
      } catch (error) {
        if ((!operation || owns(operation)) && attachment === token && generation === startedGeneration
          && (!operation || operation.task.isSessionCurrent())) {
          if (active === operation) active = undefined;
          options.onStatus(`無法建立圖卡：${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      } finally {
        if (operation) {
          if (active === operation) active = undefined;
          release(operation);
        }
      }
    },
    cancel(): void {
      generation += 1;
      cancelActive("已取消圖卡建立，沒有套用準備中的結果。");
    },
  };
}
