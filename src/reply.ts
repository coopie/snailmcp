import { createMimeMessage } from "mimetext";
import type { Email } from "postal-mime";
import type { Answer } from "./respond.js";

/**
 * Builds the raw reply email. The In-Reply-To and References headers keep the
 * reply in the same thread as the email it answers.
 */
export function buildReply(email: Email, answer: Answer, from: string, to: string): string {
  const message = createMimeMessage();
  message.setSender({ name: "snailMCP", addr: from });
  message.setRecipient(to);
  message.setSubject(replySubject(email.subject));

  if (email.messageId) {
    message.setHeader("In-Reply-To", email.messageId);
    message.setHeader("References", [email.references, email.messageId].filter(Boolean).join(" "));
  }

  message.addMessage({ contentType: "text/plain", data: answer.body });
  for (const file of answer.files) {
    message.addAttachment({ filename: file.filename, contentType: "application/json", data: toBase64(file.text) });
  }
  return message.asRaw();
}

function replySubject(subject: string | undefined): string {
  const original = subject?.trim() || "snailMCP";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
