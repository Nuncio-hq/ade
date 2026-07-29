import type { ProofError } from "../core/types.js";

export function errText(error: ProofError): string {
  let text = `ade-proof error (${error.code}): ${error.message}`;
  if (error.details) {
    text += `\nDetails: ${JSON.stringify(error.details)}`;
  }
  return text;
}

export function okText(...lines: string[]) {
  return { content: lines.map((text) => ({ type: "text" as const, text })) };
}

export function errorResult(error: ProofError) {
  return { content: [{ type: "text" as const, text: errText(error) }], isError: true as const };
}
