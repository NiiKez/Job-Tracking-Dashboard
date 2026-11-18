// Builders for Gmail Message resources (format=full) in parser tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GmailHeader, GmailMessage, GmailPart } from "@/lib/server/inbox/source/types";

export const b64u = (data: string | Buffer) =>
  (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");

/** A file from tests/fixtures/gmail. */
export function sample(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "../../../fixtures/gmail", name), "utf8");
}

export interface PartOptions {
  charset?: string;
  cte?: string;
  filename?: string;
  disposition?: string;
  /** The body's bytes as Gmail sends them; default: `text` as UTF-8. */
  bytes?: Buffer;
  /** Deliver as an attachment reference instead of inline data. */
  attachmentId?: string;
  /** Overrides body.size. */
  size?: number;
  contentType?: string;
}

export function textPart(mimeType: string, text: string, o: PartOptions = {}): GmailPart {
  const bytes = o.bytes ?? Buffer.from(text, "utf8");
  const headers: GmailHeader[] = [
    { name: "Content-Type", value: o.contentType ?? `${mimeType}${o.charset === "" ? "" : `; charset="${o.charset ?? "UTF-8"}"`}` },
  ];
  if (o.cte) headers.push({ name: "Content-Transfer-Encoding", value: o.cte });
  if (o.disposition) headers.push({ name: "Content-Disposition", value: o.disposition });
  return {
    partId: "",
    mimeType,
    filename: o.filename ?? "",
    headers,
    body: o.attachmentId
      ? { size: o.size ?? bytes.length, attachmentId: o.attachmentId }
      : { size: o.size ?? bytes.length, data: b64u(bytes) },
  };
}

export const plain = (text: string, o?: PartOptions) => textPart("text/plain", text, o);
export const html = (text: string, o?: PartOptions) => textPart("text/html", text, o);

export function multipart(mimeType: string, parts: GmailPart[]): GmailPart {
  return { partId: "", mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; boundary="b"` }], body: { size: 0 }, parts };
}

/** A message whose payload is `root`, with `headers` added to the top part. */
export function message(
  root: GmailPart | undefined,
  headers: Record<string, string> = {},
  extra: Partial<GmailMessage> = {},
): GmailMessage {
  const top = Object.entries(headers).map(([name, value]) => ({ name, value }));
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX"],
    snippet: "",
    internalDate: "1794480000000",
    ...extra,
    payload: root ? { ...root, headers: [...top, ...(root.headers ?? [])] } : undefined,
  };
}
