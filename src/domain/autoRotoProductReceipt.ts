import * as z from "zod/v4";

export const PRODUCT_AUTO_ROTO_ENGINE = "editkin-native-color-temporal-roto/v1" as const;
export const PRODUCT_AUTO_ROTO_ROUTE_SCHEMA = "editkin.auto-roto-product-route-receipt/v2" as const;
export const PRODUCT_AUTO_ROTO_ROUTE_POLICY = "editkin.auto-roto-product-artifact-policy/2" as const;
export const PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256 = "c1b7d0969045d47ea722c35f5a3aa3db3b9ab1d63ef2308631f819d0e9088ab1" as const;
export const PRODUCT_AUTO_ROTO_MAX_DURATION_SECONDS = 120;
export const PRODUCT_AUTO_ROTO_MAX_FRAMES = 1_440;
export const PRODUCT_AUTO_ROTO_MAX_RGB_BYTES = 256 * 1024 * 1024;
export const PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES = 96 * 1024 * 1024;
export const PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
export const PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES = 512 * 1024 * 1024;

const productCandidateSchema = z.strictObject({
  engine: z.literal(PRODUCT_AUTO_ROTO_ENGINE),
  configured: z.literal(true),
  origin: z.literal("editkin-self-authored"),
  rightsClass: z.literal("editkin-owned"),
  qualityTier: z.literal("self-authored-unmeasured"),
  decision: z.literal("selected"),
  reasonCode: z.literal("compiled-into-product-artifact"),
});

export const productAutoRotoRouteReceiptBaseShape = {
  schema: z.literal(PRODUCT_AUTO_ROTO_ROUTE_SCHEMA),
  policyVersion: z.literal(PRODUCT_AUTO_ROTO_ROUTE_POLICY),
  mode: z.literal("product"),
  requestedEngine: z.literal(PRODUCT_AUTO_ROTO_ENGINE),
  selectedEngine: z.literal(PRODUCT_AUTO_ROTO_ENGINE),
  status: z.literal("selected"),
  reasonCode: z.literal("selected-self-authored-product-artifact"),
  boundary: z.strictObject({
    serviceArtifactKind: z.literal("product"),
    externalResearchRuntime: z.literal("disabled"),
    externalModelWeights: z.literal(false),
    modelInjection: z.literal("forbidden"),
  }),
  provenance: z.strictObject({
    origin: z.literal("editkin-self-authored"),
    implementation: z.literal("native-compiled"),
    modelAndAlgorithmRights: z.literal("editkin-owned"),
  }),
  execution: z.strictObject({
    regionMemoryPolicy: z.literal("fixed_baseline"),
  }),
  quality: z.strictObject({
    state: z.literal("diagnostic"),
    claim: z.literal("unmeasured"),
    humanReviewRequired: z.literal(true),
  }),
  candidates: z.tuple([productCandidateSchema]),
};

export const productAutoRotoRouteReceiptBaseSchema = z.strictObject(productAutoRotoRouteReceiptBaseShape);

/** Browser-safe shape parser. The application/service parser additionally
 * recomputes `receiptSha256` before trusting the receipt. */
export const productAutoRotoRouteReceiptShapeSchema = z.strictObject({
  ...productAutoRotoRouteReceiptBaseShape,
  receiptSha256: z.literal(PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256),
});

export type ProductAutoRotoRouteReceipt = z.infer<typeof productAutoRotoRouteReceiptShapeSchema>;
