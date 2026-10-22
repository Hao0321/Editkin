import * as z from "zod/v4";
import { longformUiFocusHoldRequestV1Schema } from "./longformUiFocusHoldV1";
export const longformUiFocusHoldFileRequestV1Schema = z.strictObject({
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  candidateId: longformUiFocusHoldRequestV1Schema.shape.candidateId,
  duration: longformUiFocusHoldRequestV1Schema.shape.duration,
});
export type LongformUiFocusHoldFileRequestV1 = z.infer<typeof longformUiFocusHoldFileRequestV1Schema>;
