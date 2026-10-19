# snailMCP

Call tools by email.

snailMCP is a small Cloudflare Worker that receives email. It gives an AI agent that can only send email, such as Instinct, a way to call tools. The agent attaches JSON files to an email and gets the results back as files in a reply.

It costs nothing to run on Cloudflare's free plan. You only pay for a domain.

## How it works

1. Your agent sends an email to your secret snailMCP address. The email has one JSON file for each tool call, and a `token.txt` file.
2. The Worker checks the email, then runs each call in filename order.
3. The Worker replies in the same thread. The body sums up each result, and each call file gets a `.result.json` file.

Each call file holds a JSON-RPC 2.0 request, the same format MCP uses:

```json
{"jsonrpc": "2.0", "id": "1", "method": "tools/call", "params": {"name": "echo", "arguments": {"text": "hello"}}}
```

An email with the subject `help` and no files gets back a full guide and two example call files. Your agent can learn everything from that one reply.

## What you need

- a Cloudflare account, which is free
- a domain on Cloudflare
- Node.js 20 or later on your computer
- an agent that can send email with attachments

## Set it up

This takes about 15 minutes.

### 1. Make a Cloudflare account

Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).

### 2. Get a domain on Cloudflare

You can do one of these:

- **Buy a new domain.** In the Cloudflare dashboard, go to Domain Registration, then Register Domains. Cloudflare charges what the registry charges, so a cheap domain costs a few dollars a year.
- **Use a domain you already have.** Add it to Cloudflare and change its nameservers to the ones Cloudflare gives you.
- **Use a subdomain,** such as `mail.example.com`, of a domain already on Cloudflare.

Email Routing takes over email for the domain it runs on. If your domain already receives email somewhere else, use a subdomain.

### 3. Turn on Email Routing

In the dashboard, go to your domain, then Email, then Email Routing. Select Get started and let Cloudflare add the DNS records it needs.

For a subdomain, go to Email Routing settings and select Add subdomain.

Cloudflare's [Email Routing guide](https://developers.cloudflare.com/email-routing/get-started/) has more detail.

### 4. Get the code

Select "Use this template" on GitHub, or clone the repository. Then install the packages:

```bash
npm install
```

### 5. Run the setup script

```bash
npm run setup
```

The script:

1. logs you in to Cloudflare, if you are not logged in already
2. asks for your domain and the email addresses allowed to call tools
3. makes your secret address and token
4. makes a Cloudflare KV namespace that remembers which emails have run
5. deploys the Worker and saves your settings as Worker secrets

It saves your token and a ready-made agent prompt in the `local/` folder. Git ignores that folder.

### 6. Send your domain's email to the Worker

In the dashboard, go to Email Routing, then Routing rules. Edit the catch-all address, set the action to "Send to a Worker", and pick `snailmcp`.

Every address on your domain now reaches the Worker. The Worker rejects every address except your secret one.

### 7. Tell your agent

Paste `local/agent-prompt.md` into your agent. It holds your address, your token and how to make calls.

### 8. Test it

Ask your agent to email your address with the subject `help`. To watch what the Worker does, run:

```bash
npx wrangler tail
```

Then ask your agent to send back the two example files with its `token.txt`.

## Security

The Worker runs a call only when all of these checks pass:

1. **The address.** The email goes to your secret address, such as `snail-7f3kq9x2ab@example.com`. Mail to any other address is rejected as unknown.
2. **The sender.** The From address is on your allowed list, and the email passed DMARC for that address's domain. DMARC is the check that the domain really sent the email. Mail that fails is rejected as unknown, so a stranger cannot tell that the address exists.
3. **The token.** The email has a `token.txt` attachment that matches your token. If it does not match, the sender gets a reply saying so and no calls run.

These limits also apply:

- Replies only go back to the sender. Someone who forges your agent's address could start a call but would never see its result. Take more care with tools that change things than with tools that only read.
- Each email runs at most once. The Worker remembers each email's Message-ID for 7 days.
- One email can hold up to 50 call files.
- Tool results can contain text that other people wrote. The agent prompt tells your agent to treat results as information and not to follow instructions in them.

To get a new address and token, run `npm run setup -- --rotate`, then give your agent the new `local/agent-prompt.md`. The old address stops working straight away.

## Before you rely on it

These things work in local tests, but only real email can confirm them:

- **The DMARC check.** The Worker reads the DMARC result from the topmost `Authentication-Results` header, which the receiving mail server adds. If `wrangler tail` shows every email rejected with "no Authentication-Results header", Cloudflare records the result somewhere else, and `src/checks.ts` needs to change.
- **Where replies go.** Cloudflare sends replies to the envelope sender. Some mail services send from a separate bounce address. If your agent never sees replies, check `wrangler tail` for the address the reply went to.
- **Your agent's sending rules.** Instinct asks you to approve emails it sends from your Gmail. If your agent can send from its own address, add that address to the allowed list so calls do not wait for you.

## Add your own tools

Tools live in `src/tools.ts`. Each tool follows the MCP tool format: a name, a description your agent reads, a JSON Schema for its arguments, and a `run` function. For example:

```ts
const addNote: Tool = {
  name: "add_note",
  description: "Saves a note.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run(args) {
    // Save the note somewhere, such as a KV namespace or another service's API.
    return { content: [{ type: "text", text: "Saved." }] };
  },
};

export const tools: Tool[] = [echo, now, addNote];
```

Then deploy:

```bash
npm run deploy
```

To use an API key in a tool, save it as a Worker secret with `npx wrangler secret put NAME`, and add it to the `Env` type in `src/checks.ts`.

## Try it on your computer

You can run the Worker locally without a domain:

```bash
npm run setup -- --local
npm run dev
```

In a second terminal, send it test emails:

```bash
npm run try
```

`npm run try -- help` sends a help email, `npm run try -- no-token` leaves out the token, and `npm run try -- stranger` sends from an address that is not allowed. Wrangler prints where it saved each reply as an `.eml` file.

Run the tests with `npm test`.

## Files

| File | What it does |
| --- | --- |
| `src/index.ts` | Receives each email, runs the checks and sends the reply |
| `src/checks.ts` | The address, sender, DMARC and token checks |
| `src/calls.ts` | Reads call files and runs JSON-RPC requests |
| `src/tools.ts` | The tools. Add yours here |
| `src/help.ts` | The guide sent in reply to `help` |
| `src/respond.ts` | Decides what to reply |
| `src/reply.ts` | Builds the reply email |
| `docs/agent-prompt.md` | The prompt template the setup script fills in |
| `scripts/setup.mjs` | Sets up and deploys snailMCP |
| `scripts/send-test.mjs` | Sends test emails to the local Worker |

## What comes next

The next version will connect to remote MCP servers, so any MCP server's tools can be called by email.
