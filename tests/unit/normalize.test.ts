import { describe, expect, it } from "vitest";
import { MAX_URL_KEY_BYTES, jobKeys, normalize, normalizeUrl, slug } from "@/lib/domain/normalize";

// These pin today's behaviour, quirks included (marked "quirk"): changing them changes
// duplicate detection and the stored key columns.

describe("normalize", () => {
  it.each([
    ["  Senior   Frontend\tEngineer\n", "senior frontend engineer"],
    ["Müller & Söhne", "muller & sohne"],
    ["Café Crème", "cafe creme"],
    ["ÉCOLE", "ecole"],
    ["ﬁnance", "finance"], // NFKD splits the ligature
    ["Straße", "straße"], // quirk: ß is not a combining mark, so it stays
    ["Ångström Øresund", "angstrom øresund"], // quirk: ø has no decomposition
    ["Acme™", "acmetm"], // decomposes before lowercasing, so "TM" is lowercased too
    ["Ⅻ Ｗｏｒｋｓ", "xii works"],
    ["", ""],
    // U+0000 goes: PostgreSQL text cannot hold it (a search for it failed with 22021)
    ["\u0000", ""],
    ["Engi\u0000neer", "engineer"],
    [" Data \u0000 Engineer\u0000", "data engineer"],
  ])("%j -> %j", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it("is idempotent for every code point up to plane 2", () => {
    const failures: string[] = [];
    for (let cp = 0; cp <= 0x2ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      const once = normalize(String.fromCodePoint(cp));
      if (normalize(once) !== once) failures.push(cp.toString(16));
    }
    expect(failures).toEqual([]);
  });

  it("is idempotent on mixed text", () => {
    const once = normalize("  ACME™ Ångström\u00a0Ⅻ ﬁnance  Straße ΟΔΟΣ \u0000 ℅ 🚀 ");
    expect(normalize(once)).toBe(once);
  });
});

describe("slug", () => {
  it.each([
    ["Parcelwerk GmbH", "parcelwerk"],
    ["Siemens AG", "siemens"],
    ["Acme, Inc.", "acme"],
    ["Coco Ltd", "coco"],
    ["Müller Logistik SE", "mullerlogistik"],
    ["Zürich Versicherung", "zurichversicherung"],
    ["Agile Labs", "agilelabs"], // suffixes only match whole words
    ["Silt & Stone", "siltandstone"],
    ["Bramble & Co", "brambleand"], // quirk: "&" becomes "and" before "co" is dropped
    ["Rheinland Bau GmbH & Co. KG", "rheinlandbauandkg"],
    ["Co-op Bank", "opbank"], // quirk: "co" is a whole word before the hyphen
    ["Vantage Bio B.V.", "vantagebiobv"], // "B.V." is not the word "bv"
    ["GmbH", ""],
    ["A.G.", "ag"], // quirk: not the word "ag" here, but slug("ag") is "", so slug is not idempotent on every text
    // symbols ("Other Symbol") are removed before NFKD, which would turn "™" into "tm"
    ["Acme™", "acme"],
    ["IBM®", "ibm"],
    ["Parcelwerk℠ GmbH", "parcelwerk"],
    ["© Bramble Labs", "bramblelabs"],
    ["🚀 Rocket Labs", "rocketlabs"],
    ["Firma №1", "firma1"],
    ["Kaffee ℅ Bohne", "kaffeebohne"], // NFKD would read "℅" as "c/o"
    ["Ⓐcme", "cme"], // quirk: circled letters are symbols too
    ["Acme\u0000 Labs", "acmelabs"],
  ])("%j -> %j", (input, expected) => {
    expect(slug(input)).toBe(expected);
  });

  it("gives a company and its trademarked name one key", () => {
    // classify compares slug(job.company) with the sender's domain: "IBM™" must still match ibm.com.
    expect(slug("Acme™")).toBe(slug("ACME GmbH"));
    expect(slug("IBM™")).toBe("ibm");
    expect(normalize("Acme™")).toBe("acmetm"); // normalize() keeps NFKD's reading
  });

  it("is idempotent for every code point up to plane 2", () => {
    const failures: string[] = [];
    for (let cp = 0; cp <= 0x2ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
      const once = slug(String.fromCodePoint(cp));
      if (slug(once) !== once) failures.push(cp.toString(16));
    }
    expect(failures).toEqual([]);
  });

  it("is idempotent on mixed text", () => {
    const once = slug("  ACME™ Ångström\u00a0Ⅻ ﬁnance & Söhne GmbH ℅ 🚀 Straße ");
    expect(once).toBe("acmeangstromxiifinanceandsohnestrae");
    expect(slug(once)).toBe(once);
  });
});

describe("normalizeUrl", () => {
  it.each([
    // www, host case, trailing slash and a fragment that is not a route go; path and query keep their case
    ["https://www.Example.com/Jobs/123/?utm_source=x&utm_medium=y&id=7#apply", "example.com/Jobs/123?id=7"],
    ["https://boards.example.com/acme/jobs/42?gh_src=abc&ref=linkedin&source=feed&trk=1", "boards.example.com/acme/jobs/42"],
    ["https://example.com/a?x=1&utm_campaign=z&y=2", "example.com/a?x=1&y=2"],
    ["https://example.com/job?Ref=Twitter&lang=DE", "example.com/job?lang=DE"], // names match in any case
    // tracking names, exact (utm_* is the only prefix)
    ["https://example.com/job?refId=1&trackingId=2&referrer=3&id=9", "example.com/job?id=9"],
    ["https://example.com/job?UTM_Source=a&utm_whatever=b&GH_SRC=c&TRK=d&SOURCE=e&RefID=f&TrackingID=g", "example.com/job"],
    // names that only start like a tracking name can identify the posting: kept
    ["https://example.com/job?referenceId=101", "example.com/job?referenceId=101"],
    ["https://example.com/job?sourceId=5&q=react", "example.com/job?q=react&sourceId=5"],
    ["https://example.com/job?refererCode=x&trkAnything=y&utm=z", "example.com/job?refererCode=x&trkAnything=y&utm=z"],
    // case-sensitive ids stay apart
    ["https://example.com/p/dAbCdEf", "example.com/p/dAbCdEf"],
    ["https://example.com/p/dabcdef", "example.com/p/dabcdef"],
    ["https://example.com/", "example.com"],
    ["https://example.com", "example.com"],
    ["https://example.com/job?", "example.com/job"],
    ["https://example.com/job?utm_source=x", "example.com/job"], // no "?" when nothing is left
    ["http://jobs.example.com:8080/a/b/", "jobs.example.com/a/b"], // scheme and port dropped
    // a pair that is not valid UTF-8 keeps its text: URLSearchParams would read each invalid
    // byte as U+FFFD ("%EF%BF%BD"), so "?id=%E4" and "?id=%FC" were one key
    ["https://jobs.example.de/stelle?id=%E4", "jobs.example.de/stelle?id=%E4"],
    ["https://jobs.example.de/stelle?id=%FC", "jobs.example.de/stelle?id=%FC"],
    ["https://jobs.example.de/stelle?id=%C3%BC", "jobs.example.de/stelle?id=%C3%BC"], // UTF-8 "ü"
    ["https://jobs.example.de/stelle?id=ü", "jobs.example.de/stelle?id=%C3%BC"],
    // ...tracking names and sorting use the decoded name where there is one, the text otherwise
    ["https://jobs.example.de/stelle?utm_source=%E4&b=%FC&a=1&gh_src=x", "jobs.example.de/stelle?a=1&b=%FC"],
    ["https://jobs.example.de/stelle?b=1&%E4=2&a=3", "jobs.example.de/stelle?%E4=2&a=3&b=1"],
    ["https://jobs.example.de/stelle?utm_%E4=x&id=1", "jobs.example.de/stelle?id=1"],
    ["https://example.com/job?q=a+%E4&r=a%20b", "example.com/job?q=a+%E4&r=a+b"], // the kept pair is not re-encoded
    ["https://example.com/job?q=100%&id=%zz", "example.com/job?id=%zz&q=100%"], // malformed escapes keep their text too
    ["https://example.com/job?q=100%25", "example.com/job?q=100%25"],
    ["https://example.com/job?a=1&&b=2&", "example.com/job?a=1&b=2"], // empty pairs go
    // a client-side route in the fragment ("#/", "#!/") is kept, after the query; other fragments go
    ["https://careers.example.com/#/job/1", "careers.example.com#/job/1"],
    ["https://careers.example.com/#!/job/2", "careers.example.com#!/job/2"],
    ["https://Careers.example.com/jobs/?utm_source=x&b=2&a=1#/job/AbC", "careers.example.com/jobs?a=1&b=2#/job/AbC"],
    ["https://careers.example.com/jobs#/job?id=7&utm_source=x", "careers.example.com/jobs#/job?id=7&utm_source=x"], // quirk: the route is kept as written
    ["https://example.com/job/7#top", "example.com/job/7"],
    ["https://example.com/job/7#!apply", "example.com/job/7"],
    ["https://example.com/job/7#", "example.com/job/7"],
    // not parseable as a URL: trimmed and lowercased only
    ["  Not A URL  ", "not a url"],
    ["example.com/jobs/1", "example.com/jobs/1"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("keeps different postings apart", () => {
    const keys = [
      "https://example.com/job?referenceId=101",
      "https://example.com/job?referenceId=202",
      "https://example.com/job?sourceId=1",
      "https://example.com/job?sourceId=2",
      "https://example.com/p/dAbCdEf",
      "https://example.com/p/dabcdef",
      "https://example.com/job?tag=a&tag=b",
      "https://example.com/job?tag=b&tag=a", // repeated names keep their order
      "https://jobs.example.de/stelle?id=%E4", // Latin-1 "ä"
      "https://jobs.example.de/stelle?id=%FC", // Latin-1 "ü"
      "https://jobs.example.de/stelle?id=%EF%BF%BD", // the key both of them used to get
      "https://jobs.example.de/stelle?id=%C3%A4", // UTF-8 "ä"
      "https://jobs.example.de/stelle?id=%E4&id=1",
      "https://jobs.example.de/stelle?id=1&id=%E4",
      "https://careers.example.com/",
      "https://careers.example.com/#/job/1",
      "https://careers.example.com/#/job/2",
      "https://careers.example.com/#!/job/1",
      "https://careers.example.com/#/job/A",
      "https://careers.example.com/#/job/a",
    ].map(normalizeUrl);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([
    ["encoding", ["https://example.com/job?q=a%20b", "https://example.com/job?q=a+b&utm_source=x", "https://example.com/job?q=a b"]],
    ["order", ["https://example.com/job?b=2&a=1", "https://example.com/job?a=1&utm_medium=m&b=2"]],
    ["a bare name", ["https://example.com/job?123", "https://example.com/job?123&utm_source=li", "https://example.com/job?123="]],
    ["host case and www", ["https://WWW.EXAMPLE.COM/Job/7/", "https://example.com/Job/7#top"]],
    ["a pair that is not UTF-8", ["https://jobs.example.de/stelle?id=%E4", "https://jobs.example.de/stelle/?utm_source=x&id=%E4&ref=%FC#apply"]],
    ["a route", ["https://careers.example.com/jobs?b=2&a=1#/job/1", "https://www.careers.example.com/jobs/?a=1&utm_medium=m&b=2#/job/1"]],
  ])("gives equivalent links one key (%s)", (_, links) => {
    expect(new Set(links.map(normalizeUrl)).size).toBe(1);
  });
});

describe("jobKeys", () => {
  it("derives every key column", () => {
    expect(
      jobKeys({
        url: "https://www.example.com/careers/42/?utm_source=x",
        company: "Müller & Söhne GmbH",
        title: "  Senior  Frontend Engineer ",
      }),
    ).toEqual({
      urlNorm: "example.com/careers/42",
      companySlug: "mullerandsohne",
      titleNorm: "senior frontend engineer",
      searchText: "muller & sohne gmbh senior frontend engineer",
    });
  });

  it("has no url key without a url", () => {
    expect(jobKeys({ url: null, company: "Bramble & Co", title: "Product Designer" })).toEqual({
      urlNorm: null,
      companySlug: "brambleand",
      titleNorm: "product designer",
      searchText: "bramble & co product designer",
    });
    expect(jobKeys({ url: "", company: "", title: "" })).toEqual({
      urlNorm: null,
      companySlug: "",
      titleNorm: "",
      searchText: "",
    });
  });

  it("has no url key when the link normalizes to nothing", () => {
    // jobs_url_norm_check rejects '', and '' keys would all collide in the unique index.
    expect(normalizeUrl("file:///")).toBe("");
    expect(jobKeys({ url: "file:///", company: "Acme", title: "Engineer" }).urlNorm).toBeNull();
    expect(jobKeys({ url: "   ", company: "Acme", title: "Engineer" }).urlNorm).toBeNull();
  });

  it(`has no url key when the key is over ${MAX_URL_KEY_BYTES} UTF-8 bytes`, () => {
    // jobs_user_id_url_norm_key cannot hold a longer row: the save would fail.
    const keyOf = (url: string) => jobKeys({ url, company: "Acme", title: "Engineer" }).urlNorm;
    const prefix = "https://example.com/";
    const fits = `${prefix}${"a".repeat(MAX_URL_KEY_BYTES - "example.com/".length)}`;
    expect(keyOf(fits)).toHaveLength(MAX_URL_KEY_BYTES);
    expect(keyOf(`${fits}a`)).toBeNull();
    // Bytes, not characters: 700 "ü" are 1400 bytes as text (an unparseable link keeps them)...
    expect(keyOf(`not a url ${"ü".repeat(700)}`)).not.toBeNull();
    expect(keyOf(`not a url ${"ü".repeat(1100)}`)).toBeNull();
    // ...and a parsed link percent-encodes them ("%C3%BC"), so a 360-character link can be over.
    expect(keyOf(`${prefix}${"ü".repeat(339)}`)).not.toBeNull();
    expect(keyOf(`${prefix}${"ü".repeat(340)}`)).toBeNull();
  });
});
