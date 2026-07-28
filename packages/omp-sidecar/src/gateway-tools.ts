// FILE: gateway-tools.ts
// Purpose: Project the Synara agent-gateway MCP catalog into OMP's native
//          custom-tool API so `synara_*` calls are first-class engine tools.
// Layer: Sidecar engine (OMP)
// Exports: buildOmpAgentGatewayCustomTools
//
// OMP's `createAgentSession({ mcpManager })` is deliberately NOT the injection
// point: a caller-supplied manager only propagates to the tool session for
// subagents to inherit — the engine registers MCP tools in its own registry
// exclusively on its discovery path (sdk.ts). Handing the gateway over as
// `customTools` keeps the engine owning user MCP discovery while Synara's own
// tools reach the model, which mirrors what PiAdapter does through pi's
// native tool API.

import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export const SYNARA_MCP_SERVER_NAME = "synara";

export interface AgentGatewayMcpConnection {
  /** Loopback streamable-HTTP MCP endpoint, e.g. `http://127.0.0.1:3773/mcp`. */
  readonly url: string;
  /** Bearer token bound to the calling thread. */
  readonly bearerToken: string;
}

export type AgentGatewayMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface AgentGatewayMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * MCP results are already `{ content: [...] }`; anything else is stringified so
 * the model still sees the payload instead of an empty tool result.
 */
function toolResult(result: unknown) {
  const content =
    isRecord(result) && Array.isArray(result.content)
      ? result.content.flatMap((item): Array<TextContent | ImageContent> => {
          if (!isRecord(item)) return [];
          if (item.type === "text" && typeof item.text === "string") {
            return [{ type: "text", text: item.text } satisfies TextContent];
          }
          if (
            item.type === "image" &&
            typeof item.data === "string" &&
            typeof item.mimeType === "string"
          ) {
            return [
              { type: "image", data: item.data, mimeType: item.mimeType } satisfies ImageContent,
            ];
          }
          return [];
        })
      : [];
  return {
    content:
      content.length > 0
        ? content
        : [{ type: "text", text: JSON.stringify(result ?? null) } satisfies TextContent],
    details: result,
  };
}

async function postAgentGatewayJsonRpc(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<unknown> {
  const id = globalThis.crypto.randomUUID();
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(input.connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.connection.bearerToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new Error(`Synara MCP request failed with HTTP ${String(response.status)}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new Error("Synara MCP returned an invalid JSON-RPC response.");
  }
  if ("error" in payload) {
    const failure = payload as unknown as JsonRpcFailure;
    throw new Error(failure.error?.message || "Synara MCP request failed.");
  }
  const success = payload as unknown as JsonRpcSuccess;
  if (success.id !== id || !("result" in success)) {
    throw new Error("Synara MCP returned a mismatched JSON-RPC response.");
  }
  return success.result;
}

/** Load the canonical gateway tool descriptors for native-tool providers. */
export async function listAgentGatewayMcpTools(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<AgentGatewayMcpToolDescriptor>> {
  const result = await postAgentGatewayJsonRpc({
    ...input,
    method: "tools/list",
  });
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("Synara MCP tools/list returned an invalid tool catalog.");
  }
  return result.tools.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.description !== "string" ||
      !isRecord(value.inputSchema)
    ) {
      throw new Error("Synara MCP tools/list returned an invalid tool descriptor.");
    }
    return {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
  });
}

/** Invoke the canonical gateway dispatcher through its authenticated MCP route. */
export function callAgentGatewayMcpTool(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  return postAgentGatewayJsonRpc({
    connection: input.connection,
    method: "tools/call",
    params: { name: input.name, arguments: input.arguments },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * Load the gateway catalog and adapt each entry. Schemas and execution stay
 * owned by the gateway; this only crosses the provider boundary.
 */
export async function buildOmpAgentGatewayCustomTools(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<ReadonlyArray<ToolDefinition>> {
  const tools = await listAgentGatewayMcpTools({
    connection: input.connection,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  if (tools.length === 0) {
    throw new Error("Synara MCP returned an empty tool catalog.");
  }
  return tools.map(
    (tool) =>
      ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as ToolDefinition["parameters"],
        // Discoverable tools are mounted behind `xd://` devices; the harness
        // policy tells the model to call `synara_*` by name, so they must stay
        // top-level.
        loadMode: "essential",
        // The gateway's schemas have genuinely optional properties. Strict
        // structured output cannot express that: it forces every property to be
        // present, and OpenAI-family models then over-fill optionals with empty
        // strings, which the gateway rejects ("Argument X must be a non-empty
        // string"). An omitted flag is NOT the same as an explicit `false` on
        // the wire — pi-ai only sends `strict: false` when the tool asks for it.
        strict: false,
        mcpServerName: SYNARA_MCP_SERVER_NAME,
        mcpToolName: tool.name,
        execute: async (_toolCallId, params, signal) =>
          toolResult(
            await callAgentGatewayMcpTool({
              connection: input.connection,
              name: tool.name,
              arguments: (isRecord(params) ? params : {}) as Record<string, unknown>,
              ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
              ...(signal === undefined ? {} : { signal }),
            }),
          ),
      }) satisfies ToolDefinition,
  );
}
