# Job Tracker — design system

The rules every screen follows. Exact values, not adjectives. Tokens live in
`src/app/globals.css`; stage logic in `src/lib/stages.ts`.

## 1. The screen's job

The Applications page answers **"how is the search going, and what is waiting?"**
at a glance, then shows the pipeline. Top to bottom:

1. **Header**: title, `23 jobs tracked. Inbox synced 4 minutes ago.`, search,
   the Board / Table switch, `Add a job`.
2. **KPI row**: waiting for a reply (the lead tile), applications sent per
   week, reply rate, interviews in progress, the sent-to-offer funnel
   (`src/lib/overview.ts`).
3. **Review banner**: emails the inbox sync couldn't file, with the choice
   offered inline when one click settles it.
4. **Pipeline**: a board of cards (default) or a table.

## 2. Colour

A neutral grey scale, a near-black primary, and **one accent**. Colours are
named by function, never by hue.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#ffffff` | `#141414` | Page panel, cards |
| `foreground` | `#171717` | `#ececec` | Body text |
| `muted` | `#f4f4f4` | `#222222` | Pills, skeletons, hover fills |
| `muted-foreground` | `#6b6b6b` | `#a3a3a3` | Secondary text (≥ 4.5:1 on background) |
| `border` | `#e6e6e6` | `rgb(255 255 255 / .09)` | Hairlines, card borders |
| `primary` | `#171717` | `#ececec` | Primary buttons, focus ring |
| `sidebar` | `#f7f7f7` | `#0d0d0d` | App frame behind the panel |
| `surface-sunken` | `#fafafa` | `#101010` | Quiet background change (notes) |
| **`attention`** | **`#c2410c`** | **`#fb923c`** | **The accent. Text, dots, borders.** |
| `attention-subtle` | `#fff3eb` | `rgb(251 146 60 / .13)` | Tint behind attention text |
| `destructive` | `#dc2626` | `#f87171` | Errors and delete only |
| `highlight` | `#fef08a` | `rgb(250 204 21 / .28)` | Matched keywords in email bodies |
| `lead` / `lead-foreground` | `#171717` / `#fafafa` | `#242424` / `#ececec` | The lead KPI tile: a filled dark surface in both themes |
| `lead-attention` | `#fb923c` | `#fb923c` | The accent as a mark on the lead tile |
| `chart-sent` | `#171717` | `#ececec` | Chart columns and meters: neutral ink |

**The accent means "this needs you".** It is used for exactly three things:

- an **offer** (card border, respond-by date),
- an **overdue follow-up** (Applied ≥ 14 days without news): the meter on the
  card and in the lead tile,
