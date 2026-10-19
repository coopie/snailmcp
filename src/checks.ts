import type { Email } from "postal-mime";

/** The secrets and bindings the Worker reads from Cloudflare. `npm run setup` sets them. */
export interface Env {
  /** The secret part of the address, before the @, such as `snail-7f3kq9x2ab`. */
  SNAIL_ADDRESS: string;
  /** The text a sender puts in an attached `token.txt` file. */
  SNAIL_TOKEN: string;
  /** Comma-separated email addresses that may call tools. */
  ALLOWED_SENDERS: string;
  /** Remembers each email's Message-ID, so a call never runs twice. */
  SEEN: KVNamespace;
}

export type Verdict = { ok: true; sender: string } | { ok: false; sender: string; reason: string };

/** Checks that the email was sent to the secret address. */
export function addressMatches(recipient: string, secret: string): boolean {
  const local = recipient.split("@")[0] ?? "";
  return safeEqual(local.toLowerCase(), secret.toLowerCase());
}

/**
 * Checks that the email comes from an allowed sender and that the sender's domain
 * really sent it. Run this before anything else reads the email.
 */
export function checkSender(email: Email, allowedSenders: string): Verdict {
  const sender = email.from?.address?.toLowerCase() ?? "";
  if (!sender) return { ok: false, sender, reason: "no From address" };

  const allowed = allowedSenders
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(sender)) return { ok: false, sender, reason: "sender not allowed" };

  const dmarc = dmarcResult(email, sender);
  if (dmarc !== "pass") return { ok: false, sender, reason: dmarc };
  return { ok: true, sender };
}

/**
 * Reads the DMARC result from the topmost Authentication-Results header.
 *
 * Only the topmost header is read because Cloudflare adds it when the email arrives.
 * Headers lower down came with the email, and a sender can write anything in them.
 * Returns "pass", or a short reason the check failed.
 */
export function dmarcResult(email: Email, sender: string): string {
  const header = email.headers.find((h) => h.key === "authentication-results");
  if (!header) return "no Authentication-Results header";

  const dmarc = header.value
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("dmarc="));
  if (!dmarc) return "no DMARC result";

  const result = /^dmarc=(\w+)/i.exec(dmarc)?.[1]?.toLowerCase();
  if (result !== "pass") return `DMARC ${result ?? "unknown"}`;

  const domain = /header\.from=([^\s;)]+)/i.exec(dmarc)?.[1]?.toLowerCase();
  if (domain !== sender.split("@")[1]) return `DMARC passed for ${domain ?? "no domain"}, not the sender's domain`;
  return "pass";
}

/** Checks that the email has a `token.txt` attachment holding the token. */
export function tokenMatches(email: Email, token: string): boolean {
  const file = email.attachments.find((a) => a.filename?.toLowerCase() === "token.txt");
  if (!file || typeof file.content !== "string") return false;
  return safeEqual(file.content.trim(), token);
}

/** Compares two strings in a time that does not depend on where they differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
