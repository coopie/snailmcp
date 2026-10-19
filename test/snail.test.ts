import { createMimeMessage } from "mimetext";
import PostalMime, { type Email } from "postal-mime";
import { describe, expect, it } from "vitest";
import { callFiles, runCallFile } from "../src/calls.js";
import { addressMatches, checkSender, tokenMatches } from "../src/checks.js";
import { buildReply } from "../src/reply.js";
import { respond } from "../src/respond.js";

const ADDRESS = "snail-abc123xyz9";
const FULL_ADDRESS = `${ADDRESS}@example.com`;
const TOKEN = "secret-token";
const AGENT = "agent@agentmail.test";

interface TestEmail {
  from?: string;
  subject?: string;
  authResults?: string[];
  files?: Record<string, string>;
}

/** Builds a real raw email and parses it, so the tests see what the Worker sees. */
async function makeEmail({ from = AGENT, subject = "calls", authResults, files = {} }: TestEmail): Promise<Email> {
  const message = createMimeMessage();
  message.setSender(from);
  message.setRecipient(FULL_ADDRESS);
  message.setSubject(subject);
  message.setHeader("Message-ID", "<abc@agentmail.test>");
  const results = authResults ?? [`mx.cloudflare.net; dmarc=pass (p=REJECT) header.from=${from.split("@")[1]}`];
  results.forEach((value, i) => message.setHeader(i === 0 ? "Authentication-Results" : `Authentication-Results-${i}`, value));
  message.addMessage({ contentType: "text/plain", data: "hello" });
  for (const [filename, text] of Object.entries(files)) {
    message.addAttachment({ filename, contentType: "application/octet-stream", data: Buffer.from(text).toString("base64") });
  }
  let raw = message.asRaw();
  // mimetext will not repeat a header, so rename the extra ones to make a real repeat.
  raw = raw.replace(/^Authentication-Results-\d+:/gm, "Authentication-Results:");
  return PostalMime.parse(raw, { attachmentEncoding: "utf8" });
}

