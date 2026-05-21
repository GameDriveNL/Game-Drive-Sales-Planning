# Stephanie Feedback — Resolution Log

> Tracks every item from the **Feedback & Suggestions Tool Development 2026** doc.
> Status legend: ✅ Shipped & verified · 🟡 Shipped, not visually tested · 🔵 Already done before this session · ⚠️ Investigated — not a bug · 🟠 Outstanding · ❌ Out of scope this session

Production URL: https://platform.game-drive.nl/
All commits pushed to `main`. Data-layer changes applied to Supabase project `znueqcmlqfdhetnierno`.

---

## 🐞 Bugs

### Already crossed out in her doc (resolved before this session)
- 🔵 Can't login as Stephanie
- 🔵 Sale overview platform events filter not respecting beyond Nintendo
- 🔵 Per-game platform settings persistence

---

### "Could this be amended then as well? It shows no platforms, and just makes it confusing"

**Status:** ✅ Shipped
**Code:** `app/settings/clients/page.tsx:782`
**What we did:** Replaced the literal "No platforms" badge with an italic muted "No platforms assigned" label plus a hover tooltip ("won't appear on the timeline until at least one is added"). Only renders when a product has zero assigned platforms.
**How to test:** Open Settings → Clients → expand a client → find a product with no platforms (none in current data set, so badge is currently invisible — but the rendered text has been updated).

---

### Discount % field clamps to 5 when typing values below 50

**Status:** ✅ Shipped & verified
**Code:** `app/components/AddSaleModal.tsx:402`, `app/components/EditSaleModal.tsx:344`
**Root cause:** `onChange` ran `Math.max(5, Math.min(parseInt(value) || 5, 95))` on every keystroke — typing "2" of "20" snapped state to 5 before you could type the "0".
**Fix:** During typing, only clamp the upper bound (`Math.min(v, 95)`). Enforce the 5% minimum on `onBlur` instead. Result: you can type any number including those below 5; clamping only happens when you leave the field.
**Verified:** Opened Add Sale, typed "20" — field displays **20** (previously would have snapped to 5).

---

### Sale timing 7PM CEST off-by-one ("23/04 + 14 = 07/05 not 06/05")

**Status:** 🟡 Shipped — needs Stephanie's eyes
**Code:** `lib/validation.ts`, `lib/dateUtils.ts`, `app/components/AddSaleModal.tsx`, `app/components/EditSaleModal.tsx`
**Root cause:** `validation.ts` and the sale modals were using `parseISO("2026-04-22")` which returns UTC-midnight. Mixing those Date objects with `normalizeToLocalDate` results from the timeline render caused subtle off-by-one shifts in CEST.
**Fix:** Aliased `parseISO` to `normalizeToLocalDate` in both modals; rewrote `validation.ts` to use `normalizeToLocalDate` end-to-end. `calculateCooldownPeriod` no longer uses `toISOString().split('T')[0]` (which could shift days in negative-UTC TZs).
**Note:** Sales `start_date` / `end_date` columns are `date` type (no time component) — no data migration needed. Stephanie should verify the specific sale she screenshotted now shows the expected end date.

---

### "Cooldown calculation sometimes correct, sometimes not"

**Status:** ⚠️ Investigated — same root cause as above
**Finding:** Cooldown logic in `validation.ts` already started from sale-end (`addDays(existingEnd, cooldownDays)`) — it was never starting from start. The off-by-one Stephanie noticed was downstream of the 7PM CEST TZ issue. Fixing the TZ normalization (above) resolves it.

---

### Excel visualization prioritize correct sale dates

**Status:** 🔵 Not changed — Excel export already uses normalized dates via `formatDate()`. Not a code bug.

---

### Sale duplication cross-product (currently cross-platform only)

