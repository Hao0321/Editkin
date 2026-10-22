// Canonical adapter glue shared by the synchronous catalog and V2 loader (Motion Library Phase 3).
import { transitionMotionModuleAdapterV1 } from "../motionLibraryModulesV1";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = transitionMotionModuleAdapterV1;
