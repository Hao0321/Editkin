/** Migration pins the complete historic recipe: camera for ungraded inputs, display inverse for gradeV2.
 * A single asset can occur in both sorts of clip, so rewriting its interpretation would change the image. */
export function pinLegacyAcesPhonePolicyV1(project: Record<string, unknown>): void {
  const owners = [project, ...(Array.isArray(project.compositions) ? project.compositions : [])];
  for (const owner of owners) {
    if (!owner || typeof owner !== "object") continue;
    const management = (owner as Record<string, unknown>).colorManagement;
    if (management && typeof management === "object" && !Array.isArray(management)) {
      const value = management as Record<string, unknown>;
      // Quick Rec.709 never used the ACES recipe; adding it changes saved material evidence.
      if (value.mode === "aces2" && value.rec709DisplayPolicy === undefined) value.rec709DisplayPolicy = "legacy-grade-v2";
    }
  }
}
