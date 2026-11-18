import { describe, expect, it } from "vitest";
import { clampText, decodeEncodedWords, headerText, headerValue, parseHeaderParams } from "@/lib/server/inbox/parse/headers";
import type { GmailHeader } from "@/lib/server/inbox/source/types";

describe("headerValue", () => {
  const headers: GmailHeader[] = [
    { name: "subject", value: "first" },
    { name: "SUBJECT", value: "second" },
    { name: "List-Id", value: "x" },
  ];

  it("matches names in any case and takes the first", () => {
    expect(headerValue(headers, "Subject")).toBe("first");
    expect(headerValue(headers, "list-id")).toBe("x");
    expect(headerValue(headers, "From")).toBeNull();
  });

  it("tolerates a missing or malformed list", () => {
    expect(headerValue(undefined, "From")).toBeNull();
    expect(headerValue([null, { name: 5 }, { name: "From" }] as unknown as GmailHeader[], "From")).toBeNull();
  });
});

describe("decodeEncodedWords (RFC 2047)", () => {
  it.each([
    ["=?UTF-8?Q?Thank_you_for_applying_=E2=80=93_Frontend_Engineer?=", "Thank you for applying – Frontend Engineer"],
    ["=?utf-8?B?SWhyZSBCZXdlcmJ1bmcgYmVpIELDvHJv?=", "Ihre Bewerbung bei Büro"],
    ["=?ISO-8859-1?Q?Terminbest=E4tigung?=", "Terminbestätigung"],
    ["Re: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?= from Berlin", "Re: Grüße from Berlin"],
    ["=?UTF-8*de?Q?Gr=C3=BC=C3=9Fe?=", "Grüße"],
  ])("%s", (raw, decoded) => {
    expect(decodeEncodedWords(raw)).toBe(decoded);
  });

  it("drops whitespace between adjacent encoded words, and keeps it elsewhere", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Vorstellungs?= =?UTF-8?Q?gespr=C3=A4ch?=")).toBe("Vorstellungsgespräch");
    expect(decodeEncodedWords("=?UTF-8?Q?Hallo?= Welt =?UTF-8?Q?!?=")).toBe("Hallo Welt !");
  });

  it("joins a character split across two encoded words", () => {
    // "ü" is C3 BC; each word carries one byte.
    expect(decodeEncodedWords("=?UTF-8?B?R3LD?= =?UTF-8?B?vGU=?=")).toBe("Grüe");
  });

  it("leaves decoded text and malformed words alone", () => {
    expect(decodeEncodedWords("Thank you for applying – Frontend Engineer")).toBe("Thank you for applying – Frontend Engineer");
    expect(decodeEncodedWords("=?UTF-8?X?abc?= and =?broken")).toBe("=?UTF-8?X?abc?= and =?broken");
  });

  it("survives an unknown charset", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?Hallo?=")).toBe("Hallo");
  });
});

describe("headerText", () => {
  it("collapses folding and whitespace, removes controls and padding, cuts", () => {
    expect(headerText("  Interview\r\n\tinvitation\u0000 ​ ", 100)).toBe("Interview invitation");
    expect(headerText("abcdef", 3)).toBe("abc");
    expect(headerText(null, 10)).toBe("");
  });

  it("never leaves half a surrogate pair", () => {
    expect(clampText("ab😀", 3)).toBe("ab");
  });
});

describe("parseHeaderParams", () => {
  it("splits a value and its parameters", () => {
    expect(parseHeaderParams('Text/Plain; charset="iso-8859-1"; format=flowed; DelSp=yes')).toEqual({
      value: "text/plain",
      params: { charset: "iso-8859-1", format: "flowed", delsp: "yes" },
    });
  });

  it("keeps semicolons inside quotes and tolerates junk", () => {
    expect(parseHeaderParams('attachment; filename="a;b.txt"').params.filename).toBe("a;b.txt");
    expect(parseHeaderParams(";;=x; y").value).toBe("");
    expect(parseHeaderParams(undefined)).toEqual({ value: "", params: {} });
  });
});
