// FILE: ompGatewayTools.ts
// Purpose: Project the Synara agent-gateway MCP catalog into OMP's native
//          custom-tool API so `synara_*` calls are first-class engine tools.
// Layer: Server provider projection (OMP)
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

import {
  callAgentGatewayMcpTool,
  listAgentGatewayMcpTools,
  SYNARA_MCP_SERVER_NAME,
  type AgentGatewayMcpFetch,
} from "../agentGateway/mcpInjection.ts";
import type { AgentGatewayMcpConnection } from "../agentGateway/Services/AgentGatewayCredentials.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
