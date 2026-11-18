// Helpers for calling Route Handlers directly. Invented values only.
import { NextRequest } from "next/server";
import { createSession } from "@/lib/server/auth/session";
import { getDb, withTx } from "@/lib/server/db/client";
import { WORKSPACE_LIFETIME_SECONDS } from "@/lib/server/demo/marker";
import { upsertUserOnSignIn, userFromRow, type SignInProfile, type User, type UserRow } from "@/lib/server/repo/users";
import { APP_ORIGIN, OWNER_EMAIL } from "../unit/auth/env";

export const OWNER: SignInProfile = {
  sub: "110000000000000000001",
  email: OWNER_EMAIL,
  name: "Olive Owner",
  picture: "https://lh3.googleusercontent.com/a/one",
};

export interface RequestOptions {
  method?: string;
  cookie?: string | null;
  origin?: string | null;
  contentType?: string | null;
  body?: string;
  headers?: Record<string, string>;
}

/** A request to the app, by default from the app's own origin (for non-GET) with a JSON body type. */
export function request(path: string, opts: RequestOptions = {}): NextRequest {
  const method = opts.method ?? "GET";
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const origin = opts.origin === undefined ? (method === "GET" ? null : APP_ORIGIN) : opts.origin;
  if (origin) headers.set("origin", origin);
  const contentType =
    opts.contentType === undefined ? (method === "GET" ? null : "application/json") : opts.contentType;
  if (contentType) headers.set("content-type", contentType);
  return new NextRequest(`${APP_ORIGIN}${path}`, { method, headers, body: opts.body });
}

/** The context Next.js passes: params as a promise. */
export const ctx = <P extends Record<string, string>>(params: P = {} as P) => ({ params: Promise.resolve(params) });

/** A user (first sign-in) with a fresh session; `cookie` is the Cookie header for https. */
export async function signedIn(profile: SignInProfile = OWNER): Promise<{ user: User; token: string; cookie: string }> {
  const { user } = await withTx((tx) => upsertUserOnSignIn(tx, profile));
  const { token } = await createSession(getDb(), user.id);
  return { user, token, cookie: `__Host-jt_session=${token}` };
}

/**
 * A public demo's user, made directly in SQL: google_sub "demo:" + a UUID and an address under
 * demo.invalid, as the demo marks its workspaces (src/lib/server/demo/marker.ts), with a session
 * of fixed lifetime (default: the workspace's). No seed, settings or rules. `cookie` is for https.
 */
export async function demoSignedIn(
  lifetimeSeconds = WORKSPACE_LIFETIME_SECONDS,
): Promise<{ user: User; token: string; cookie: string }> {
  const [row] = await getDb()<UserRow[]>`
    INSERT INTO users (google_sub, email, name)
    VALUES ('demo:' || gen_random_uuid(), 'alex.' || substr(md5(random()::text), 1, 8) || '@demo.invalid', 'Alex Demo')
    RETURNING id, email, google_sub, name, picture_url`;
  const user = userFromRow(row);
  const { token } = await createSession(getDb(), user.id, { fixedLifetimeSeconds: lifetimeSeconds });
  return { user, token, cookie: `__Host-jt_session=${token}` };
}

/** All Set-Cookie values of a response. */
export const setCookies = (res: Response) => res.headers.getSetCookie();

/** The Set-Cookie for `name`, if any. */
export const setCookieFor = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));

/** An unsigned JWT with these claims, shaped like Google's ID token. */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const part = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${part({ alg: "RS256", kid: "test", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

/** Google's ID token claims for the configured client, with overrides. */
export function googleClaims(clientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    azp: clientId,
    aud: clientId,
    sub: OWNER.sub,
    email: OWNER.email,
    email_verified: true,
    name: OWNER.name,
    picture: OWNER.picture,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}