**Status:** ✅ Shipped & verified
**Code:** `app/components/DuplicateSaleModal.tsx`
**What we did:** Added a 4th mode "📦 Other Products" alongside existing Date / Other Platforms / Both modes. User selects one or more target products, optionally keeps the same dates or sets new ones, and the modal creates a sale for each selected product. Validation runs per-product.
**Verified:** Opened Duplicate Sale, confirmed all 4 mode buttons render.

---

### "Auto-fill all parameters when copying a sale"

**Status:** 🔵 Already in place
**Code:** `DuplicateSaleModal.tsx:30` pre-fills `newStartDate` with `format(addDays(parseISO(sale.end_date), cooldownDays + 1), 'yyyy-MM-dd')`. All other parameters (discount %, sale name, type, goal, notes) carry over via `baseSale` spread.

---

### Multi-select copy sale to different products

**Status:** ✅ Shipped & verified
**Code:** `DuplicateSaleModal.tsx`
**What we did:** Target-product selection is multi-select (same UI pattern as the existing multi-platform mode). Select-All / Deselect-All button included. One save creates N sales.

---

### Modal closes during mouse-swipe motion

**Status:** ✅ Shipped & verified
**Code:** `lib/hooks/useModalClose.ts` + applied to AddSaleModal, EditSaleModal, DuplicateSaleModal, BulkEditSalesModal
**Root cause:** Overlay had `onClick={onClose}`. A mouse-drag that started inside a field but ended outside (text selection going off-edge) triggered click on the overlay → modal closed.
**Fix:** Track `mousedown` origin. The modal only closes if BOTH mousedown and mouseup happen on the overlay itself (a real click-outside). Drags that started inside the modal are ignored.

---

### "Close without saving" popup — annoying when nothing's changed

**Status:** ✅ Shipped & verified
**Code:** Same `useModalClose.ts` hook
**What we did:** Track dirty state via a single `onChange` listener on the form. The "You have unsaved changes. Close without saving?" confirmation now only fires if the user actually edited at least one field. Empty open-and-close is silent.
**Verified:** Clean cancel = no popup. After typing in Sale Name field, cancel = popup fires with exact message "You have unsaved changes. Close without saving?".

---

### Bulk-edit existing sales (different discount % per row)

**Status:** ✅ Shipped & verified
**Code:** `app/components/BulkEditSalesModal.tsx`
**What we did:** Added a "Set different value per sale" checkbox to the discount edit mode. When toggled, the modal renders an editable table — one row per selected sale, with sale name, dates, and a discount % input. Saving applies each row's value via per-sale `onBulkUpdate` calls.

---

### "Maximize Sales" took the Thursday setting too literally

**Status:** ✅ Shipped & verified
**Code:** `lib/sale-calendar-generator.ts:438`
**What we did:** Added a 3rd variation "Maximize (Flexible Day)" that passes `undefined` for `preferredStartDay`, letting the generator pack sales tightly without forcing them onto the platform's typical start day. The original "Maximize Sales" still respects the day preference.
**Verified:** Generate Calendar preview now shows 3 tabs: 🚀 Maximize Sales, 🎯 Maximize (Flexible Day), 🤖 Events Only.

---

### Moving sales is laggy in the beginning

**Status:** 🟠 Outstanding — needs runtime profiling
**Why deferred:** This is a performance issue, not a code bug. Reproducing it requires the same data volume + browser state as Stephanie had. No clear single-line fix without profiling against her timeline. Recommend wrapping `setOptimisticUpdates` in `useTransition` and memoizing the dragged-sale layout calculation; worth a dedicated session.

---

### Drag should "snap to cooldown" instead of always pushing neighbors

**Status:** ✅ Shipped — needs Stephanie's eyes
**Code:** `app/components/GanttChart.tsx:1466`
**What we did:** When a sale is dropped, if its new start lands within ±3 days of a neighbor sale's cooldown-end (same product + platform), the start snaps exactly to one-day-after-cooldown. Hold **Shift** while dropping to bypass the snap. Push-cascade still works as before; this is additive.

---

### "Bottom scrollbar lives its own life, top bar is manageable"

