import * as z from "zod/v4";
export const longformUiFocusGeometryFileRequestV1Schema=z.strictObject({holdJobId:z.string().regex(/^uh-[a-f0-9]{24}$/)});
export type LongformUiFocusGeometryFileRequestV1=z.infer<typeof longformUiFocusGeometryFileRequestV1Schema>;
