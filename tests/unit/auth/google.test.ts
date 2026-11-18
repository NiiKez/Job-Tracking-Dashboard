import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { googleClient, loginPath, signInAuthorizationUrl } from "@/lib/server/auth/google";
import { APP_ORIGIN, CLIENT_ID, restoreEnv, setEnv, signedInEnv } from "./env";

describe("signInAuthorizationUrl", () => {
  afterEach(restoreEnv);

  it("asks Google for openid email profile with the account chooser, state and PKCE S256", () => {
    signedInEnv();
    const url = signInAuthorizationUrl("state-123", "verifier-456");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(`${APP_ORIGIN}/auth/google/callback`);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("prompt")).toBe("select_account");
    expect(q.get("state")).toBe("state-123");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update("verifier-456").digest("base64url"));
    // Never offline access: no refresh token for sign-in.
    expect(q.get("access_type")).not.toBe("offline");
    expect(url.href).not.toContain("offline");
    expect(url.href).not.toContain("test-secret-not-real");
  });
});

describe("googleClient", () => {
  afterEach(restoreEnv);

  it("throws while sign-in is locked", () => {
    setEnv({ APP_URL: APP_ORIGIN });
    expect(() => googleClient("/auth/google/callback")).toThrow(/not configured/);
  });

  it("builds the redirect URI from APP_URL and the given path (area 2 reuses it)", () => {
    signedInEnv({ APP_URL: "http://localhost:3800" });
    const url = googleClient("/api/inbox/callback").createAuthorizationURL("s", "v", ["openid"]);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3800/api/inbox/callback");
  });

  it("refuses a redirect path that is not on this site", () => {
    signedInEnv();
    expect(() => googleClient("https://evil.example/cb")).toThrow();
    expect(() => googleClient("//evil.example/cb")).toThrow();
  });

  it("refuses a backslash or a control character, which URL parsing would turn into another host", () => {
    signedInEnv();
    // new URL() reads "\" as "/" and drops tab and newline: each of these would resolve to evil.example.
    for (const path of ["/\\evil.example/cb", "/\t/evil.example/cb", "/\n/evil.example/cb", "/api/x\\y"]) {
      expect(() => googleClient(path)).toThrow("googleClient: redirectPath must be a path on this site");
    }
  });
});

describe("loginPath", () => {
  it("adds the error and a safe next", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath("failed")).toBe("/login?error=failed");
    expect(loginPath("not_allowed", "/jobs?q=a b")).toBe("/login?error=not_allowed&next=%2Fjobs%3Fq%3Da+b");
    expect(loginPath(undefined, "/review")).toBe("/login?next=%2Freview");
  });

  it("drops an unsafe next", () => {
    expect(loginPath("failed", "//evil.example")).toBe("/login?error=failed");
    expect(loginPath("failed", "/login")).toBe("/login?error=failed");
  });
});