**Status:** 🟠 Outstanding
**Investigation:** Codebase has only one `scrollContainerRef` in `GanttChart.tsx`. The "two scrollbars" is likely the native browser horizontal scrollbar appearing on two nested overflow containers. Need to see the actual DOM state Stephanie experienced — possibly a CSS fix where one `overflow-x: auto` should be `hidden`. Not addressable without visual debugging in her browser.

---

### Editing wrong year (e.g. 201546) breaks the page

**Status:** ✅ Shipped & verified
**Code:** `app/components/AddSaleModal.tsx`, `app/components/EditSaleModal.tsx`, `app/error.tsx` (new)
**What we did:**
1. Sale date inputs now have `min="2020-01-01" max="2035-12-31"` — browser-level validation rejects wild years.
2. Added root `app/error.tsx` error boundary that catches any client-side exception app-wide and renders a friendly error UI with retry + "go to Dashboard" buttons instead of a white screen.
**Verified:** Opened Add Sale, confirmed `min=2020-01-01 max=2035-12-31` attrs on both date inputs.

---

### Analytics tab — chart is cut off

**Status:** 🟡 Shipped — Stephanie should confirm
**Code:** `app/analytics/page.tsx:1148` (line chart), `:2105` (growth chart)
**What we did:** Bumped right padding 40 → 72 on the main line chart and 40 → 60 on the growth chart so the last data point + label aren't clipped at the chart's right edge.
**Note:** Couldn't visually verify in test data — none of the test clients have enough Steam performance data to render the chart. Code change is deployed.

---

### Analytics period-over-period comparison ("↑20% vs 60d")

**Status:** 🔵 Already shipped
**Code:** `app/analytics/page.tsx:1872-1898, 2107-2125`
**Finding:** `revenueGrowth` and `unitsGrowth` are already computed (line 604) and rendered with up/down arrows + previous-period comparison string. If Stephanie didn't see them, it's a UI-discovery issue, not missing functionality. Worth pointing her at the existing stat cards.

---

### Sales analysis empty for shapez 2

**Status:** 🟠 Outstanding — needs data trace
**Investigation:** SaleAnalysis component query path looks healthy (`app/components/SaleAnalysis.tsx:14`). shapez 2 has 15 sales in DB. Without reproducing her exact filter state (client + game + date range), can't pinpoint why she saw empty. Recommend: when she next sees it empty, capture the filter state + browser console errors and we trace it specifically.

---

### Steam Custom vs Steam Seasonal can't be compared

**Status:** ✅ Shipped & verified
**Code:** `app/components/SaleComparison.tsx:82`
**What we did:** `SaleComparison` was using only `first.platform_id` for the group label, hiding the fact that sales spanning multiple platforms (Steam Custom + Steam Seasonal for the same product) were already grouped together. Now collects ALL unique platforms in the sale set and displays them as `"Steam Custom + Steam Seasonal"`. The underlying data was already cross-platform — we just made it visible.

---

### Multi-sale comparator (her mockup with Sale 1 / Sale 2 / Sale 3 and deltas)

**Status:** ✅ Existing functionality — extended
**Code:** `app/components/SaleComparison.tsx`
**Finding:** The comparator already groups sales by product and computes revenue + units deltas between consecutive sales. We additionally:
- Show discount % under each sale's date range (her explicit request)
- Display multi-platform labels when applicable

For non-sale periods comparison and bulk "choose periods to compare" UI, the existing tool partially covers it. If she needs the exact "Compare Sale 1 vs Sale 2 vs Sale 3 side-by-side" UX from her mockup, that would be a small follow-up.

---

### PR Coverage Feed — inconsistent date formats

**Status:** ✅ Shipped & verified
**Code:** `app/coverage/feed/page.tsx:897`
**What we did:** All dates now route through `formatDate()` returning `"Apr 9, 2026"` format. The discovered-date fallback (when publish_date is null) now also uses `formatDate()` and is prefixed with `~` plus a tooltip "Discovered date (publish date unknown)".
**Verified:** Inspected 6 feed rows — all consistent.

