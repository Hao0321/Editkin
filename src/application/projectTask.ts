import type { ProjectTask } from "./projectSession";

/** Never publish an old operation's status into a replacement editor session. */
export function acceptProjectTask(task: ProjectTask, onStatus: (message: string) => void, action: string): boolean {
  if (task.isCurrent()) return true;
  if (task.isSessionCurrent()) onStatus(`${action}期間專案已有新修改，未套用舊結果；請以目前版本重新執行。`);
  return false;
}
