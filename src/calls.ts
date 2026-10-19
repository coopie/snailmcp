import type { Email } from "postal-mime";
import { helpText } from "./help.js";
import { listTools, tools } from "./tools.js";

/** The most call files one email can hold. Later files are not run. */
export const MAX_CALL_FILES = 50;

export interface File {
  filename: string;
  text: string;
}

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Response =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface CallResult {
  /** The result file, named after the call file, such as `01-echo.result.json`. */
  file: File;
  /** One line per request for the reply body. */
  summary: string[];
}

/** Finds the JSON call files in an email, sorted by filename so `01-` runs before `02-`. */
export function callFiles(email: Email): File[] {
  return email.attachments
    .filter((a) => a.filename?.toLowerCase().endsWith(".json") && typeof a.content === "string")
    .map((a) => ({ filename: a.filename as string, text: a.content as string }))
    .sort((a, b) => a.filename.localeCompare(b.filename, "en", { numeric: true }))
    .slice(0, MAX_CALL_FILES);
}

/**
 * Runs every request in one call file and makes its result file.
 * A file holds one JSON-RPC request, or a list of them.
 */
export async function runCallFile(file: File, address: string): Promise<CallResult> {
  const resultName = file.filename.replace(/\.json$/i, ".result.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (error) {
    const response = errorResponse(null, -32700, `The file is not valid JSON: ${(error as Error).message}`);
    return { file: { filename: resultName, text: pretty(response) }, summary: [summarise(file.filename, response)] };
  }

  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: Response[] = [];
  for (const request of requests) responses.push(await runRequest(request, address));

  const result = Array.isArray(parsed) ? responses : responses[0];
  return {
    file: { filename: resultName, text: pretty(result) },
    summary: responses.map((response) => summarise(file.filename, response)),
  };
}

async function runRequest(request: unknown, address: string): Promise<Response> {
  if (!isRequest(request)) {
    return errorResponse(null, -32600, 'A request needs "jsonrpc": "2.0" and a "method".');
  }
  const id = request.id ?? null;

  switch (request.method) {
    case "help":
      return { jsonrpc: "2.0", id, result: { text: helpText(address) } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listTools() } };
    case "tools/call":
      return callTool(id, request.params ?? {});
    default:
      return errorResponse(id, -32601, `There is no method called "${request.method}". Try "help".`);
  }
}

async function callTool(id: Response["id"], params: Record<string, unknown>): Promise<Response> {
  const tool = tools.find((t) => t.name === params.name);
  if (!tool) {
    return errorResponse(id, -32602, `There is no tool called "${String(params.name)}". Call "tools/list" to see them.`);
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    return { jsonrpc: "2.0", id, result: await tool.run(args) };
  } catch (error) {
    // MCP reports a tool's own failure as a result with isError, so the agent can read it.
    const text = `The ${tool.name} tool failed: ${(error as Error).message}`;
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  }
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string";
}

function errorResponse(id: Response["id"], code: number, message: string): Response {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Makes a short line such as `01-echo.json (id 1): hello`. */
function summarise(filename: string, response: Response): string {
  const label = response.id === null ? filename : `${filename} (id ${response.id})`;
  if ("error" in response) return `${label}: error ${response.error.code}, ${response.error.message}`;

  const result = response.result as { content?: { text?: string }[]; isError?: boolean };
  const text = result.content?.map((c) => c.text ?? "").join(" ")
    ?? (JSON.stringify(response.result) ?? "");
  const short = text.length > 300 ? `${text.slice(0, 300)}...` : text;
  return `${label}: ${result.isError ? "tool failed, " : ""}${short || "done"}`;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
