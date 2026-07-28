// FILE: ompGatewayTools.test.ts
// Purpose: Pins the OMP projection of the Synara gateway catalog — top-level
//          tool names, non-strict schemas, and dispatch back through MCP.
// Layer: Server provider (OMP) tests

import { describe, expect, it } from "vitest";

import type { AgentGatewayMcpConnection } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { buildOmpAgentGatewayCustomTools } from "./ompGatewayTools.ts";

const connection: AgentGatewayMcpConnection = {
  url: "http://127.0.0.1:3773/mcp",
  bearerToken: "sagw_test",
};

const catalog = {
  tools: [
    {
      name: "synara_list_threads",
      description: "List Synara threads.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" }, model: { type: "string" } },
        required: [],
      },
    },
  ],
};

/** Records requests and replies with the MCP envelopes the gateway would send. */
function makeFetch(callResult: unknown) {
  const requests: Array<{ id: string; method: string; params?: unknown }> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params?: unknown };
    requests.push(body);
    const result = body.method === "tools/list" ? catalog : callResult;
    // The client rejects a reply whose id does not match its request.
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

describe("buildOmpAgentGatewayCustomTools", () => {
  it("keeps gateway tools top-level and non-strict so optional arguments stay optional", async () => {
    const { fetch } = makeFetch({});

    const tools = await buildOmpAgentGatewayCustomTools({ connection, fetch });

    const tool = tools[0];
    expect(tool?.name).toBe("synara_list_threads");
    // Discoverable tools hide behind `xd://` devices, but the harness policy
    // tells the model to call `synara_*` by name.
    expect(tool?.loadMode).toBe("essential");
    // Strict structured output would force every optional property to be
    // present; models then send "" and the gateway rejects the call.
    expect(tool?.strict).toBe(false);
    expect(tool?.mcpServerName).toBe("synara");
  });

  it("dispatches a call through the gateway and surfaces its content", async () => {
    const { fetch, requests } = makeFetch({
      content: [{ type: "text", text: "two threads" }],
    });

    const tools = await buildOmpAgentGatewayCustomTools({ connection, fetch });
    const result = await tools[0]?.execute(
      "call-1",
      { limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );

    expect(requests[1]).toEqual({
      jsonrpc: "2.0",
      id: requests[1]?.id,
      method: "tools/call",
      params: { name: "synara_list_threads", arguments: { limit: 2 } },
    });
    expect(result?.content).toEqual([{ type: "text", text: "two threads" }]);
  });

  it("refuses an empty catalog instead of reporting a working gateway", async () => {
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const { id } = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await expect(buildOmpAgentGatewayCustomTools({ connection, fetch })).rejects.toThrow(
      "empty tool catalog",
    );
  });
});
