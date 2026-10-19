/**
 * snailMCP: call tools over email.
 *
 * Cloudflare runs `email()` for every email sent to your domain. The Worker:
 * 1. rejects mail to any address except the secret one
 * 2. rejects mail from senders not on the allowed list, or that fail DMARC
 * 3. skips emails it has seen before
 * 4. checks the token.txt attachment, runs the call files and replies in the thread
 */
import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";
import { addressMatches, checkSender, type Env } from "./checks.js";
import { buildReply } from "./reply.js";
import { respond } from "./respond.js";

/** How long to remember an email's Message-ID: 7 days. */
const SEEN_SECONDS = 7 * 24 * 60 * 60;

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Every rejection gives the same reason, so a stranger cannot tell that the address exists.
    if (!addressMatches(message.to, env.SNAIL_ADDRESS)) {
      message.setReject("Unknown address");
      return;
    }

    const email = await PostalMime.parse(message.raw, { attachmentEncoding: "utf8" });

    const verdict = checkSender(email, env.ALLOWED_SENDERS);
    if (!verdict.ok) {
      console.log(`Rejected email from ${verdict.sender || "unknown sender"}: ${verdict.reason}`);
      message.setReject("Unknown address");
      return;
    }

    // Record the email before running it. If the Worker fails part way, the
    // sender's retry is skipped, so a call can never run twice.
    if (email.messageId) {
      if (await env.SEEN.get(email.messageId)) {
        console.log(`Skipped an email seen before: ${email.messageId}`);
        return;
      }
      await env.SEEN.put(email.messageId, new Date().toISOString(), { expirationTtl: SEEN_SECONDS });
    }

    const answer = await respond(email, env.SNAIL_TOKEN, message.to);
    const raw = buildReply(email, answer, message.to, message.from);
    await message.reply(new EmailMessage(message.to, message.from, raw));
    console.log(`Replied to ${verdict.sender} with ${answer.files.length} files`);
  },
};
