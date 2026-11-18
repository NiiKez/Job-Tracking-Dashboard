import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  hashSessionToken,
  newSessionToken,
  readSessionToken,
  serializeCookie,
  sessionCookie,
  sessionCookieName,
} from "@/lib/server/auth/session";
import { restoreEnv, signedInEnv } from "./env";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Set-Cookie attributes as a lower-cased map ("secure" → ""). */
function attributes(setCookie: string): Map<string, string> {
  const [, ...attrs] = setCookie.split("; ");
  return new Map(
    attrs.map((a) => {
      const [k, ...v] = a.split("=");
      return [k.toLowerCase(), v.join("=")];
    }),
  );
}

describe("session cookie", () => {
  afterEach(restoreEnv);

  it("over https: __Host-jt_session, Secure, HttpOnly, SameSite=Lax, Path=/, 30 days", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    expect(sessionCookieName()).toBe("__Host-jt_session");
    const { token } = newSessionToken();
    const cookie = sessionCookie(token);
    expect(cookie.startsWith(`__Host-jt_session=${token}; `)).toBe(true);
    const attrs = attributes(cookie);
    expect(attrs.get("path")).toBe("/");
    expect(attrs.get("max-age")).toBe(String(THIRTY_DAYS));
    expect(attrs.has("secure")).toBe(true);
    expect(attrs.has("httponly")).toBe(true);
    expect(attrs.get("samesite")).toBe("Lax");
    // __Host- forbids Domain.
    expect(attrs.has("domain")).toBe(false);
  });

  it("over http (development): jt_session without Secure", () => {
    signedInEnv({ APP_URL: "http://localhost:3800" });
    expect(sessionCookieName()).toBe("jt_session");
    const cookie = sessionCookie(newSessionToken().token);
    expect(cookie.startsWith("jt_session=")).toBe(true);
    const attrs = attributes(cookie);
    expect(attrs.has("secure")).toBe(false);
    expect(attrs.has("httponly")).toBe(true);
    expect(attrs.get("samesite")).toBe("Lax");
    expect(attrs.get("path")).toBe("/");
  });

  it("clears with the same name, path and flags and Max-Age=0", () => {
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    const cleared = clearedSessionCookie();
    expect(cleared.startsWith("__Host-jt_session=; ")).toBe(true);
    const attrs = attributes(cleared);
    expect(attrs.get("max-age")).toBe("0");
    expect(attrs.get("path")).toBe("/");
    expect(attrs.has("secure")).toBe(true);
    expect(attrs.has("httponly")).toBe(true);
  });

  it("reads only the name that matches APP_URL", () => {
    const req = (cookie: string) => new NextRequest("https://jobs.example.com/api/me", { headers: { cookie } });
    signedInEnv({ APP_URL: "https://jobs.example.com" });
    expect(readSessionToken(req("__Host-jt_session=abc"))).toBe("abc");
    // Over https a plain jt_session could have been planted over http: ignored.
    expect(readSessionToken(req("jt_session=abc"))).toBeNull();
    expect(readSessionToken(req("other=1"))).toBeNull();
    expect(readSessionToken(req("__Host-jt_session="))).toBeNull();

    signedInEnv({ APP_URL: "http://localhost:3800" });
    expect(readSessionToken(req("jt_session=abc"))).toBe("abc");
    expect(readSessionToken(req("__Host-jt_session=abc"))).toBeNull();
  });
});

describe("session tokens", () => {
  it("are 32 random bytes in base64url; the hash is SHA-256 of the raw bytes", () => {
    const { token, tokenHash } = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = Buffer.from(token, "base64url");
    expect(raw).toHaveLength(32);
    expect(tokenHash).toEqual(createHash("sha256").update(raw).digest());
    expect(tokenHash).toHaveLength(32);
    expect(hashSessionToken(token)).toEqual(tokenHash);
    expect(newSessionToken().token).not.toBe(token);
  });

  it("refuses malformed tokens", () => {
    const { token } = newSessionToken();
    for (const bad of [
      "",
      "abc",
      `${token}A`,
      token.slice(1),
      `${token.slice(0, 42)}+`,
      `${token}=`,
      `${token.slice(0, 42)}.`,
    ]) {
      expect(hashSessionToken(bad)).toBeNull();
    }
  });

  it("refuses a non-canonical encoding of the same bytes", () => {
    // The 43rd character carries 2 unused bits; only the canonical spelling is accepted.
    const token = Buffer.alloc(32, 0).toString("base64url");
    expect(token.endsWith("A")).toBe(true);
    expect(hashSessionToken(token)).not.toBeNull();
    expect(hashSessionToken(`${token.slice(0, 42)}B`)).toBeNull();
  });
});

describe("serializeCookie", () => {
  const attrs = { path: "/", maxAge: 60, secure: true, httpOnly: true, sameSite: "Lax" as const };

  it("refuses values and names that would need escaping", () => {
    expect(() => serializeCookie("a b", "x", attrs)).toThrow();
    expect(() => serializeCookie("a", "x; Domain=evil.example", attrs)).toThrow();
    expect(() => serializeCookie("a", "x", { ...attrs, path: "/x; Domain=evil" })).toThrow();
  });
});
