/**
 * The tools an agent can call. Add your own to the `tools` list at the bottom.
 *
 * Each tool follows the MCP tool format: a name, a description the agent reads,
 * a JSON Schema for its arguments, and a `run` function.
 */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

const echo: Tool = {
  name: "echo",
  description: "Sends back the text you give it. Use it to test that calls work.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The text to send back." } },
    required: ["text"],
  },
  run(args) {
    const text = String(args.text ?? "");
    return { content: [{ type: "text", text }], structuredContent: { text } };
  },
};

const now: Tool = {
  name: "now",
  description: "Gives the current date and time in UTC.",
  inputSchema: { type: "object", properties: {} },
  run() {
    const time = new Date().toISOString();
    return { content: [{ type: "text", text: time }], structuredContent: { time } };
  },
};

export const tools: Tool[] = [echo, now];

/** The tool list in the shape MCP's `tools/list` returns. */
export function listTools() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
