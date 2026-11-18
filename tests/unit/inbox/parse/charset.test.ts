import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  decodeBytes,
  decodeQuotedPrintable,
  undoTransferEncoding,
} from "@/lib/server/inbox/parse/charset";

describe("base64UrlToBytes", () => {
  it("reads base64url and tolerates the standard alphabet and padding", () => {
    expect(base64UrlToBytes("SGVsbG8-_w", 100).bytes).toEqual(Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x3e, 0xff]));
    expect(base64UrlToBytes("SGVsbG8+/w==", 100).bytes).toEqual(Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x3e, 0xff]));
  });

  it("says so when only a byte or two past maxBytes is left out", () => {
    // 1,000,001 bytes take 1,333,336 characters, exactly the cut for 1,000,000 bytes.
    const data = Buffer.alloc(1_000_001, 0x41).toString("base64url");
    expect(base64UrlToBytes(data, 1_000_000)).toMatchObject({ truncated: true, bytes: { length: 1_000_000 } });
    expect(base64UrlToBytes(Buffer.alloc(1_000_000, 0x41).toString("base64url"), 1_000_000).truncated).toBe(false);
  });

  it("decodes at most maxBytes and says so", () => {
    const data = Buffer.from("x".repeat(1000)).toString("base64url");
    const { bytes, truncated } = base64UrlToBytes(data, 100);
    expect(bytes.length).toBe(100);
    expect(truncated).toBe(true);
    expect(base64UrlToBytes(data, 1000).truncated).toBe(false);
  });
});

describe("decodeBytes", () => {
  const latin1 = Buffer.from("Grüße aus München", "latin1");
  const utf8 = Buffer.from("Grüße aus München", "utf8");

  it("uses the declared charset", () => {
    expect(decodeBytes(latin1, "ISO-8859-1")).toBe("Grüße aus München");
    expect(decodeBytes(latin1, '"windows-1252"')).toBe("Grüße aus München");
    expect(decodeBytes(Buffer.from("Привет", "utf8"), "utf-8")).toBe("Привет");
    expect(decodeBytes(Buffer.from([0xf0, 0xd2, 0xc9]), "koi8-r")).toBe("При");
  });

  it("reads UTF-8 bytes under a legacy label as UTF-8 (transcoded by Gmail, or mislabelled)", () => {
    expect(decodeBytes(utf8, "iso-8859-1")).toBe("Grüße aus München");
  });

  it("falls back to UTF-8 for an unknown label, without throwing", () => {
    expect(decodeBytes(utf8, "x-no-such-charset")).toBe("Grüße aus München");
    expect(decodeBytes(utf8, "utf-7")).toBe("Grüße aus München");
  });

  it("reads undeclared (or ASCII-declared) 8-bit bytes as windows-1252 when they are not UTF-8", () => {
    expect(decodeBytes(utf8, null)).toBe("Grüße aus München");
    expect(decodeBytes(latin1, undefined)).toBe("Grüße aus München");
    expect(decodeBytes(latin1, "us-ascii")).toBe("Grüße aus München");
  });

  it("keeps a declared UTF-8 body as UTF-8 even when a byte is broken", () => {
    expect(decodeBytes(Buffer.concat([Buffer.from("ok "), Buffer.from([0xff])]), "utf-8")).toBe("ok �");
  });

  it("reads UTF-16", () => {
    expect(decodeBytes(Buffer.from("hallo", "utf16le"), "utf-16le")).toBe("hallo");
  });
});

describe("transfer encodings Gmail may have left in place", () => {
  it("decodes quoted-printable that is still encoded", () => {
    const encoded = Buffer.from("Gr=C3=BC=C3=9Fe, this is a long line that was wrapped with a soft=\r\nline break and an =3D sign.");
    const out = undoTransferEncoding(encoded, "quoted-printable").toString("utf8");
    expect(out).toBe("Grüße, this is a long line that was wrapped with a softline break and an = sign.");
  });

  it("leaves decoded text alone: 8-bit bytes, or 7-bit text without quoted-printable traces", () => {
    const decoded = Buffer.from("Grüße, see https://x.example/?ref=AB12&id=FF", "utf8");
    expect(undoTransferEncoding(decoded, "quoted-printable")).toBe(decoded);
    const ascii = Buffer.from("See https://x.example/?ref=AB12&id=FF\nTitle\n=====\n");
    expect(undoTransferEncoding(ascii, "quoted-printable")).toBe(ascii);
  });

  it("decodes base64 that is still encoded, and only that", () => {
    const text = "Thank you for applying. We received your application.";
    const encoded = Buffer.from(Buffer.from(text).toString("base64").replace(/(.{40})/g, "$1\r\n"));
    expect(undoTransferEncoding(encoded, "base64").toString("utf8")).toBe(text);
    const plainText = Buffer.from("Thank you for applying.");
    expect(undoTransferEncoding(plainText, "base64")).toBe(plainText);
    const word = Buffer.from("Bewerbungseingang1234"); // no spaces, but not a multiple of 4
    expect(undoTransferEncoding(word, "base64")).toBe(word);
  });

  it("leaves decoded text alone when an '=' in it is no quoted-printable escape", () => {
    // Gmail decodes the transfer encoding; a URL ending in base64 padding looked like a soft line
    // break, so the next line was glued to it and "=AB"-like pieces of other URLs became bytes.
    const decoded = Buffer.from(
      "Pick a time here:\nhttps://ats.example/s?token=Qm9vaw=\nWe would like to invite you to an interview.\nhttps://ats.example/?ref=AB12&utm_source=mail\n",
    );
    expect(undoTransferEncoding(decoded, "quoted-printable")).toBe(decoded);
  });

  it("ignores other or missing encodings", () => {
    const b = Buffer.from("a=3Db");
    expect(undoTransferEncoding(b, "7bit")).toBe(b);
    expect(undoTransferEncoding(b, null)).toBe(b);
  });

  it("quoted-printable decoding is lenient", () => {
    expect(decodeQuotedPrintable("a = b =ZZ=").toString()).toBe("a = b =ZZ=");
    expect(decodeQuotedPrintable("trailing   \nnext").toString()).toBe("trailing\nnext");
  });
});