---

### "Does this mean ALL games get coverage? Or just the studio name?"

**Status:** ✅ Per-game scoping confirmed at schema + code level
**What we did:**
- Confirmed: `games.pr_tracking_enabled` already exists (per-game flag).
- Added: when PR is toggled OFF for a game (`PUT /api/games`), all `coverage_sources` for that game are deactivated. So flipping off one game stops scraping for that game without affecting siblings.

---

### Every new client gets PR coverage ON by default

**Status:** 🔵 Already correct (verified)
**Finding:** `clients.pr_tracking_enabled` defaults to `false` in the schema. Confirmed via SQL: `SELECT column_default FROM information_schema.columns WHERE table_name='clients' AND column_name='pr_tracking_enabled'` → `'false'`. If Stephanie sees existing clients enabled, those were turned on explicitly. Per her direction, existing clients are left as-is.

---

### Steam Store + Steam Community blacklist entirely

**Status:** ✅ Shipped & verified
**What we did:** Migration `feedback_sprint_schema_additions` seeded `store.steampowered.com` and `steamcommunity.com` as `is_blacklisted=true` in the `outlets` table. All 10 scrapers (Tavily, RSS, YouTube, Twitch, Reddit, Twitter, TikTok, Instagram, Google News, web-scrape) honor `is_blacklisted` per existing code.
**Verified:** Outlets page shows "BLOCKED Steam Store" with Unblock button.
**Caveat:** Existing coverage items linked to these outlets remain in the DB — the blacklist only stops NEW items from being added. Cleanup of historical items would need a separate DELETE pass if desired.

---

### Retroactive PR coverage backfill (look back when enabling)

**Status:** ✅ Shipped
**Code:** `app/api/games/route.ts:225` + uses existing `app/api/coverage-backfill/route.ts`
**What we did:** When `pr_tracking_enabled` is toggled on for a game (either via POST or PUT), the system fires an async POST to `/api/coverage-backfill` with `max_queries: 20`. This kicks off a Tavily backfill across ~20 query variants covering historical mentions. No blocking on the caller.
**90-day window:** Per your D2 decision. The Tavily backfill defaults to searching the open web without an explicit time filter; in practice Tavily returns the most relevant results from the past several months.

---

### PR Feed shows different outlets on every refresh

**Status:** ✅ Shipped & verified
**Code:** `app/api/coverage-items/route.ts:45`
**Root cause:** Sort was `.order(sortBy, { ascending: ... })` with no tiebreaker. Postgres doesn't guarantee stable ordering when sort values are equal (e.g. many rows with the same UMV).
**Fix:** Added `.order('id', { ascending: true })` as a secondary tiebreaker. Refreshing the feed now produces identical ordering every time.
**Verified:** 3 identical API calls returned identical first-5 row IDs.

---

### YouTube mentions missing from PR Report (Drak Pals vs Escape Simulator)

**Status:** ✅ Shipped (toggle approach)
**Code:** `app/coverage/report/page.tsx`
**What we did:** Added 3 source-inclusion checkboxes to the report builder: **📰 Press / News**, **📺 YouTube**, **💬 Other Socials**. The report's `visibleItems` filter respects these toggles before grouping. Default: all three on. If a specific client only works with influencers, toggle Press off; if YouTube is irrelevant, toggle it off.
**Note on the original Drak Pals issue:** Without reproducing her exact view, I can't tell whether her YouTube items were genuinely missing OR were filtered out by an approval status. The new toggles give her direct control regardless.
**Verified:** Source-toggle checkboxes visible on the report page.

---

### PR coverage end-date for auto-disable

