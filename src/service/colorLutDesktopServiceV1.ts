import { desktopColorLutLibraryV1 } from "../application/colorLutDesktopLibraryV1";
export function dispatchColorLutDesktopV1(payload: unknown, runtime: { personalColorLutRoot?: string }) {
  return desktopColorLutLibraryV1(runtime.personalColorLutRoot, payload);
}
