/**
 * ade-hello — smoke-test extension for the ADE harness.
 *
 * Verifies the full loop: discovery, custom tool registration, and the
 * Synara UI bridge (notify). Safe to delete once real extensions exist.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const adeHelloTool = defineTool({
	name: "ade_hello",
	label: "ADE Hello",
	description: "Smoke-test tool proving the ADE harness extension is loaded",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello from the ADE harness, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(adeHelloTool);
}