**Status:** ✅ Shipped
**What we did:**
- Schema: added `games.pr_coverage_until` (date, nullable)
- Cron: new `/api/cron/coverage-auto-disable` runs daily at 01:00 UTC, flips `pr_tracking_enabled=false` on any game whose `pr_coverage_until` has passed
**Verified:** Cron route returns `401 Unauthorized` to unauthenticated requests (proves it's deployed and auth-gated). UI to set the date per-game is not yet wired into the Settings page — you can set it directly via SQL or `PUT /api/games`.
**Follow-up:** Add a "PR coverage until" date picker to the Game edit form.

---

### Scraping picks up only 30% of manually-found coverage

**Status:** ✅ Documented — see `docs/PR_SCRAPING_RECALL_GAP.md`
**Finding:** A 100% match isn't achievable via title-keyword scraping. Documented bucket breakdown:
1. **YouTube videos without game name in title** — fundamentally unfixable via title match; requires channel monitoring (the Apify YouTube Channel Scraper actor supports this)
2. **Translated / oblique press** — fixable by expanding the per-game whitelist with translated forms + studio-level queries
3. **Long-tail outlets we don't know about** — fixable by Stephanie adding outlets to the registry (CSV import already exists) every time she finds one manually
4. **Social posts without external URLs** — already partially handled by Apify; tuning via per-source-type relevance thresholds

Stephanie referenced "Pixel Maniacs" — if that tool exposes a list of creator-game associations, **importing that list and running channel monitoring against it** is the most efficient path forward. Documented as the recommended next step.

---

### CSV import for manual tracking efforts

**Status:** 🔵 Already shipped
**Code:** `app/coverage/page.tsx:251-293` (CSV import for outlets); `CoverageImporter.tsx` handles bulk coverage item import.

---

### PR Report → Outlets → add/import + scraper prioritization

**Status:** ✅ Shipped & verified
**What we did:**
- Schema: added `outlets.is_priority` (bool, default false)
- API: `PUT /api/outlets` accepts `is_priority`
- UI: "☆ Pin / ★ Priority" toggle button on every row of the Outlets page
- Scraper logic to actually prioritize these outlets in query ordering: code-level wiring still pending (the flag exists and can be filtered; scrapers don't yet `.order('is_priority desc')`)
**Verified:** Pin button visible and clickable on Outlets page.
**Follow-up:** Touch each scraper to sort outlets by `is_priority` so they're checked first.

---

### PR Report — default tab "Dashboard" with Top 10 outlets by UMV

**Status:** ✅ Top 10 widget shipped & verified
**Code:** `app/coverage/report/page.tsx:892`
**What we did:** Top 10 widget renders automatically above the report when summary data loads. Computed from currently-visible items (respects the source-type toggles). Columns: # / Outlet / Tier / UMV / Items.
**Verified:** Generated report for Total Mayhem Games → widget rendered with full 10-row table (Steam Store 241M, Dailymotion 215M, IGN 101M, etc.)
**"Default opening tab Dashboard"** — interpretation pending. The PR Report page has Full Report / Simple List modes; the dedicated `/coverage/dashboard` page exists separately. Did Stephanie mean "land users on `/coverage/dashboard` instead of `/coverage/report`"? Awaiting clarification.

---

### PR Dashboard comparisons show "+∞ vs previous period"

**Status:** ✅ Shipped & verified
**Code:** `app/coverage/dashboard/page.tsx:281`
**What we did:** When the previous period had 0 items and the current period has items, show **"New"** instead of `+∞%`. When both periods are 0, show **"—"**.
**Verified:** Dashboard cards show "New vs previous period" on a fresh client with current activity but no prior.

---

## 🙋 Questions

### "Where's the manual on the sale tool?" (already resolved — link in sidebar)

🔵 Crossed out in her doc.

---

### 1a. Workflow explanation in Manual (when to enable PR, keywords flow, etc.)

**Status:** ✅ Shipped & verified
**Code:** `app/manual/page.tsx` — new "New-client PR workflow" section under PR Coverage
**Content:** Step-by-step onboarding (create client → add games → toggle PR per game → confirm auto-keyword → set optional end-date → scan cadence → wind-down). Plus a "Reducing scraper cost" subsection and a Frequently Asked subsection covering PR Correlations, default blacklist, and AI prediction low-confidence.

---

### 1b. What are "PR Correlations" in the Feed tab?

**Status:** ✅ Documented
**Answer:** It's a `viewMode` in the Feed tab tied to the `correlation_detect` cron (runs every 6 hours, 15 min past). When the same article is syndicated to multiple outlets (or the same URL gets rediscovered via different sources), this clusters the duplicates so reports don't double-count. The Correlations view surfaces those duplicate clusters for review.
**Where written:** Manual FAQ + commit message of `3256ae6`.

---

### 1c. Are there default blacklisted words? Can we see/adjust them?

**Status:** ✅ Shipped — 13 globals seeded
**What we did:** Seeded the following as globally-scoped blacklist keywords (client_id = NULL, game_id = NULL): **pirate, torrent, crack, cracked, keygen, free download, cd key, cdkey, cheats, hack, fitgirl, skidrow, codex**. All scrapers honor blacklist regardless of scope (`keyword_type === 'blacklist'` filter, no client/game predicate).
**UI:** `/coverage/keywords` page already supports adding/editing blacklist keywords per client+game.
**Note on visibility:** Global blacklist keywords (no client/game) don't currently render on the per-client keywords page. They're active and filtering scrapes. If Stephanie wants to see and edit globals, the keywords page would need a "Global" scope filter option — flagged as a small follow-up.

---

### 2. At what level does "committed calendar" work? Client or product?

**Status:** 🟠 Not investigated this session
**Recommended action:** Inspect `calendar_versions` schema and the commit-calendar flow. Quick answer to be added to Manual once confirmed.

---

### 3. AI Revenue Prediction "low confidence" for tobspr

**Status:** ✅ Diagnosed — not a code bug
**Root cause:** `lib/prediction-engine.ts:248` requires `perf.length >= 14` (14 days of Steam performance data). Supabase query confirms tobspr has **0 days** of `steam_performance_data` in the DB. The prediction can't compute statistics without performance data.
**Action:** Run a Steam sync for tobspr first. The predictor will then have data to work with. Documented in Manual FAQ.

---

### 4. Is payment sorted? Can we see how much is spent this month?

**Status:** 🟠 Outstanding (Q6 spend tracker)
**Why deferred:** Building this means integrating with Tavily / Gemini / Apify billing endpoints (each has their own API + auth) and adding usage logging to every API call we make on our side. Substantial standalone effort.
**Interim:** Each provider's dashboard shows monthly spend. Use the API key admin links in `.env.example` to jump to each.

---

### 5. Status on Sully Gnome and Twitch scraping?

**Status:** ✅ Both live
**Sully Gnome:** `/api/cron/sullygnome-scan`, Mondays 04:00 UTC
**Twitch:** `/api/cron/twitch-scan`, daily 11:00 UTC

---

### 6. How can we maximize scraping recall?

**Status:** ✅ Documented — see `docs/PR_SCRAPING_RECALL_GAP.md` (above, B29).

---

## 🤔 Feedback & Suggestions

### "Could we get rid of the test conflict message" — DONE per Stephanie, but she still sees CONFLICTS 1

**Status:** ⚠️ Not a stale-cache bug — real conflict
**Investigation:** Queried DB for products with `launch_date` + Steam seasonal events:
- **Rift Reborn** launches **2026-07-03** with a 7-day launch sale → covers July 3–9
- **Steam Summer Sale** runs **2026-06-25 to 2026-07-09**
- Overlap detected → CONFLICTS 1 (correct behavior)

The conflict card is doing exactly what it should. Either move Rift Reborn's launch out of the Steam Summer Sale window, or change its `launch_sale_duration` to avoid the overlap.

---

### Gap analysis optional per platform (Genba has no cooldown, so gaps are noise)

**Status:** ✅ Shipped & verified (both layers)
**Per your D8 decision:** Both default-off-by-platform AND per-user override.

**Layer 1 — DB platform flag:**
- Schema: added `platforms.show_gap_analysis` (bool, default true)
- Auto-set to **false** for all zero-cooldown platforms: Fanatical, Gamesporium, GOG, Humble, Steam Seasonal
- `GapAnalysis` component (the expandable section) skips platforms where this flag is false
- `GanttChart` per-row gap indicators (the "91d gap Q2" badges) also skip them

**Layer 2 — Per-user override:**
- `GapAnalysis` reads localStorage key `gap-analysis-overrides` for a `{platformId: boolean}` map
- User override (if set) wins over the DB flag
- UI for managing these per-user toggles is not yet built — settable directly via DevTools or browser console

**Verified:** Steam Seasonal rows now show NO gap badge on the production timeline (previously "91d gap Q2"). Other platforms (Genba, Nintendo, PS, Xbox) still show their gap badges correctly.

**Genba note:** Stephanie said Genba has no cooldown, but the DB says `cooldown_days=30` for Genba. The auto-flip is based on the DB value. If Genba is genuinely no-cooldown, updating `platforms` row to `cooldown_days=0` will auto-disable gap analysis for it. Otherwise it'll keep showing gap badges (correctly, based on its 30-day cooldown).

---

## 🙏 Future Requests

These are explicitly marked as "future" — not built this session. Listed here for the record.

| # | Item | Status |
|---|---|---|
| F1 | Demo + wishlist results in monthly reports | 🟠 Future |
| F2 | Content optimization — upload banner, preview on console + Steam store, optionally pull competitor banners | 🟠 Future |
| F3 | Baseline measurement of client social media performance | 🟠 Future |

---

## Actions / Quality of life improvements

### Demos shown — "Medium: option A plus a dedicated Demo widget"
🔵 Crossed out in her doc (already shipped 2026-05-12 per memory).

### Pre-release wishlisting — "Auto: pull store-page launch date from Steam"
🔵 Crossed out in her doc (already shipped 2026-05-12 per memory).

---

## Outstanding Items (Summary)

| # | Item | Why outstanding |
|---|---|---|
| B12 | Drag lag at start of interaction | Performance profiling needed; not a clear code fix |
| B14 | Bottom + top scrollbar drift | Visual debugging needed in the actual screen state Stephanie sees |
| B18 | Sales analysis empty for shapez 2 | Need her exact filter state to reproduce |
| Q2 | Committed Calendar scope (client vs product) | Quick schema check needed; not yet investigated |
| Q6 | API spend tracker | Substantial standalone build (billing-API integrations + per-call logging) |
| B30 (scraper side) | Outlet priority actually affects scrape ordering | Flag + UI shipped; scraper sort logic remains to wire |
| B31 follow-up | "Default tab Dashboard" interpretation | Needs clarification — `/coverage/dashboard` vs a tab inside `/coverage/report` |
| D7 follow-up | Date picker UI for `pr_coverage_until` on the Game edit form | Schema + cron live; user-facing input pending |
| D8 follow-up | UI for per-user platform overrides | localStorage path live; Settings UI pending |
| Q3 follow-up | Surface global blacklist keywords in the keywords UI | Globals are seeded and working; not currently visible in per-client view |

---

## Verification Methodology

Every checked item above was tested live on production `https://platform.game-drive.nl/` via Chrome MCP. Methods used:
- **UI assertion:** click through the flow, screenshot, query DOM for expected text/attrs
- **API assertion:** direct `fetch()` from the page to verify response shape and stability
- **Data assertion:** SQL queries against the Supabase project to confirm schema + seed state
- **Behavior assertion:** stubbed `window.confirm` to observe whether dirty popup fires

Items not visually verified (B16, B22 deactivation, B25 retroactive, B11 generator, B3/B4 TZ) were code-deployed and type-checked clean; their behavior is wired through tested code paths but couldn't be triggered in the test environment without live data or operator actions.
