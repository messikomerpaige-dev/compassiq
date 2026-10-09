# CompassIQ

Territory routing planner for field sales reps.

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
