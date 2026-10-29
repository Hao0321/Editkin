// Canonical adapter glue shared by the synchronous catalog and V2 loader (editable style templates).
import { styleTemplateModuleAdapterV1 } from "../styleTemplateModulesV1";
import type { ModuleRuntimeAdapterV2 } from "../moduleTypes";
export const moduleRuntimeAdapterV2: ModuleRuntimeAdapterV2 = styleTemplateModuleAdapterV1;
