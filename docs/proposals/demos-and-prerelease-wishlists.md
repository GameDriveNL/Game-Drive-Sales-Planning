# Proposal: Demos & Pre-release Wishlist Insights

**For:** Game Drive team
**From:** Josh (AI West)
**Date:** 2026-04-29
**Status:** Draft for your feedback

---

## Background

Two related questions came up in the last round of feedback:

1. **"How are demos shown?"**
2. **"When the game hasn't released yet, should we add the store page launch date for wishlisting insights, instead of the game launch?"**

Right now, the platform doesn't handle either of these the way you'd want. This document lays out what the current state is, why it matters, and a few options for how we could fix it. None of these are big builds — but the choices change how the data shows up day-to-day, so I want your input before we pick one.

---

## Question 1: Demos

### What happens today

The platform has **no concept of a demo**. Every Steam app linked to a client gets treated as a regular game — wishlists, sales, coverage are all rolled up under the main product. If a client has both `Coal Country` (the full game) and `Coal Country Demo` (the demo) live on Steam, the demo's wishlists and downloads either:

- get bundled into the main product's numbers (confusing the totals), or
- get ignored entirely (because nobody linked the demo's app ID).

There's no way today to look at the dashboard and answer "how many people downloaded the demo this week?" or "what's the conversion rate from demo to wishlist?"

### Why it matters

Demos are a major PR moment now (Steam Next Fest is built around them) and clients increasingly want to know:

- Who downloaded it
- How many of those people then wishlisted the full game
- Whether the demo drove a coverage spike

If we don't show demos as their own thing, we can't answer any of that.

### Three options

**Option A — Quick win: tag demos as a separate "product type"**

We already have a "product type" field on each product (currently: base game, edition, DLC, soundtrack, bundle). We add **Demo** as a 6th type. Demos still live under the same parent game, but they get their own row in analytics and a "Demo" badge in the UI.

- 👍 Cheapest to build (~half a day). Reuses everything we already have.
- 👍 Demos still roll up into the parent game's coverage automatically.
- 👎 Wishlist sync still doesn't really apply to demos (Steam doesn't expose wishlists for demos), so the demo row would mostly show downloads + sales = 0.
- 👎 Doesn't give you a "demo → full game conversion" view.

**Option B — Medium build: dedicated Demo widget**

Same as Option A, plus a new "Demos" panel on the game's analytics page that shows:

- Demo download count (from Steam Partner API)
- Wishlist additions on the parent game during the demo's lifetime
- Coverage activity for the demo specifically (filtered by keyword)

- 👍 Answers the conversion question directly.
- 👍 Looks polished — feels like a real feature, not just a checkbox.
- 👎 Bigger build (~2-3 days). Steam's demo download data needs a different API call than sales data.

**Option C — Full build: demos as first-class events on the timeline**

Treat each demo release as a tracked event on the Gantt chart, the same way sales are tracked. Cooldown rules, performance snapshots, "compare to last demo" — the full treatment.

- 👍 The strongest long-term answer. Demos become part of the planning workflow, not just a reporting artifact.
- 👎 Significant scope (~1 week+). Probably overkill if you mostly want to *report* on demos rather than *plan* them.

### My recommendation

**Start with Option A now, plan Option B for next month** if clients keep asking. Option C is a nice-to-have we can revisit when the PR coverage tool is fully shipped.

---

## Question 2: Pre-release games & the "wishlist baseline" date

### What happens today

Every product has one date field: **launch date** — meaning the day the game goes (or went) on sale. The wishlist analytics chart anchors itself to this date.

That's fine for released games. But for an **unreleased game**, the launch date is either:

- 6+ months in the future (so the chart treats today's wishlists as "pre-launch" with no useful baseline), or
- not set at all (so the chart shows wishlists in a vacuum, with no anchor).

The client's point is correct: for an unreleased game, the moment that actually matters is **when the Steam store page went live** — because that's the first day the game could be wishlisted. Everything before that is zero by definition. Anchoring the chart to the store page date gives you "X wishlists in Y days since the page went live," which is the metric publishers and PR teams actually use.

### Three options

**Option A — Add a single new date field: "Store page live date"**

Every product gets a new optional field. If filled in, the wishlist chart uses it as day zero for unreleased games, and falls back to launch date once the game is released.

- 👍 Simplest possible answer. Solves the immediate problem.
- 👍 Easy for the team to understand: one extra field on the product form.
- 👎 Manual: someone has to type the date in for each product.

**Option B — Auto-pull store page date from Steam**

Same field as Option A, but we automatically grab the date from Steam's public store API when a product is created or synced. The team can override it manually if Steam has it wrong.

- 👍 Zero manual work — fills itself in.
- 👍 We can backfill all existing pre-release games in one pass.
- 👎 Slightly bigger build (~1 day extra) and Steam's store API isn't 100% reliable for this field — sometimes it just says "Coming Soon" with no date.

**Option C — Smarter "release status" model**

Instead of one launch date, every game has a small status object: `{ status: "announced" | "store_page_live" | "released", store_page_date, release_date }`. The dashboard adapts what it shows depending on the status — pre-release games get a wishlist countdown, released games get sales charts, etc.

- 👍 The cleanest model long-term. Lots of downstream features (PR coverage, sales planning) could key off this status.
- 👎 More invasive change — touches a lot of existing screens. Bigger build (~3-4 days) and more testing.

### My recommendation

**Option B.** Auto-pulling the date is worth the extra day of work — otherwise the field will just be empty for half your catalog and the feature won't actually do anything. Option C is the "right" answer architecturally, but I'd hold it until we've shipped Option B and learned whether the team actually uses it.

---

## What I need from you

For each question, just pick a letter (or tell me you want something different):

- **Demos:** A / B / C
- **Pre-release wishlist date:** A / B / C

Once you confirm, I can scope the work and slot it into the next sprint.
