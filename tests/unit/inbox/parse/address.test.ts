import { describe, expect, it } from "vitest";
import { cleanAddress, parseMailbox, parseMailboxList } from "@/lib/server/inbox/parse/address";

describe("parseMailbox", () => {
  it.each([
    ["Jane Doe <jane@example.com>", "Jane Doe", "jane@example.com"],
    ['"Doe, Jane" <Jane.Doe@Example.COM>', "Doe, Jane", "jane.doe@example.com"],
    ['"Bob \\"the builder\\"" <bob@example.com>', 'Bob "the builder"', "bob@example.com"],
    ["=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <j.mueller@example.org>", "Jürgen Müller", "j.mueller@example.org"],
    ['"=?UTF-8?B?SsO8cmdlbg==?=" <j@example.com>', "Jürgen", "j@example.com"],
    ["jane@example.com", "", "jane@example.com"],
    ["<jane@example.com>", "", "jane@example.com"],
    ["jane@example.com (Jane Doe)", "Jane Doe", "jane@example.com"],
    ["Jane (Recruiting) <jane@example.com>", "Jane", "jane@example.com"],
    ["<jane(work)@example.com>", "", "jane@example.com"],
    ["Jane Doe jane@example.com", "Jane Doe", "jane@example.com"],
    ["Jane <jane@example.com>, Bob <bob@example.com>", "Jane", "jane@example.com"],
    ["Doe, Jane <jane@example.com>", "Doe, Jane", "jane@example.com"],
    ["Team: jane@example.com, bob@example.com;", "", "jane@example.com"],
    ["<@relay.example:jane@example.com>", "", "jane@example.com"],
    ["Jane <jane@exam\r\n ple.com>", "Jane", "jane@example.com"],
    ["  Jane\r\n Doe <jane@example.com>  ", "Jane Doe", "jane@example.com"],
    ["'Jane Doe' <jane@example.com>", "Jane Doe", "jane@example.com"],
    ["Jürgen <jürgen@müller.example>", "Jürgen", "jürgen@müller.example"],
    ['"unterminated <jane@example.com>', "unterminated", "jane@example.com"],
  ])("%s", (raw, name, address) => {
    expect(parseMailbox(raw)).toEqual({ name, address });
  });

  it("takes the first usable address when the first entry has none", () => {
    expect(parseMailbox("undisclosed-recipients:;, Bob <bob@example.com>")).toEqual({ name: "Bob", address: "bob@example.com" });
  });

  it("parses a header that was encoded as a whole", () => {
    const whole = `=?UTF-8?B?${Buffer.from("Jane Doe <jane@example.com>").toString("base64")}?=`;
    expect(parseMailbox(whole)).toEqual({ name: "Jane Doe", address: "jane@example.com" });
  });

  it.each([
    ["", "", ""],
    ["undisclosed-recipients:;", "", ""],
    ["Jane Doe", "Jane Doe", ""],
    ["Jane <not an address>", "Jane", ""],
    ["<jane@localhost>", "", ""],
    ["<jane@@example.com>", "", ""],
    ["<.jane@example.com>", "", ""],
    ["<jane@-example.com>", "", ""],
    ["<<<>>>", "", ""],
    ["-- <>", "", ""],
    ["\u0000\u0001", "", ""],
  ])("garbage %j gives an empty address", (raw, name, address) => {
    expect(parseMailbox(raw)).toEqual({ name, address });
  });

  it("handles a null header and absurd lengths quickly", () => {
    expect(parseMailbox(null)).toEqual({ name: "", address: "" });
    const started = Date.now();
    const long = parseMailbox(`${"(".repeat(50_000)}${'"'.repeat(50_000)}${"<".repeat(50_000)}`);
    expect(long.address).toBe("");
    expect(parseMailbox(`${"a".repeat(400)}@example.com`).address).toBe("");
    expect(parseMailbox(`Name ${"x".repeat(5000)} <a@example.com>`).name.length).toBeLessThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("parseMailboxList", () => {
  it("lists every mailbox", () => {
    expect(parseMailboxList('a@example.com, "B" <b@example.com>; c@example.com')).toEqual([
      { name: "", address: "a@example.com" },
      { name: "B", address: "b@example.com" },
      { name: "", address: "c@example.com" },
    ]);
  });
});

describe("cleanAddress", () => {
  it("lower-cases and validates", () => {
    expect(cleanAddress(" Jane@Example.COM ")).toBe("jane@example.com");
    expect(cleanAddress("mailto:jane@example.com")).toBe("jane@example.com");
    expect(cleanAddress("jane@example")).toBe("");
    expect(cleanAddress("jane@exa mple.com")).toBe("");
    expect(cleanAddress("ja ne@ex,ample.com")).toBe("");
  });
});
