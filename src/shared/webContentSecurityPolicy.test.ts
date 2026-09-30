import { describe, expect, it } from "vitest";
import { WEB_CONTENT_SECURITY_POLICY } from "./webContentSecurityPolicy";

function directives(): Map<string, string[]> {
  return new Map(WEB_CONTENT_SECURITY_POLICY.split("; ").map((part) => {
    const [name, ...sources] = part.split(" ");
    return [name, sources];
  }));
}

describe("web Content-Security-Policy", () => {
  it("allows scripts only from the app origin, with no inline or eval escape hatch", () => {
    expect(directives().get("script-src")).toEqual(["'self'"]);
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval|wasm-unsafe-eval/);
  });

  it("makes no cross-origin requests and embeds no plugins or frames", () => {
    const policy = directives();
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("frame-src")).toEqual(["'none'"]);
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
  });

  it("keeps blob: for user-imported media", () => {
    const policy = directives();
    expect(policy.get("media-src")).toContain("blob:");
    expect(policy.get("img-src")).toContain("blob:");
  });

  it("omits directives that browsers ignore in a meta tag", () => {
    const names = [...directives().keys()];
    expect(names).not.toContain("frame-ancestors");
    expect(names).not.toContain("report-uri");
    expect(names).not.toContain("sandbox");
  });
});
