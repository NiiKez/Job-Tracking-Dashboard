import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { checkLink, isBlockedAddress, setNetworkInterfacesForTests } from "@/lib/server/parse/address";

describe("isBlockedAddress", () => {
  it.each([
    // IPv4
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1", // carrier-grade NAT
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1", // documentation
    "192.88.99.1", // old 6to4 relays
    "192.168.1.1",
    "198.18.0.1", // benchmarking
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1", // multicast
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::7f00:1", // old IPv4-compatible form
    "::ffff:127.0.0.1", // mapped
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:8.8.8.8", // mapped is refused as a whole, public or not
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "64:ff9b::7f00:1",
    "64:ff9b::808:808", // NAT64 is refused as a whole
    "64:ff9b:1::1",
    "100::1", // discard
    "2001::1", // Teredo
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1", // documentation
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "2002:808:808::1",
    "3fff::1", // documentation
    "fc00::1", // unique local
    "fd12:3456:789a::1",
    "FD00::1",
    "fe80::1", // link-local
    "fe80::1%eth0",
    "febf::1",
    "fec0::1", // old site-local
    "ff02::1", // multicast
    "ff0e::1",
    // not an address at all
    "",
    "localhost",
    "example.com",
    "127.1",
    "0x7f.0.0.1",
    "[::1]",
  ])("blocks %j", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "93.184.215.14",
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1", // just past 10/8
    "100.128.0.1", // just past 100.64/10
    "172.15.255.255", // just before 172.16/12
    "172.32.0.1", // just past 172.16/12
    "192.0.1.1",
    "192.169.0.1",
    "198.20.0.1",
    "223.255.255.255", // just before multicast
    "2606:4700::1111",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "2003::1", // just past 2002::/16
    "2001:200::1", // just past 2001::/23
  ])("allows %j", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("isBlockedAddress: this host's own addresses", () => {
  // A public address on one of the server's interfaces is reached over lo, past both firewalls,
  // and reaches whatever listens on all interfaces (a web server on :80 and its sites).
  const PUBLIC_V4 = "93.184.215.14";
  const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

  function iface(address: string, family: "IPv4" | "IPv6"): os.NetworkInterfaceInfo {
    const base = { netmask: "", mac: "00:00:00:00:00:00", internal: false, cidr: null };
    return family === "IPv4"
      ? { ...base, address, family, netmask: "255.255.255.255" }
      : { ...base, address, family, netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", scopeid: 0 };
  }

  afterEach(() => setNetworkInterfacesForTests(undefined));

  it("blocks the public addresses on this host's interfaces", () => {
    expect(isBlockedAddress(PUBLIC_V4)).toBe(false);
    expect(isBlockedAddress(PUBLIC_V6)).toBe(false);

    setNetworkInterfacesForTests(() => ({
      lo: [iface("127.0.0.1", "IPv4"), iface("::1", "IPv6")],
      eth0: [iface(PUBLIC_V4, "IPv4"), iface(PUBLIC_V6, "IPv6"), iface("fe80::1%eth0", "IPv6")],
    }));
    expect(isBlockedAddress(PUBLIC_V4)).toBe(true);
    expect(isBlockedAddress(PUBLIC_V6)).toBe(true);
    // The same address written another way.
    expect(isBlockedAddress("2606:2800:021f:cb07:6820:80da:af6b:8b2c")).toBe(true);
    // Its neighbours are not this host.
    expect(isBlockedAddress("93.184.215.15")).toBe(false);
    expect(isBlockedAddress("2606:2800:21f:cb07:6820:80da:af6b:8b2d")).toBe(false);
  });

  it("blocks everything when the interfaces cannot be read", () => {
    setNetworkInterfacesForTests(() => {
      throw new Error("uv_interface_addresses failed");
    });
    expect(isBlockedAddress(PUBLIC_V4)).toBe(true);
    expect(isBlockedAddress(PUBLIC_V6)).toBe(true);
  });

  it("blocks every address of the machine running the tests", () => {
    const own = Object.values(os.networkInterfaces())
      .flat()
      .map((entry) => entry!.address);
    expect(own.length).toBeGreaterThan(0);
    for (const address of own) expect(isBlockedAddress(address)).toBe(true);
  });
});

describe("checkLink", () => {
  it.each([
    ["https://jobs.example.com/backend-engineer", "https://jobs.example.com/backend-engineer"],
    ["http://jobs.example.com/a", "http://jobs.example.com/a"],
    ["HTTPS://JOBS.EXAMPLE.COM/a", "https://jobs.example.com/a"],
    ["https://jobs.example.com:443/a", "https://jobs.example.com/a"],
    ["http://jobs.example.com:80/a", "http://jobs.example.com/a"],
    ["http://jobs.example.com:443/a", "http://jobs.example.com:443/a"],
    ["https://jobs.example.com:80/a", "https://jobs.example.com:80/a"],
    ["https://jobs.example.com./a", "https://jobs.example.com./a"],
    ["http://93.184.215.14/", "http://93.184.215.14/"],
    ["http://[2606:4700::1111]/", "http://[2606:4700::1111]/"],
  ])("allows %s", (link, href) => {
    const check = checkLink(link);
    expect(check.ok && check.url.href).toBe(href);
  });

  it.each([
    ["ftp://jobs.example.com/a", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["gopher://jobs.example.com:70/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,hello", "scheme"],
    ["ws://jobs.example.com/", "scheme"],
    ["https://user:secret@jobs.example.com/", "credentials"],
    ["https://user@jobs.example.com/", "credentials"],
    ["https://:secret@jobs.example.com/", "credentials"],
    ["http://jobs.example.com:8080/", "port"],
    ["https://jobs.example.com:8443/", "port"],
    ["http://jobs.example.com:22/", "port"],
    ["http://jobs.example.com:0/", "port"],
    ["not a link", "invalid-link"],
    ["http://", "invalid-link"],
    ["http://[fe80::1%25eth0]/", "invalid-link"], // the URL parser rejects zone IDs
    // IP literals, including the odd forms the URL parser rewrites to dotted IPv4
    ["http://127.0.0.1/", "blocked-address"],
    ["http://2130706433/", "blocked-address"], // 127.0.0.1 as one number
    ["http://0x7f.1/", "blocked-address"],
    ["http://0x7f000001/", "blocked-address"],
    ["http://017700000001/", "blocked-address"], // octal
    ["http://127.1/", "blocked-address"],
    ["http://0/", "blocked-address"], // 0.0.0.0
    ["http://0x7f.0x0.0x0.0x1/", "blocked-address"],
    ["http://0177.0.0.1/", "blocked-address"], // octal parts
    ["http://127.000.000.001/", "blocked-address"],
    ["http://%31%32%37.0.0.1/", "blocked-address"], // percent-encoded host
    ["http://１２７.０.０.１/", "blocked-address"], // full-width digits
    ["http://127.0.0.1./", "blocked-address"],
    ["http://127.0.0.1../", "blocked-address"], // stays a name to the URL parser
    ["http://10.0.0.1/", "blocked-address"],
    ["http://169.254.169.254/latest/meta-data/", "blocked-address"],
    ["http://2852039166/", "blocked-address"], // 169.254.169.254 as one number
    ["http://0xa9fea9fe/", "blocked-address"],
    ["http://4294967295/", "blocked-address"], // 255.255.255.255
    ["http://100.64.0.1/", "blocked-address"],
    ["https://[::1]/", "blocked-address"],
    ["https://[0:0:0:0:0:0:0:1]/", "blocked-address"],
    ["https://[::ffff:127.0.0.1]/", "blocked-address"],
    ["https://[::ffff:7f00:1]/", "blocked-address"],
    ["https://[0:0:0:0:0:ffff:127.0.0.1]/", "blocked-address"],
    ["https://[::ffff:a9fe:a9fe]/", "blocked-address"], // mapped 169.254.169.254
    ["https://[::ffff:0:7f00:1]/", "blocked-address"], // IPv4-translated
    ["https://[::127.0.0.1]/", "blocked-address"], // old IPv4-compatible
    ["https://[::]/", "blocked-address"],
    ["https://[64:ff9b::a00:1]/", "blocked-address"],
    ["https://[64:ff9b::127.0.0.1]/", "blocked-address"],
    ["https://[64:ff9b:1::a00:1]/", "blocked-address"],
    ["https://[2002:7f00:1::1]/", "blocked-address"], // 6to4 of 127.0.0.1
    ["https://[fd00::1]/", "blocked-address"],
    ["https://[fe80::1]/", "blocked-address"],
    ["https://[ff02::1]/", "blocked-address"],
    // names that are always local
    ["http://localhost/", "blocked-address"],
    ["http://LOCALHOST./", "blocked-address"],
    ["http://localhost../", "blocked-address"],
    ["http://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/", "blocked-address"], // IDNA maps it to "localhost"
    ["http://admin.localhost/", "blocked-address"],
    ["http://intranet/", "blocked-address"],
  ])("refuses %s (%s)", (link, reason) => {
    expect(checkLink(link)).toEqual({ ok: false, reason });
  });

  it("shows how the URL parser normalizes the odd IPv4 forms", () => {
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
    expect(new URL("http://0x7f.1/").hostname).toBe("127.0.0.1");
    expect(new URL("http://127.1/").hostname).toBe("127.0.0.1");
    expect(new URL("http://017700000001/").hostname).toBe("127.0.0.1");
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    expect(new URL("http://%31%32%37.0.0.1/").hostname).toBe("127.0.0.1");
    expect(new URL("http://１２７.０.０.１/").hostname).toBe("127.0.0.1");
    // Two trailing dots are not an IPv4 address to the parser: checkLink strips them.
    expect(new URL("http://127.0.0.1../").hostname).toBe("127.0.0.1..");
  });
});
