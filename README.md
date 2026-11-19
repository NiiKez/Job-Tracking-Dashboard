# Job Tracker

Job Tracker keeps every job you are interested in or have applied to in one list, and shows
where each application stands: saved, applied, interview, offer, rejected or no response.

**Adding a job.** Paste a link to the job posting, or paste the job text. The app fills in the
title, company and location for you. With the Chrome extension you can also save the job you
are looking at with one click, even on sites like LinkedIn that the app can't open itself.

**Keeping it up to date.** Connect your Gmail and the app reads the replies companies send you.
When a company confirms your application, invites you to an interview, makes an offer or turns
you down, the app moves that job to the right status. Mail it isn't sure about waits for you to
decide, and mail that isn't about a job is ignored. You can always change a status yourself, on
a board you drag cards across or in a table.

**Private.** Only the Google accounts you allow can sign in. The app only reads your mail, never
sends or changes it.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Cache Components). Route Handlers are the API. |
| UI | React 19.3, TypeScript. `src/lib/types.ts` is the contract between UI and API. |
| Styling | Tailwind CSS v4 with CSS-variable tokens, light and dark |
| Components | shadcn/ui (Radix primitives) |
| Client data | TanStack Query v5 |
| Drag and drop | dnd-kit (pointer, touch and keyboard) |
| Database | PostgreSQL 18 with `postgres` (postgres.js) and plain SQL. No ORM. |
| Sign-in | Google OpenID Connect with Arctic. Sessions are rows in the database. |
| Tests | Vitest; Playwright (Chromium) for end-to-end tests |

## Setup

You need Node.js 24, PostgreSQL 18 and a Google account that can create an OAuth client.

1. Install the packages.

   ```bash
   npm install
   ```

2. Create two databases: one for development and one for the tests. The development database's
   name must end in `_dev`, for example `job_tracker_dev` and `job_tracker_test`.

