# Demo mail (`fixtures/mail/`)

Invented mail that the fixture mail source serves when `MAIL_SOURCE=fixture`: in development,
in tests and in CI, without any Google secret. The code is
`src/lib/server/inbox/source/fixture-source.ts`; the sync engine cannot tell it from Gmail.

Everything here is made up: people, companies, `example.com` and `*.example` addresses. Several
messages belong to the demo jobs of `db/seed/fixtures.ts` (Ember Finance, Brightline Energy,
Lumen Health, Northwind Labs, ...), so a development "Check inbox" on a seeded database moves
them along. Two go to the review list: an interview invitation for the already rejected Kelpie
Analytics job ("Doesn't fit the current status") and a call request from an applicant-tracking
system for a company with no demo job ("Unknown job"). The expected outcome of every file is the
table in `tests/db/inbox/ingest.test.ts`.

## File format

One file per message, named `<what-it-is>.json`. Each file is a Gmail `Message` resource in
`format=full`, as `users.messages.get` returns it:

- `id`, `threadId`, `labelIds`, `snippet` (HTML-escaped, as Gmail sends it), `sizeEstimate`
- `internalDate`: when Gmail received it, milliseconds since the epoch as a decimal string
- `payload`: the MIME tree. Headers are `{ "name", "value" }` arrays; all message headers sit on
  the top part. Part bodies are `{ "size", "data" }` with `data` in **base64url**, or
  `{ "size", "attachmentId" }` for an attachment reference.

Keys starting with `_` are not part of the message, and the source removes them:

- `_note`: one line saying what the message is and what it tests.
- `_attachments`: `{ "<attachmentId>": "<base64url data>" }`, what `getAttachment` answers.

`historyId` is not stored: the source numbers the messages itself (below).

## Dates and history

Files keep fixed dates (November 2026). The source moves every message by the same whole
number of days so that the newest one falls within the 24 hours before "now"; the others keep
their spacing, a few days back. So a development "Check inbox" finds the demo mail on any day,
even with the 30-day first scan. `internalDate` and the `Date` header move; dates written inside
bodies (such as an "On Tue, 10 Nov 2026 … wrote:" line) do not.

History ids follow the file dates: the oldest message gets `100001`, the next `100002`, and so
on, and `getProfile` answers the highest. Tests can make `listAddedSince` fail with
`history_expired` through the source's `historyExpired` option.

The first scan (`listMessageIds`) leaves out mail labelled `SENT`, `DRAFT`, `CHAT`, `SPAM` or
`TRASH`, like the engine's Gmail query; `listAddedSince` reports everything, like Gmail's history.

## Adding a fixture

1. Copy the file closest to what you need and give it a new name and a new, unique `id` (16 hex
   digits). A reply in an existing thread takes that thread's `threadId`.
2. Set `internalDate` and the `Date` header. Remember that dates are moved as a block: the
   newest file decides where "today" is.
3. Write the body as text, then encode it:

   ```sh
   node scripts/mail-body.mjs encode body.txt                     # UTF-8
   node scripts/mail-body.mjs encode --charset iso-8859-1 body.txt
   ```

   Put the printed `size` and `data` into the part's `body`, and make the part's
   `Content-Type` charset match.
4. Check the result: `node scripts/mail-body.mjs decode fixtures/mail/<file>.json`.
5. Update `snippet` and `_note`, and run `npx vitest run tests/unit/inbox`. Tests that pin
   outcomes for the whole folder (history ids, counts) may need their expectations updated.
