# Source validation: 2026-10-05 development snapshot

This source update is for collaboration. The pull request remains a draft because the full source test suite has unresolved failures. The package release version and official installer channel remain unchanged.

| Check | Actual local result |
| --- | --- |
| TypeScript | Exit 0 after aligning the public ES2024 library and Vite CSS declarations with current source; the first exit 2 is retained locally. |
| Web asset preparation | Exit 0 |
| Vite production build | Exit 0 |
| Public verifier negative controls | Exit 0; reviewed public Git-worktree controls retained |
| Complete default Vitest run | 3,414 passed, 297 failed, 252 pending; exit 1 |

The Vitest report contains 3,963 tests. It also reports a suite-load failure in `residentSceneLinearVideoSequence.nativePaint.test.ts` because its child-process mock omits an `execFile` export. Of the 297 failed assertions, 217 contain an ENOENT missing-file error and 9 timed out. These categories can overlap and are not a diagnosis of all failures. Missing generated static font faces and absent edition-specific/native fixtures account for visible prerequisite failures. Other failures include checks that original media fields remain unchanged. No test failure was hidden by adding new suite exclusions or loosening assertions/timeouts.

## Largest failing suites: start with existing code

| Suite | Failed assertions in this run |
| --- | --- |
| `referenceMotionTemplateInstances.test.ts` | 41 |
| `bundledFontSource.test.ts` | 27 |
| `motionFontDelivery.test.ts` | 20 |
| `referenceMotionTemplatePreparationV2.test.ts` | 19 |
| `compositionV2.physicalGlyphs.test.ts` | 13 |
| `originalMotionSourceRevisionFile.test.ts` | 10 |
| `nativeTemplateDirectionBinding.test.ts` | 9 |
| `referenceMotionComparisonInstancesV2.test.ts` | 9 |
| `originalMotionSourceFile.test.ts` | 9 |
| `compositionV2.resources.test.ts` | 9 |
| `referenceMotionDisplayPaint.test.ts` | 8 |
| `referenceMotionMediaRelink.test.ts` | 8 |
| `referenceMotionSourceOverlay.test.ts` | 8 |
| `useResidentGpuPreview.lifecycle.test.ts` | 8 |
| `referenceMotionCadenceInstances.test.ts` | 7 |
| `referenceMotionComparisonPlanV2.test.ts` | 7 |
| `referenceMotionPlanVerification.test.ts` | 7 |
| `nativeMotionPaint.track.test.ts` | 7 |
| `residentGpuGraphPreparation.paint.test.ts` | 6 |
| `materialIntelligenceCache.test.ts` | 4 |

Inspect the suite beside its source before proposing a fix. Use actual redistributable font/media bytes and the public edition contract; do not make unavailable owner media appear approved. The maintainer retains raw failure output privately because it contains machine-local paths. GitHub CI is authoritative for each exact pushed commit and may expose different platform results. A successful web build does not certify native/render/font/color journeys.

## Source and public boundary

The current UI is exported from current `EditorShell.tsx` with a single creator-neutral status-label transformation. A frozen older whole-file UI override is not used. Reviewed main security changes, dependency pins, CI actions/permissions and community-specific configuration are retained. The private-media mesh showcase script is excluded; its rendering implementation is present. The source manifest records exact public bytes and redistribution rights.

See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for the existing modules, active contribution branches and complete-delivery acceptance state. The 37-journey strengthening ledger remains 3/37; this publication adds no product credit. The earlier partial UI experiments remain partial and their fixed-budget failures remain blocked.
