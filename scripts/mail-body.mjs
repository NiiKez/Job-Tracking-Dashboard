#!/usr/bin/env node
// Helper for fixtures/mail (see its README): Gmail sends part bodies as base64url.
//
//   node scripts/mail-body.mjs encode [--charset utf-8|iso-8859-1] [file]
//       The text of `file` (or stdin) as a part body: line endings made CRLF, a final line
//       break added, encoded in the charset, then base64url. Prints {"size", "data"} for the
//       part's "body".
//   node scripts/mail-body.mjs decode <fixture.json>
//       Every text part of a fixture (and its _attachments), decoded, to check an edit.
//
// No dependencies; plain Node.
import { readFileSync } from "node:fs";

function usage() {
  console.error("usage: mail-body.mjs encode [--charset utf-8|iso-8859-1] [file]\n       mail-body.mjs decode <fixture.json>");
  process.exit(2);
}

function encode(args) {
  let charset = "utf-8";
  const i = args.indexOf("--charset");
  if (i >= 0) {
    charset = (args[i + 1] ?? "").toLowerCase();
    args.splice(i, 2);
  }
  const text = readFileSync(args[0] ?? 0, "utf8").replace(/\r?\n/g, "\r\n").replace(/(\r\n)?$/, "\r\n");
  let bytes;
  if (charset === "utf-8" || charset === "utf8") {
    bytes = Buffer.from(text, "utf8");
  } else if (charset === "iso-8859-1" || charset === "latin1") {
    const bad = [...text].find((ch) => ch.codePointAt(0) > 0xff);
    if (bad) {
      console.error(`"${bad}" cannot be written in ISO-8859-1`);
      process.exit(1);
    }
    bytes = Buffer.from(text, "latin1");
  } else {
    console.error("charset must be utf-8 or iso-8859-1");
    process.exit(2);
  }
  console.log(JSON.stringify({ size: bytes.length, data: bytes.toString("base64url") }, null, 2));
}

function decode(args) {
  if (!args[0]) usage();
  const message = JSON.parse(readFileSync(args[0], "utf8"));
  const attachments = message._attachments ?? {};
  const header = (part, name) =>
    part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType?.startsWith("text/")) {
      const charset = /charset="?([^";\s]+)/i.exec(header(part, "Content-Type"))?.[1] ?? "utf-8";
      const data = part.body?.data ?? attachments[part.body?.attachmentId];
      let text = "(no data)";
      if (data) {
        try {
          text = new TextDecoder(charset).decode(Buffer.from(data, "base64url"));
        } catch {
          text = Buffer.from(data, "base64url").toString("utf8");
        }
      }
      const where = part.body?.data ? "inline" : `attachment ${part.body?.attachmentId}`;
      console.log(`--- part "${part.partId}" ${part.mimeType} (${charset}, ${where})${part.filename ? ` file ${part.filename}` : ""}`);
      console.log(text);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "encode") encode(rest);
else if (command === "decode") decode(rest);
else usage();
