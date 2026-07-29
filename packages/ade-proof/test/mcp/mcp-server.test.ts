import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startSession } from "../../src/core/index.js";
import { createMcpServer } from "../../src/mcp.js";

const execFileAsync = promisify(execFile);

function isTextContent(c: unknown): c is { type: "text"; text: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as Record<string, unknown>).type === "text" &&
    typeof (c as Record<string, unknown>).text === "string"
  );
}

function textFromResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const r = result as { content?: unknown[] };
  if (!Array.isArray(r.content)) return "";
  return r.content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("\n");
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await writeFile(join(dir, ".gitconfig"), `[user]\n\tname = Test\n\temail = test@example.com\n`);
}

describe("ade-proof MCP server", () => {
  let client: Client;
  let transport: InMemoryTransport;

  beforeEach(async () => {
    const server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    transport = clientTransport;
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await transport.close();
  });

  it("proof_list returns sessions for a workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ade-proof-mcp-"));
    await initGitRepo(tmp);

    const started = await startSession({ workspaceRoot: tmp });
    if (!started.ok) throw new Error(started.error.message);

    const result = await client.callTool({
      name: "proof_list",
      arguments: { cwd: tmp },
    });

    expect(result.isError).toBeFalsy();
    const text = textFromResult(result);
    expect(text).toContain(started.value.id);
  });

  it("proof_start starts a session and proof_list sees it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ade-proof-mcp-2-"));
    await initGitRepo(tmp);

    const started = await client.callTool({
      name: "proof_start",
      arguments: { cwd: tmp, description: "test" },
    });

    expect(started.isError).toBeFalsy();
    const text = textFromResult(started);
    expect(text).toContain("Started proof session");

    const listed = await client.callTool({
      name: "proof_list",
      arguments: { cwd: tmp },
    });

    expect(listed.isError).toBeFalsy();
    const listText = textFromResult(listed);
    expect(listText).toMatch(/active/);
  });
});