const call = (id: string, name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("checks", () => {
  it("matches only the secret address", () => {
    expect(addressMatches(FULL_ADDRESS, ADDRESS)).toBe(true);
    expect(addressMatches("SNAIL-ABC123XYZ9@example.com", ADDRESS)).toBe(true);
    expect(addressMatches("snail-abc123xyz8@example.com", ADDRESS)).toBe(false);
    expect(addressMatches("info@example.com", ADDRESS)).toBe(false);
  });

  it("accepts an allowed sender that passed DMARC", async () => {
    expect(checkSender(await makeEmail({}), AGENT).ok).toBe(true);
  });

  it("rejects a sender not on the list", async () => {
    const verdict = checkSender(await makeEmail({ from: "stranger@example.net" }), AGENT);
    expect(verdict).toMatchObject({ ok: false, reason: "sender not allowed" });
  });

  it("rejects an email that failed DMARC", async () => {
    const email = await makeEmail({ authResults: ["mx.cloudflare.net; dmarc=fail header.from=agentmail.test"] });
    expect(checkSender(email, AGENT)).toMatchObject({ ok: false, reason: "DMARC fail" });
  });

  it("rejects an email with no Authentication-Results header", async () => {
    const email = await makeEmail({ authResults: [] });
    expect(checkSender(email, AGENT)).toMatchObject({ ok: false, reason: "no Authentication-Results header" });
  });

  it("ignores a forged pass lower down the headers", async () => {
    const email = await makeEmail({
      authResults: [
        "mx.cloudflare.net; spf=fail; dmarc=fail header.from=agentmail.test",
        "forged; dmarc=pass header.from=agentmail.test",
      ],
    });
    expect(checkSender(email, AGENT).ok).toBe(false);
  });

  it("rejects a DMARC pass for a different domain", async () => {
    const email = await makeEmail({ authResults: ["mx.cloudflare.net; dmarc=pass header.from=other.test"] });
    expect(checkSender(email, AGENT).ok).toBe(false);
  });

  it("checks the token.txt attachment", async () => {
    expect(tokenMatches(await makeEmail({ files: { "token.txt": `${TOKEN}\n` } }), TOKEN)).toBe(true);
    expect(tokenMatches(await makeEmail({ files: { "token.txt": "wrong" } }), TOKEN)).toBe(false);
    expect(tokenMatches(await makeEmail({}), TOKEN)).toBe(false);
  });
});

describe("calls", () => {
  it("sorts call files by name, with numbers in order", async () => {
    const email = await makeEmail({ files: { "10-b.json": "{}", "2-a.json": "{}", "token.txt": TOKEN } });
    expect(callFiles(email).map((f) => f.filename)).toEqual(["2-a.json", "10-b.json"]);
  });

  it("runs a tool and names the result file after the call file", async () => {
    const result = await runCallFile({ filename: "01-echo.json", text: call("1", "echo", { text: "hi" }) }, FULL_ADDRESS);
    expect(result.file.filename).toBe("01-echo.result.json");
    expect(JSON.parse(result.file.text)).toMatchObject({ id: "1", result: { content: [{ text: "hi" }] } });
    expect(result.summary).toEqual(["01-echo.json (id 1): hi"]);
  });

  it("runs a list of requests and keeps going after an error", async () => {
    const text = `[${call("a", "missing")}, ${call("b", "echo", { text: "still ran" })}]`;
    const result = await runCallFile({ filename: "batch.json", text }, FULL_ADDRESS);
    const responses = JSON.parse(result.file.text);
    expect(responses[0].error.code).toBe(-32602);
    expect(responses[1].result.content[0].text).toBe("still ran");
  });

  it("reports a file that is not JSON", async () => {
    const result = await runCallFile({ filename: "bad.json", text: "{nope" }, FULL_ADDRESS);
    expect(JSON.parse(result.file.text).error.code).toBe(-32700);
  });

  it("lists tools in the MCP shape", async () => {
    const result = await runCallFile({ filename: "list.json", text: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }, FULL_ADDRESS);
    const tools = JSON.parse(result.file.text).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toContain("echo");
    expect(tools[0]).toHaveProperty("inputSchema");
  });
});

describe("respond", () => {
  it("sends the guide and examples for a help email, with no token needed", async () => {
    const answer = await respond(await makeEmail({ subject: "Re: help" }), TOKEN, FULL_ADDRESS);
    expect(answer.body).toContain(`Send the email to ${FULL_ADDRESS}`);
    expect(answer.files.map((f) => f.filename)).toEqual(["01-list-tools.json", "02-echo.json"]);
  });

  it("runs nothing without the right token", async () => {
    const answer = await respond(await makeEmail({ files: { "01.json": call("1", "echo", { text: "x" }) } }), TOKEN, FULL_ADDRESS);
    expect(answer.body).toContain("no calls ran");
    expect(answer.files).toEqual([]);
  });

  it("runs the calls and sums them up", async () => {
    const files = { "01.json": call("1", "echo", { text: "one" }), "02.json": call("2", "now"), "token.txt": TOKEN };
    const answer = await respond(await makeEmail({ files }), TOKEN, FULL_ADDRESS);
    expect(answer.body).toContain("snailMCP ran 2 calls");
    expect(answer.files.map((f) => f.filename)).toEqual(["01.result.json", "02.result.json"]);
  });
});

describe("reply", () => {
  it("threads the reply and attaches result files that parse back", async () => {
    const email = await makeEmail({ subject: "my calls" });
    const raw = buildReply(email, { body: "done", files: [{ filename: "01.result.json", text: '{"ok":"é"}' }] }, FULL_ADDRESS, AGENT);
    const reply = await PostalMime.parse(raw, { attachmentEncoding: "utf8" });
    expect(reply.subject).toBe("Re: my calls");
    expect(reply.inReplyTo).toBe("<abc@agentmail.test>");
    expect(reply.attachments[0]).toMatchObject({ filename: "01.result.json", content: '{"ok":"é"}' });
  });
});
