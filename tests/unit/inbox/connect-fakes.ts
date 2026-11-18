// Fakes for the Gmail connect tests (unit, database and handler): Google's token, revocation and
// Gmail profile endpoints behind a stubbed global fetch, and the inbox environment. No network.
// Invented values only.
import { vi } from "vitest";
import { resetEnvForTests } from "@/lib/server/env";
import { fakeIdToken, googleClaims, OWNER } from "../../handlers/helpers";
import { CLIENT_ID } from "../auth/env";

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** 32-byte keys as INBOX_TOKEN_KEY takes them (64 hex characters). */
export const KEY_HEX = "a1".repeat(32);
export const OLD_KEY_HEX = "b2".repeat(32);

export const REFRESH_TOKEN = "1//0invented-refresh-token-Abc_123";
export const ACCESS_TOKEN = "ya29.invented-access-token";
export const GRANTED = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SCOPE}`;

/**
 * The inbox variables: INBOX_TOKEN_KEY (default KEY_HEX; "" removes it), the previous key and
 * MAIL_SOURCE (default "", i.e. gmail), whatever the ambient environment says. Undo with
 * vi.unstubAllEnvs() and resetEnvForTests() (restoreEnv() in tests/unit/auth/env.ts does both).
 */
export function inboxEnv(opts: { key?: string; previousKey?: string; mailSource?: "gmail" | "fixture" | "" } = {}): void {
  vi.stubEnv("INBOX_TOKEN_KEY", opts.key ?? KEY_HEX);
  vi.stubEnv("INBOX_TOKEN_KEY_PREVIOUS", opts.previousKey ?? "");
  vi.stubEnv("MAIL_SOURCE", opts.mailSource ?? "");
  resetEnvForTests();
}

/** Google's token answer for the connect flow, with overrides (undefined removes a field). */
export function tokenAnswer(overrides: Record<string, unknown> = {}, claims: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 3599,
    scope: GRANTED,
    id_token: fakeIdToken(googleClaims(CLIENT_ID, claims)),
    ...overrides,
  };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return Response.json(body);
}

export const profileAnswer = (emailAddress = OWNER.email.toUpperCase()) =>
  Response.json({ emailAddress, messagesTotal: 10, threadsTotal: 8, historyId: "123456" });

/** Gmail's error body with a `reason`, and text that must never be shown or logged. */
export function gmailError(status: number, reason: string): Response {
  return Response.json(
    { error: { code: status, message: "Google text for owner@example.com", errors: [{ reason }], status: "PERMISSION_DENIED" } },
    { status },
  );
}

export interface FakeGoogle {
  /** Form bodies sent to the token endpoint. */
  token: URLSearchParams[];
  /** Tokens sent to the revocation endpoint. */
  revoked: string[];
  /** Authorization headers sent to users.getProfile. */
  profile: Array<string | null>;
  /** Every URL requested, in order. */
  urls: string[];
}

/**
 * Replaces the global fetch (Arctic's token calls and the Gmail client both use it) with
 * Google's three endpoints. Each answer is a function, so a test can make one fail.
 */
export function fakeGoogle(
  answers: { token?: () => Response | Promise<Response>; revoke?: () => Response; profile?: () => Response | Promise<Response> } = {},
): FakeGoogle {
  const seen: FakeGoogle = { token: [], revoked: [], profile: [], urls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Arctic passes a Request; the Gmail client a URL string and an init.
      const req = input instanceof Request ? input : null;
      const url = (req ? req.url : String(input)).split("?")[0];
      seen.urls.push(url);
      if (url === TOKEN_ENDPOINT && req) {
        seen.token.push(new URLSearchParams(await req.text()));
        return (answers.token ?? (() => tokenAnswer()))();
      }
      if (url === REVOKE_ENDPOINT && req) {
        seen.revoked.push(new URLSearchParams(await req.text()).get("token") ?? "");
        return (answers.revoke ?? (() => new Response(null, { status: 200 })))();
      }
      if (url === PROFILE_URL) {
        seen.profile.push(new Headers(init?.headers).get("authorization"));
        return (answers.profile ?? (() => profileAnswer()))();
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  return seen;
}
