import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { chooseFetchSafePortV1 } from "./fetchSafePortV1";

function closedProbe(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Assigned TCP port unavailable"));
      });
    });
  });
}

describe("Fetch-compatible test fixture ports", () => {
  it("uses the first compatible closed-probe port without extra allocations", async () => {
    const probe = vi.fn(async () => 12345);
    expect(await chooseFetchSafePortV1(probe)).toBe(12345);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("discards blocked assignments before a fixture server can use them", async () => {
    const probe = vi.fn<() => Promise<number>>().mockResolvedValueOnce(10080)
      .mockResolvedValueOnce(6000).mockResolvedValueOnce(12345);
    expect(await chooseFetchSafePortV1(probe)).toBe(12345);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("terminates an exhausted blocked-port allocation budget", async () => {
    const probe = vi.fn(async () => 6000);
    await expect(chooseFetchSafePortV1(probe)).rejects.toThrow("after 8 closed probes");
    expect(probe).toHaveBeenCalledTimes(8);
  });

  it("propagates probe failures without concealing them or allocating again", async () => {
    const failure = new Error("owned listener close failed");
    const probe = vi.fn(async () => { throw failure; });
    await expect(chooseFetchSafePortV1(probe)).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed assigned ports instead of retrying them", async () => {
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity]) {
      const probe = vi.fn(async () => port);
      await expect(chooseFetchSafePortV1(probe)).rejects.toThrow("Invalid assigned TCP port");
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects invalid budgets before opening a probe", async () => {
    const probe = vi.fn(async () => 12345);
    for (const limit of [0, 17, 1.5, NaN, Infinity]) {
      await expect(chooseFetchSafePortV1(probe, limit)).rejects.toThrow("selection budget");
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("reproduces pinned fetch blocking, then reaches an owned real HTTP listener through a compatible port", async () => {
    await expect(fetch("http://127.0.0.1:10080/", { signal: AbortSignal.timeout(2000) }))
      .rejects.toMatchObject({ cause: { message: "bad port" } });
    const rejectedAssignments = [10080, 6000];
    const port = await chooseFetchSafePortV1(async () => rejectedAssignments.shift() ?? await closedProbe());
    let requests = 0;
    const server = createHttpServer((_request, response) => {
      requests++;
      response.writeHead(201, { "content-type": "text/plain" });
      response.end("owned compatible fixture");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("owned compatible fixture");
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
