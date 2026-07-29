import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { webBackend } from "../../src/capture/web.js";
import { closeBrowser } from "../../src/capture/web-shared.js";

const LIVE = process.env.ADE_PROOF_LIVE === "1";

describe.runIf(LIVE)("web capture (ADE_PROOF_LIVE=1)", () => {
  let server: Server;
  let baseUrl: string;
  const outDir = `/tmp/ade-proof-web-test-${Date.now()}`;

  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://127.0.0.1`);
      if (url.pathname === "/hello") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>hello</h1>");
      } else if (url.pathname === "/missing") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
    server.on("error", reject);
    await promise;
  });

  afterAll(async () => {
    await closeBrowser();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  });

  test("happy path: captures a page and reports 200", async () => {
    const outFile = `${outDir}/hello.png`;
    const res = await webBackend.capture({
      target: "web",
      label: "hello",
      url: `${baseUrl}/hello`,
      outFile,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(outFile)).toBe(true);
    expect(res.value.httpStatus).toBe(200);
    expect(res.value.finalUrl).toBe(`${baseUrl}/hello`);
    expect(res.value.consoleLines).toEqual([]);
    unlinkSync(outFile);
  });

  test("404 is still captured and reported", async () => {
    const outFile = `${outDir}/missing.png`;
    const res = await webBackend.capture({
      target: "web",
      label: "missing",
      url: `${baseUrl}/missing`,
      outFile,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(outFile)).toBe(true);
    expect(res.value.httpStatus).toBe(404);
    unlinkSync(outFile);
  });

  test("selector not found is a typed error", async () => {
    const outFile = `${outDir}/selector.png`;
    const res = await webBackend.capture({
      target: "web",
      label: "selector",
      url: `${baseUrl}/hello`,
      selector: "#nonexistent",
      outFile,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("selector-not-found");
  });
});
