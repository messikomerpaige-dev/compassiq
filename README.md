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

**Not yet in Phase 1:** plans, visit outcomes and settings are still saved on the device, and the
device's data is erased if a different person signs in there, or when access is turned off.
Phase 2 moves plans to the cloud, adds offline mode, and turns on the live call-activity pull
(`/api/activity`).

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

### Live pull API (for the cloud backend)

The **Pull from data warehouse** button only appears when the app is opened from a web address. It calls:

```
GET /api/activity?from=YYYY-MM-DD[&territory=<territory name>]     (same-origin cookie auth)
→ 200 { "asOf": "YYYY-MM-DD", "calls": [ { "npi": "...", "date": "YYYY-MM-DD", "type": "...", "status": "..." } ] }
```

Field builds send their territory; the admin build pulls all territories. The server must
only return calls for territories the signed-in user may see. If the server returns 404, the
app tells the user live sync isn't set up and to load a file instead. If it returns 401 or 403,
the app asks them to sign in.

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
