/**
 * Sends a test email to the Worker running on your computer with `npm run dev`.
 *
 *   npm run try                  sends the two example calls with your token
 *   npm run try -- help          sends a "help" email with no files
 *   npm run try -- no-token      sends the example calls without token.txt
 *   npm run try -- stranger      sends from an address that is not allowed
 *
 * Wrangler prints where it saved the reply. Open that .eml file to read it.
 * Run `npm run setup -- --local` first to make the .dev.vars file this reads.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMimeMessage } from "mimetext";

const root = new URL("..", import.meta.url).pathname;
const mode = process.argv[2] ?? "calls";

const vars = Object.fromEntries(
  readFileSync(join(root, ".dev.vars"), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const { domain } = JSON.parse(readFileSync(join(root, "local", "settings.json"), "utf8"));

const to = `${vars.SNAIL_ADDRESS}@${domain}`;
const from = mode === "stranger" ? "stranger@example.net" : vars.ALLOWED_SENDERS.split(",")[0].trim();
const fromDomain = from.split("@")[1];

const message = createMimeMessage();
message.setSender(from);
message.setRecipient(to);
message.setSubject(mode === "help" ? "help" : "Some calls");
message.setHeader("Message-ID", `<${randomBytes(8).toString("hex")}@${fromDomain}>`);
// Cloudflare adds this header to real email. Local tests have to add it themselves.
message.setHeader("Authentication-Results", `mx.cloudflare.net; dmarc=pass header.from=${fromDomain}`);
message.addMessage({ contentType: "text/plain", data: "Please run these." });

const attach = (filename, text, contentType = "application/json") =>
  message.addAttachment({ filename, contentType, data: Buffer.from(text).toString("base64") });

if (mode !== "help") {
  attach("01-list-tools.json", JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }));
  attach(
    "02-echo.json",
    JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/call", params: { name: "echo", arguments: { text: "Hello from my agent" } } }),
  );
  attach(
    "03-batch.json",
    JSON.stringify([
      { jsonrpc: "2.0", id: "3a", method: "tools/call", params: { name: "now" } },
      { jsonrpc: "2.0", id: "3b", method: "tools/call", params: { name: "missing" } },
    ]),
  );
  if (mode !== "no-token") attach("token.txt", `${vars.SNAIL_TOKEN}\n`, "text/plain");
}

const url = new URL("http://localhost:8787/cdn-cgi/handler/email");
url.searchParams.set("from", from);
url.searchParams.set("to", to);

const response = await fetch(url, { method: "POST", body: message.asRaw() });
console.log(`Sent a "${mode}" email from ${from}. The Worker answered ${response.status}: ${await response.text()}`);
