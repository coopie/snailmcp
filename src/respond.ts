import type { Email } from "postal-mime";
import { callFiles, runCallFile, type File } from "./calls.js";
import { tokenMatches } from "./checks.js";
import { exampleFiles, helpText } from "./help.js";

export interface Answer {
  body: string;
  files: File[];
}

/**
 * Works out the reply to an email from an allowed sender.
 * The address and sender checks have already passed when this runs.
 */
export async function respond(email: Email, token: string, address: string): Promise<Answer> {
  const files = callFiles(email);
  const askedForHelp = /^((re|fwd?):\s*)*help\s*$/i.test(email.subject?.trim() ?? "");

  if (askedForHelp && files.length === 0) {
    return { body: helpText(address), files: exampleFiles() };
  }

  if (!tokenMatches(email, token)) {
    return {
      body: [
        "Your email reached snailMCP, but no calls ran because token.txt was missing or did not match.",
        "",
        "Attach a file called token.txt that holds your token and nothing else, then send the email again.",
      ].join("\n"),
      files: [],
    };
  }

  if (files.length === 0) {
    return {
      body: `Your email had no JSON call files, so nothing ran. Here is the guide.\n\n${helpText(address)}`,
      files: exampleFiles(),
    };
  }

  const results = [];
  for (const file of files) results.push(await runCallFile(file, address));

  const lines = results.flatMap((r) => r.summary);
  const body = [
    `snailMCP ran ${lines.length} ${lines.length === 1 ? "call" : "calls"}. The full results are in the attached .result.json files.`,
    "",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
  return { body, files: results.map((r) => r.file) };
}
