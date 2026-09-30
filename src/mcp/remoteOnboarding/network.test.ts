import { describe, expect, it } from "vitest";
import { privateAddress, safeEvidenceUrl, validateRemoteOrigin } from "./network";

describe("remote onboarding network boundary", () => {
  it.each([
    "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1",
    "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:zz", "not-an-address", "1.2.3",
  ])("treats %s as non-public", (address) => {
    expect(privateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"])(
    "treats %s as public",
    (address) => { expect(privateAddress(address)).toBe(false); },
  );

  it("accepts only a bare public HTTPS origin and normalizes it", () => {
    expect(validateRemoteOrigin("https://Example.com:8443")).toBe("https://example.com:8443");
    for (const bad of [
      "http://example.com", "https://user:pw@example.com", "https://example.com/path", "https://example.com/?q=1",
      "https://example.com/#x", " https://example.com", "https://exa mple.com", "https://example.com\\evil",
      "https://localhost", "https://printer.local", "https://192.168.0.5", "https://[::1]", "https://169.254.169.254",
      "https://metadata.google.internal", `https://${"a".repeat(2_048)}.example`,
    ]) expect(() => validateRemoteOrigin(bad), bad).toThrow();
  });

  it("limits evidence URLs to credential-free public HTTPS pages without secret hints", () => {
    expect(safeEvidenceUrl("https://example.com/pricing")).toBe(true);
    for (const bad of [
      "http://example.com/pricing", "https://user@example.com/pricing", "https://example.com/pricing?plan=1",
      "https://example.com/pricing#top", "https://example.com/api-key/abc", "https://example.com/%74oken/abc",
      "https://localhost/pricing", "https://203.0.113.9/pricing", "https://[2001:db8::1]/pricing", "https://10.0.0.1/pricing",
      "not a url",
    ]) expect(safeEvidenceUrl(bad), bad).toBe(false);
  });
});
