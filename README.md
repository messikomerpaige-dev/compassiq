# CompassIQ

Territory routing planner for field sales reps, run as a hosted web app: each client company gets
its own private space, reps sign in and see only their own territory, and access can be turned off
for a person or a whole company at any time.

**Putting it online:** see [SETUP.md](SETUP.md).

## How the cloud version works (Phase 1)

| Piece | What it is |
|---|---|
| `supabase/migrations/` | Database: companies, territories, people, doctor data. Row level security means people only ever read their own company, and reps only their territories; nothing is readable once a person or company is turned off. All writes go through checked database functions. |
| `api/` | Vercel serverless functions: sign-in sessions (HttpOnly cookies), the rep app's data feed, company admin, and the CompassIQ team's company controls. |
| `public/` | Sign-in, set-password, Team & territories (`/admin`), Client companies (`/platform`), and the access-turned-off page. |
| `scripts/build.mjs` | Builds the rep app (`/app`) and the hosted admin tool (`/admin/tool`) from `CompassIQ_ADMIN.html` on every deploy. |

**The rep app has no data inside.** `/app` is the field template with an empty doctor list. When it
opens, it loads `/api/app-data`, which returns only the signed-in person's territories, or sends
them to sign in or to the blocked page. The app no longer offers "Save backup" files.

**Sessions:** the browser signs in with Supabase and hands the tokens to the server, which keeps
them in HttpOnly cookies and refreshes them, so there is one session holder.

## What reps enter is kept in the cloud (Phase 2)

| Data | Stored | Who sees it |
|---|---|---|
| Doctor preferences: office hours and locations by day, do-not-call, by-appointment-only, and a corrected main address | `hcp_prefs`, one row per doctor per company | Everyone at the company who can see that doctor. The latest edit wins. |
| Visit outcomes (done / missed) | `visit_outcomes`, per person | The person who logged it, plus owners, admins and managers for their territories |
| Plan, meals, notes and settings | `rep_state`, per person | Only that person |

How it works:
- **Syncing:** the app's sync queue (`/api/ping`, `/api/sync`, `/api/prefs`) sends outcomes and
  preferences shortly after each change. The queue survives being offline.
- **Shared preferences on open:** the doctor list each person receives includes the company's
  latest shared preferences and addresses. An edit on the device that hasn't been sent yet is kept.
- **Plans:** plans and settings upload after changes (`/api/state`). A new iPad, a cleared browser or
  a second device gets them back when the app opens.
- **Moving territory:** when an admin moves a rep to another territory, the app opens "Change
  territory" with the new one picked. Their hours, home ZIP and time off stay the same.

## Call activity feed, team view and offline mode (Phase 3)