3. Copy the environment file and fill it in. See [Environment variables](#environment-variables).

   ```bash
   cp .env.example .env.local
   ```

   `.env.local` is gitignored. Never commit values.

4. Create the tables in the development database.

   ```bash
   npm run migrate:dev
   ```

5. Create a Google OAuth client (Google Cloud console, "Web application"). Add these redirect
   addresses:

   - `http://localhost:3800/auth/google/callback` (sign-in)
   - `http://localhost:3800/api/inbox/callback` (the Gmail connection, used later)

   Put its client ID and secret into `.env.local`, and your Google address into `ALLOWED_EMAILS`.

6. Start the app and sign in.

   ```bash
   npm run dev
   ```

   Open `http://localhost:3800`. Use exactly this address, not `127.0.0.1`: Google redirects back to
   it, and the app refuses changes from any other origin.

   Working on a remote machine? Forward the port over SSH, so your browser still uses
   `http://localhost:3800`:

   ```bash
   ssh -L 3800:localhost:3800 <your-dev-machine>
   ```

7. Optional: fill the development database with demo data. Sign in once first, because the data
   belongs to an account.

   ```bash
   npm run db:seed                         # seeds for the first user
   npm run db:seed -- you@example.com      # or name the account
   ```

   It replaces that account's jobs and emails with the demo data; its keyword rules and settings
   stay. It takes `DATABASE_URL` from the environment, or else from `.env.local`, and refuses any
   database whose name does not end in `_dev` or `_test`.

### Locked mode

In development the app starts with only `DATABASE_URL`. If `APP_URL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` or `ALLOWED_EMAILS` is missing, it runs locked: every API route except
`/api/health` answers 401, and `/login` says sign-in is not set up. A value that is present but
malformed stops the start instead. The log names the variable, never its value.

Production (`npm start`) is strict: a missing sign-in value or `INBOX_TOKEN_KEY` stops the start,
so a deploy that lost one rolls back. To run a production server locked or without Gmail on
purpose, set `ALLOW_PARTIAL_SETUP=on`; then it behaves as above. `MAIL_SOURCE=fixture` also stops
a production start, unless `APP_URL` is an http origin on `127.0.0.1`, `localhost` or `[::1]`.

### Public demo

The same build can run a second time as a public demo, switched on with `DEMO_MODE=on`. A
visitor presses "Try the demo" and gets a private workspace of invented jobs and emails, which is
deleted after 24 hours at the latest (when the demo is full, workspaces older than an hour make
room for new ones). "Sync now" files the invented mail from `fixtures/mail`, so the inbox works
without Gmail. Google sign-in, Gmail and the timed inbox syncs are off.

A demo needs three values and nothing else:

```bash
DATABASE_URL=postgresql://app@localhost:5432/job_tracker_demo
APP_URL=https://demo.example.com
DEMO_MODE=on
```

- The database's name must end in `_demo`, `_dev` or `_test`. Give the demo a database of its
  own: every visitor writes to it.
- It refuses to start if `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`,
  `INBOX_TOKEN_KEY`, `INBOX_TOKEN_KEY_PREVIOUS`, `ALLOW_PARTIAL_SETUP` or `DEMO_URL` is set. The
  real app needs some of these to start, so it cannot start as a demo by accident.
- `MAIL_SOURCE` is `fixture` and `INBOX_SCHEDULER` is `off`; the other values are refused.
- `APP_URL` is needed in development too. In production it must be https, except an http origin
  on `127.0.0.1`, `localhost` or `[::1]` (a local test run of the production build).

In the demo, `/login` and every signed-out page lead to the entry page `/login/demo`, and every
response tells search engines not to index it. Expired workspaces are deleted every 5 minutes.
`npm run smoke -- http://127.0.0.1:<port>` checks a running demo too: it finds the demo by
`/login`, then enters a workspace, reads `/api/me` and leaves again.

On the real app, set `DEMO_URL` to the demo's origin, for example `https://demo.example.com`, and
its sign-in page shows a "Try the demo" link.

## Chrome extension

The extension lives in [`extension/`](./extension). `npm run build` builds it before the app, and
the app serves it to the signed-in user.

**Install** (Chrome 120 or newer; Edge and Brave too):

1. Settings → Chrome extension → **Download**, and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** and pick the unzipped `job-tracker-extension` folder. Pin it to the toolbar.
4. Open the tracker, click the extension's icon and **Connect**. The tracker opens a page to
   confirm on; the extension then gets a key of its own. Settings lists every connected browser,
   with when it was last used, and revokes it.

**Update:** when the popup says a new version is available, download it again, unzip it over the
same folder (replacing its files) and click the reload icon on the extension in
`chrome://extensions`. It stays connected. An unpacked extension's id comes from its folder, so
loading the new one from another folder adds a second copy that isn't connected.

**Use:** on a job page, click the icon (or press Alt+Shift+J). Correct the fields, then **Save**
(Enter) or **Applied** (Ctrl+Enter). A job that is already tracked is updated, not duplicated.

**What it reads:** only the open tab, and only after you click (`activeTab`). It sends the
page's address, title, a few meta tags, its structured job data (JSON-LD), the fields a site reader
picks out, and your text selection. It reads LinkedIn, StepStone, Indeed, XING, Glassdoor, the
Bundesagentur's Jobsuche, Personio, Greenhouse, Lever, Workday, SmartRecruiters and JOIN with
readers of their own (`extension/src/page/sites/`), and any other page through its structured
data and main text. The server never fetches the page.

**Development:**

```bash
npm run build:extension      # extension/dist/chrome/ and extension/dist/job-tracker-extension.zip
```

Load `extension/dist/chrome/` unpacked and reload it on `chrome://extensions` after each build.
Connect it to `http://localhost:3800`. When the built extension changes (anything in
`extension/`, an app file it bundles such as `src/lib/status.ts`, or a package such as React),
raise the version in [`extension/manifest.json`](./extension/manifest.json), run
`node extension/build.mjs --record-hash` and commit `extension/build-hash.json` with it; `npm test`
fails until you do. The popup compares its own version with the one the server serves and points
to Settings when there is a newer one.

## Environment variables

Names only. Values go in `.env.local` for development. [`.env.example`](./.env.example) lists the
same names. The build needs none of them. An empty value counts as missing. "Without it" is for
development; in production (`npm start`) the four sign-in values and `INBOX_TOKEN_KEY` are needed
to start unless `ALLOW_PARTIAL_SETUP=on` ([Locked mode](#locked-mode)). A demo (`DEMO_MODE=on`)
needs only `DATABASE_URL` and `APP_URL` ([Public demo](#public-demo)).

| Name | What it is for | Without it |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection (`postgres://` or `postgresql://`) | The app does not start |
| `APP_URL` | The app's public origin, no path. In development `http://localhost:3800`. Redirect addresses and cookie flags are built from it. | Locked mode |
| `GOOGLE_CLIENT_ID` | Google OAuth client, for sign-in and the Gmail connection | Locked mode |
| `GOOGLE_CLIENT_SECRET` | Secret of the same client | Locked mode |
| `ALLOWED_EMAILS` | Comma-separated list of accounts that may sign in | Locked mode |
| `INBOX_TOKEN_KEY` | 32 random bytes as 64 hex characters. Encrypts the Gmail refresh token. | Gmail is not set up |
| `INBOX_TOKEN_KEY_PREVIOUS` | Optional. The old key while rotating. | |
| `MAIL_SOURCE` | `gmail` (default) or `fixture` (development and tests). Production refuses `fixture` unless `APP_URL` is an http loopback origin. | `gmail`; `fixture` in the demo |
| `INBOX_SCHEDULER` | `on` (default) or `off`. `off` stops the timed Gmail syncs only: the 90-day ledger clean-up and the no-response sweep run either way. | `on`; `off` in the demo |
| `INBOX_BACKFILL_DAYS` | Days of mail to scan on first connect, 1 to 365 | 30 |
| `ALLOW_PARTIAL_SETUP` | `on` or `off`. Production only: `on` lets the app start without sign-in (locked) or without `INBOX_TOKEN_KEY` (no Gmail). It never allows `MAIL_SOURCE=fixture`. | `off`: production needs them all |
| `DEMO_MODE` | `on` or `off`. `on` runs this copy as the public demo ([Public demo](#public-demo)). | `off` |
| `DEMO_URL` | Real app only. The public demo's origin, for example `https://demo.example.com`: https, or http on `127.0.0.1`, `localhost` or `[::1]`, and never the app's own origin. The sign-in page links to it. | No link to a demo |
| `TEST_DATABASE_URL` | Database for the tests. Development and CI only. | Database tests are skipped |

There is no session secret: sessions are random tokens, stored hashed in the database. There are no
`NEXT_PUBLIC_*` variables.