- **unmatched emails** (sidebar badge, the review banner's icon).

The lead KPI tile is filled with `lead`: near-black in light mode, a raised
grey in dark mode (never an inverted white block). A surface, not a second
accent.

Everything else is neutral, including statuses. Never use colour alone: the
accent always sits next to words that say why.

## 3. Type

Plus Jakarta Sans for UI, Geist Mono for code. Five sizes and two weights do
everything, plus the figure sizes of the KPI row.

| Role | Size / line height | Weight | Tailwind |
|---|---|---|---|
| Hero figure (lead KPI tile, one per page) | 48 / 48 | 600 | `text-5xl leading-none font-semibold` |
| KPI figure | 26 / 32 | 600 | `text-[1.625rem] leading-8 font-semibold` |
| Applications page title | 24 / 36 | 600 | `text-2xl leading-9 font-semibold` |
| Page title (other pages, sticky app bar) | 15 / 20 | 600 | `text-[15px] font-semibold` |
| Section heading (Settings sections) | 18 / 28, −0.01em | 600 | `text-section font-semibold` |
| Board column header, funnel title | 15 / 20 | 600 | `text-[15px] leading-5 font-semibold` |
| Stage band, body, card company | 14 / 20 | 600 · 500 · 400 | `text-sm` |
| KPI labels, card role, table meta | 13 / 18 | 400–600 | `text-meta` |
| Card meta line, counts, captions | 12 / 16 | 400–500 | `text-xs` |

- **Numbers that line up use tabular numerals** (`tabular`): dates, counts,
  days waiting, times, chart axes. A standalone KPI figure keeps proportional
  digits.
- Dates are day-first: `14 Nov`, `14 Nov, 09:12`, `Tue 17 Nov, 14:00`,
  `Today, 11:00`. The year appears only when it isn't this year.
- Semibold (600) only for headings, KPI figures and company names on cards.

## 4. Space and shape

- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32 px. Page gutter 16 px (mobile) /
  24 px. Blocks on the Applications page are 20 px apart, tiles and cards
  12 px; elsewhere a section heading sits 12 px above its content.
- Radius: 11 px (`rounded-xl`) for KPI tiles and the review banner; 8 px
  (`rounded-lg`) for job cards, dialogs and popovers; 6 px (`rounded-md`) for
  inputs and menus. Never nest equal radii.
- **Separate with a border or a background change, never both.** Tiles and cards
  have a border on the page background; board columns have none, only a 2 px
  rule under the header. A background appears only as a state (hover, drop
  target), plus two structural exceptions: the lead KPI tile and the table's
  stage bands.
- Controls are 36 px tall with a mouse and 40 px on touch screens.

## 5. Components

### Stages

Six statuses show as five stages (`src/lib/stages.ts`):

| Stage | Contains | Card footer |
|---|---|---|
| Saved | saved | `Mark as applied` button |
| Applied | applied | Meter + `12 of 30 days` (accent meter and semibold text from day 14) |
| Interview | interview | `Technical interview, Tue 17 Nov, 14:00` or `Invited 6 Nov, no time set yet` |
| Offer | offer | `Respond by 19 Nov · 4 days left` (accent) |
| Closed | rejected, **no response** | Compact rows: `Rejected 2 Nov`, `No reply by 1 Nov` |

Each stage has a **glyph** (`stage-icon.tsx`), a 14 px ring that fills as the
application moves forward: Saved ◌ (dashed), Applied ◔, Interview ◑, Offer ◕,
Closed ⊗. Shape tells the stages apart, never colour. It always sits next to the
stage's name (board column headers, table bands), never on a row or card.

Dropping a card on **Closed** marks it rejected. Dropping it back on its own
column changes nothing.

### KPI row

Five tiles in one row (`kpi-row.tsx`); two columns below a 1024 px container,
one column on phones. Every tile: label (13) · figure · one caption that names
the base.

- **Waiting for a reply** (lead tile, `lead` fill): the count of Applied
  jobs as the page's one hero figure, the rule (`Jobs move to No response after
  30 days`, from Settings), and the three longest-waiting jobs with a meter and
  their days. Rows open the job.
- **Applications sent**: all-time total, `6 this week, 4 last week`, and a
  column chart per calendar week (Monday first): 8 weeks, growing to 12 as the
  search gets older. One series in `chart-sent`, columns ≤ 14 px, rounded top,
  hairline grid, no animation. Only the current week carries its value; the
  tooltip (`Week of 9 Nov`) and a visually hidden table cover the rest.
- **Reply rate**: sent applications that got an interview, offer or rejection.
- **Interviews in progress**: jobs in Interview, `Next: Tue 17 Nov, 14:00`.
- **From sent to offer**: Sent → Answered → Reached an interview → Offer, each
  a count, its share of sent, and a meter.

Everything is derived from each job's status history, so a job that went
Applied → Interview → Rejected still counts as answered and interviewed.
Meters and columns are neutral ink; the accent only marks an overdue follow-up.
Hidden together with the review banner when jobs fail to load or there are none.

### Review banner

One bordered line under the KPI row (`review-banner.tsx`), shown only while
emails wait for review: accent icon, `4 emails need your review.`, then the
email that is easiest to settle. When it fits several applications and its
meaning is clear, each candidate is a button (the company, or the role when the
company is the same) that files it on the spot. Otherwise the reason, and
`See all 4`.

### Job card (board)

- Bordered card, 8 px radius: **company** (600), role, then location on the left
  and `Saved 14 Nov` / `Applied 20 Oct` on the right, then the stage's footer.
- No status pill or avatar. The column is the status.
- The whole card opens the job. The status changes by drag & drop, `Mark as
  applied`, or the `⋯` menu, which appears on hover or focus and is always
  visible on touch screens.
- Offer: accent border.

### Board (default view)

- Columns have no container or background. Header: glyph · label (600) · count,
  a 2 px rule, plus `+` on Saved and Applied. Five columns fit side by side from
  an 896 px container; below that the board scrolls sideways.
- A column shows 4 cards, then `Show N more`. A search shows every match.
- Closed holds one card per outcome, `Rejected` and `No response`, each with
  2 compact rows and `Show all`. Rows drag like cards.
- No status filter on the board: it is already grouped by status.

### Table

- Grouped by stage, no outer box. Three signals separate the stages:
  - **Stage band**: a 36 px `muted` bar, `rounded-md`, with chevron · glyph ·
    label (600) · count. Hover `accent`.
  - **Space**: 24 px above each band (12 px above the first), 4 px below it.
  - **Sticky**: the band sticks to the top while its rows scroll.
- Within a stage, hairlines between rows. The first row under a band has none.
- Columns: Company · Role · Where it stands · Location (wide) · Last activity
  (wide) · `⋯`.
- The status filter and the sort order sit above the table and exist only here.
  Default sort: **Next step first**. Closed starts folded.

### Shell

- Flat sidebar nav without section labels: Applications, Needs review, Email
  activity, Settings. No tagline. The sidebar toggle sits left of every page
  title.
- Theme lives in **Settings**, not the header.
- The sidebar footer shows the inbox and `Last synced 14 Nov, 09:12`.

## 6. States

Every view has all four:

| State | Pattern |
|---|---|
| Loading | Skeletons with the same footprint as the content |
| Empty | One sentence saying what will appear and how (`Nothing is waiting. Applications you send show up here until the company answers.`) |
| No results | Name the filter, offer `Clear filters` |
| Error | What failed, `Your data is safe`, `Retry`. One error per failure: when jobs can't load, the KPI row and banner hide instead of erroring again |

## 7. Copy

- Say what happened and what to do, not what "the app" thinks:
  `4 emails couldn't be matched to a job or status`, `Last synced 14 Nov, 09:12`.
- Actions start with a verb: `Mark as applied`, `Add a job`.
- One verb per action across the app: the inbox **syncs** (`Sync now`).

## 8. Ban list

- ❌ KPI tiles that only repeat a column's count. A tile earns its place with a
  rate, a pace or a deadline next to the number.
- ❌ Coloured "good/bad" deltas on KPIs. The caption says the direction in words.
- ❌ A status pill where position (column or group) already shows the status.
- ❌ More than one accent colour, or colour per status or per company.
- ❌ Random-hue avatars.
- ❌ Boxes in boxes: bordered cards inside bordered or tinted panels.
- ❌ Unlabelled corner icons. If the source matters, write it as text in the
  detail view.
- ❌ Section labels for a handful of nav items, sidebar taglines, theme toggles
  in the header.
- ❌ Relative-only timestamps for system state: the header's `synced 4 minutes
  ago` carries the exact time as a tooltip, and the sidebar shows it in full.
- ❌ Copy about the app's feelings (`The app didn't guess`).
