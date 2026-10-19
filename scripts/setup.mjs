/**
 * Sets up snailMCP on your Cloudflare account.
 *
 *   npm run setup               set up, or redeploy with the same address and token
 *   npm run setup -- --rotate   make a new address and token
 *   npm run setup -- --local    only make the local files, for `npm run dev`
 *
 * Your settings, token and agent prompt are saved in the local/ folder, which git ignores.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const root = new URL("..", import.meta.url).pathname;
const localDir = join(root, "local");
const settingsPath = join(localDir, "settings.json");
const configPath = join(root, "wrangler.jsonc");

const rotate = process.argv.includes("--rotate");
const localOnly = process.argv.includes("--local");

function wrangler(args, { quiet = false } = {}) {
  const run = spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Makes an address such as `snail-7f3kq9x2ab`, using letters and digits that are easy to read. */
function newAddress() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const chars = [...randomBytes(10)].map((byte) => alphabet[byte % alphabet.length]);
  return `snail-${chars.join("")}`;
}

async function askSettings(saved) {
  // Reading line by line works when someone types the answers and when they are piped in.
  const prompt = createInterface({ input: process.stdin });
  const lines = prompt[Symbol.asyncIterator]();
  const ask = async (question, fallback) => {
    const hint = fallback ? ` [${fallback}]` : "";
    process.stdout.write(`${question}${hint}\n> `);
    const answer = ((await lines.next()).value ?? "").trim();
    return answer || fallback || "";
  };

  const domain = await ask(
    "\nWhich domain will receive the email? It must be on your Cloudflare account, such as example.com or mail.example.com.",
    saved.domain,
  );
  const allowedSenders = await ask(
    "\nWhich email addresses may call tools? Separate them with commas. Add your agent's address and your own.",
    saved.allowedSenders,
  );
  prompt.close();

  if (!domain || !allowedSenders) fail("You need a domain and at least one allowed sender.");
  return { domain: domain.toLowerCase(), allowedSenders: allowedSenders.toLowerCase() };
}

/** Creates the KV namespace that remembers emails, and writes its id into wrangler.jsonc. */
function ensureKvNamespace() {
  const config = readFileSync(configPath, "utf8");
  if (!config.includes("SET_BY_SETUP")) return;

  console.log("\nCreating the KV namespace that remembers which emails have run...");
  const created = wrangler(["kv", "namespace", "create", "SEEN"], { quiet: true });
  let id = /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(created.output)?.[1];

  if (!id) {
    // The namespace may exist from an earlier run, so look for it.
    const listed = wrangler(["kv", "namespace", "list"], { quiet: true });
    try {
      const namespaces = JSON.parse(listed.output.slice(listed.output.indexOf("[")));
      id = namespaces.find((n) => n.title === "SEEN" || n.title.endsWith("-SEEN"))?.id;
    } catch {
      // Fall through to the error below.
    }
  }
  if (!id) fail(`Could not create the KV namespace. Wrangler said:\n${created.output}`);
  writeFileSync(configPath, config.replace("SET_BY_SETUP", id));
}

async function main() {
  mkdirSync(localDir, { recursive: true });
  const saved = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};

  if (!localOnly) {
    if (!wrangler(["whoami"], { quiet: true }).output.match(/associated with the email|You are logged in/i)) {
      console.log("You need to log in to Cloudflare first. A browser window will open.");
      if (!wrangler(["login"]).ok) fail("Logging in to Cloudflare did not work.");
    }
  }

  const { domain, allowedSenders } = await askSettings(saved);
  const address = !rotate && saved.address ? saved.address : newAddress();
  const token = !rotate && saved.token ? saved.token : randomBytes(24).toString("base64url");
  const fullAddress = `${address}@${domain}`;

  writeFileSync(settingsPath, `${JSON.stringify({ domain, allowedSenders, address, token }, null, 2)}\n`);
  writeFileSync(join(localDir, "token.txt"), `${token}\n`);
  writeFileSync(
    join(root, ".dev.vars"),
    `SNAIL_ADDRESS=${address}\nSNAIL_TOKEN=${token}\nALLOWED_SENDERS=${allowedSenders}\n`,
  );
  const template = readFileSync(join(root, "docs", "agent-prompt.md"), "utf8");
  writeFileSync(
    join(localDir, "agent-prompt.md"),
    template.replace("{{ADDRESS}}", fullAddress).replace("{{TOKEN}}", token),
  );

  if (!localOnly) {
    ensureKvNamespace();

    console.log("\nDeploying the Worker...");
    if (!wrangler(["deploy"]).ok) fail("Deploying did not work. Check the messages above.");

    console.log("\nSaving your address, token and allowed senders as Worker secrets...");
    const secretsFile = join(tmpdir(), `snailmcp-secrets-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(
      secretsFile,
      JSON.stringify({ SNAIL_ADDRESS: address, SNAIL_TOKEN: token, ALLOWED_SENDERS: allowedSenders }),
    );
    const stored = wrangler(["secret", "bulk", secretsFile]);
    rmSync(secretsFile);
    if (!stored.ok) fail("Saving the secrets did not work. Check the messages above.");
  }

  console.log(`
Done. Your snailMCP address is:

  ${fullAddress}

Your token and agent prompt are in the local/ folder.
${localOnly ? "\nRun `npm run dev`, then `npm run try` to send it a test email.\n" : `
Next steps:

1. In the Cloudflare dashboard, go to your domain, then Email > Email Routing > Routing rules.
2. Edit the catch-all address. Set the action to "Send to a Worker" and pick "snailmcp".
3. Paste local/agent-prompt.md into your agent.
4. Ask your agent to email the address with the subject "help".
`}`);
}

main().catch((error) => fail(error.message));