**Call activity in the cloud.** Completed calls are stored per company (`call_activity`, one call per
doctor per day) and come in two ways:
- **From the data warehouse:** an owner or admin selects **Connect data warehouse** on Team &
  territories to create a key. The warehouse posts calls to `/api/activity` with that key (see
  [the format below](#data-warehouse-feed)). Keys are stored only as hashes, can be revoked, and stop
  working when the company is suspended.
- **Upload:** **Upload calls** on Team & territories takes the same columns from Excel or CSV.

Each rep's app pulls its doctors' calls when it opens (and right after first-time setup). When
something changed, it applies them and rebuilds the rest of the quarter from the "calls through"
date. Visits marked done in the app count as calls too (from before today).

**Team view (`/team`).** For owners, admins and managers, covering the reps in their territories:
- calls vs. quarterly goal, with a marker for where the rep should be today;
- doctors reached, and missed visits;
- when the plan last synced.

Selecting a rep shows their week's visits (with done/missed), the doctors not reached yet, and the
missed visits with reasons. Managers reach it from the account box in the app; admins also from the
top bar.

**Offline mode.** A service worker (`public/sw.js`, scoped to `/app`) keeps the app and the
person's doctors on the iPad, so CompassIQ opens without a connection:
- Visit outcomes, preferences and plan changes made offline are kept and sent when the connection
  returns. A banner shows while offline.
- The offline copy is refused after 7 days without an online open, since access may have been
  turned off in the meantime.
- It is erased on sign-out, when the server reports the person signed out or turned off, and on
  the blocked page.
- Sign-in, admin and team pages are never cached.
- Map tiles and road drive times need a connection.

The app can be added to the home screen (`manifest.webmanifest`, icons in `public/`).

## Tests

```
npm install
npm test            # database access rules + server endpoints (in-memory Postgres)
npm run test:e2e    # full browser flows (needs Playwright's Chromium)
```

The tests run the real database migration in PGlite, with a stand-in for Supabase's auth service.

## Files

| File | What it is |
|---|---|
| `CompassIQ_ADMIN.html` | Admin tool. Loads HCP data, trends and call activity, and publishes the rep (field) file. A copy of the field app is embedded in it as base64 (`<script type="text/plain" id="ciq-field-template">`), so any change to shared app code must also be made in that embedded copy. |
| `CompassIQ_Field_DEMO.html` | Field app with demo data, for sales demos. |

## Call activity (v4.6)

Completed calls from the data warehouse drive mid-quarter planning. Load them under
**Settings → Call activity**, in step 3 of the admin console, or pull them live.

### File format

Use one row per call (recommended):

| Column | Required | Notes |
|---|---|---|
| `NPI` | yes | |
| `Call_Date` | yes | `YYYY-MM-DD`, `M/D/YYYY` or an Excel date |
| `Call_Type` | no | Each type can be switched on or off as "counts toward goal" in the card |
| `Status` | no | Rows marked planned, scheduled, cancelled, deleted, draft, saved, pending, missed, declined, void, not submitted or open are skipped |

Or use one row per doctor: `NPI`, `Calls_QTD`, and optionally `As_Of`.

Rules:
- Column names are matched loosely, so `Call Date`, `call_date` and `CALLDATE` all work.
- A doctor counts at most one call per day.
- Only calls in the quarter of the latest call date ("as of") are counted.

### How planning uses it

When a plan starts in the same quarter as the activity:
- **Calls planned per doctor** = quarterly goal + trend extras − completed calls (never below 0). This replaces prorating goals by the share of the quarter left.
- **Doctors already at goal** get no calls.
- **Doctors not reached yet** get their first visit within the first third of the plan, add weight to their area early on, and are trimmed last when capacity runs short.
- **Doctors already reached** can be trimmed to 0 more calls when capacity runs short.
- **The R&F report** shows "Done + planned" against the full quarterly goal.

Activity is stored on each HCP record (`h.act`), the same way trends are, so it carries through publishing to reps.

### Data warehouse feed

The warehouse sends completed calls with the company's key. CSV:

```
POST /api/activity?through=2026-10-13
Authorization: Bearer ciq_live_…
Content-Type: text/csv

NPI,Call_Date,Call_Type,Status
1234567890,2026-10-13,In-person,Submitted
```

or JSON:

```
POST /api/activity
Authorization: Bearer ciq_live_…
Content-Type: application/json

{ "through": "2026-10-13", "calls": [ { "npi": "1234567890", "date": "2026-10-13", "type": "In-person" } ] }
```

Response: `{ "rows": <calls stored>, "through": "YYYY-MM-DD", "skipped": <rows without an NPI or readable date> }`.

How the server handles a load:
- It uses the same columns and status rules as the file format above.
- `through` is the date the load covers. Without it, the latest call date in the load is used.
- Sending the same calls again is harmless, so a nightly job can resend the whole quarter.
- An invalid or revoked key gets `401`.

### Live pull API

The app (and its **Pull from data warehouse** button) reads calls back with:

```
GET /api/activity?from=YYYY-MM-DD     (signed-in cookie session)
→ 200 { "asOf": "YYYY-MM-DD", "through": "YYYY-MM-DD", "calls": [ { "npi": "...", "date": "YYYY-MM-DD", "type": "...", "status": "..." } ] }
```

It only returns calls for doctors in territories the signed-in person may see. `asOf` is the
later of the latest load's "through" date and the newest call.

## Road drive times for stop order (v4.6)

When road drive times are cached (**Settings → Real Drive Times**), each day's stops are put in
order using road minutes between ZIP codes instead of straight-line miles. This applies to the
main route optimizer (Held-Karp for up to 11 stops; nearest-neighbor + 2-opt + Or-opt above
that) and to the re-sequencing pass after mop-up.

- Any ZIP pair missing from the cache uses the existing tiered road estimate.
- Stops in the same ZIP keep their small spacing so they still order sensibly.
- With no cache, plans are identical to v4.5.

**Routing server:** The **Routing server** field sets the OSRM-compatible server used to fetch
drive times. Leave it blank to use the free public server (`router.project-osrm.org`), which is
for testing only. Clients need your own OSRM server or a commercial OSRM-compatible one.

## Quarter improvement pass (v4.6)

After every other planning pass, a local search runs over the whole quarter. It moves a visit to
another day, or swaps two visits between days, whenever that lowers:

- **total drive minutes:** home → stops → home on every day, using road minutes when cached;
- **plus 15 minutes for every week a doctor's visits are bunched.** Visits should be at least
  about 60% of the even gap apart (plan weeks ÷ visits). Set `STATE.config.spacingWeight` to change the 15.

It leaves these alone:
- locked days, half-days, hotel/sweep days and overnight-distance days;
- meals (and it doesn't add visits to meal days);
- by-appointment doctors, and doctors with an alternate address, late opening, early closing or a
  preferred window on that day;
- group-practice visits that are seen together.

It never moves a doctor's first visit later, so new, trend-flagged and not-yet-reached doctors stay
early. It respects the daily call target, availability, the once-a-week limit per doctor and per
office, and the workday length. Touched days are re-timed in the improved order. The pass is capped
at 2.5 seconds, and the plan log shows an `[IMPROVE]` line with the before/after numbers.

Results on test territories (same calls, no rule violations):

| Territory | Drive time | Bunched visits (weeks short) |
|---|---|---|
| 40 doctors | −5% | 88 → 0 |
| 250 doctors | −6% | 277 → 0 |
| 250 doctors with restrictions | −11% | 267 → 18 |
| Demo file (90 doctors) | −19% | 103 → 13 |
