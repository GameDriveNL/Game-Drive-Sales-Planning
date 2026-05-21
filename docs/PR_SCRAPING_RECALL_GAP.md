# PR Scraping Recall Gap — Audit (B29)

> Stephanie's report (Feedback doc, page 6): "The PR scraping is picking up only 30% of what we usually manually find."

## The honest assessment

A 100% match against manual finding is **not achievable** with web search + RSS + Apify alone. The remaining 70% she finds manually breaks down into a few buckets, in rough order of how solvable each is.

### 1. YouTube videos where the creator doesn't put the game name in the title

> Stephanie's own observation: "the videos where bigger creators don't put the name of the game in the title. So those can only be found manually."

This is fundamentally unfixable via title/keyword scraping. The only way to detect them is:

- **Manual relationship tracking** — keep a list of trusted creators per client (e.g. for Total Mayhem Games, the user mentions "Pixel Maniacs" — an influencer tool that picks these up via creator relationships rather than title matching)
- **Automated channel monitoring** — for known creators, scrape their channel's recent uploads regardless of title content, then OCR/transcript-match game artwork or names spoken in the video

Neither is currently implemented. Channel-level monitoring is the lower-effort follow-up; the Apify "YouTube Channel Scraper" actor supports it.

### 2. Coverage that uses non-obvious phrasing or translations

The current Tavily and RSS scanners query `"game name"` and a small set of variants. They miss:

- Translated coverage (German/French/Japanese sites that don't translate the game name)
- Articles that refer to the game obliquely ("the new game from [studio]")
- Roundup posts where the game is one item in a list

**Mitigations available:**

- Expand the keyword whitelist per game with translated forms ("艾斯凯普西姆雷塔" for Escape Simulator JP, etc.)
- Add **studio-level queries** alongside game-level queries (already partial — `Total Mayhem Games` is in keywords)
- Increase Tavily search depth from default to `advanced` — more API cost but better recall
- Run a secondary `${studio} ${month} ${year}` query pattern for roundups

### 3. Stale RSS feeds / outlets we don't track

Outlets without RSS feeds and below ~100K UMV often slip through. The Outlets registry has CSV import (already shipped), but the manual-tracking team finds long-tail outlets the system doesn't know about.

**Mitigations:**

- After every manual find, the user should add the outlet to the registry (CSV import or single-entry). The next scan will treat it as a known source.
- Run a periodic "outlets we just learned about" audit — flag manual coverage entries whose outlet_id is auto-created and propose a tier.

### 4. Social mentions without external URLs

TikTok, Instagram, Twitter posts that mention the game but link nowhere are harder to surface — the Apify actors do catch keyword-matched posts, but the volume is high and signal-to-noise is low.

**Mitigations:**

- Tighten Apify keyword filtering (already in place per `lib/coverage-utils.ts`)
- Allow per-source-type relevance threshold (e.g. require relevance ≥80 for TikTok, ≥50 for press) to suppress low-quality matches without throwing the source away entirely

## Concrete next steps to move recall toward 60-70%

| Action | Effort | Expected lift |
|---|---|---|
| Channel-level YouTube monitoring for top 10 creators per client | medium | +15-25% on YouTube subset |
| Translate top whitelist keywords per game | small | +5-10% on non-EN press |
| Add studio-level Tavily query | small | +5% on roundups/general press |
| Increase Tavily search_depth to `advanced` for top-tier clients | small (cost!) | +5-10% across the board, ~2× Tavily spend |
| Per-source-type relevance thresholds | medium | mostly precision, recall stays flat |

## What this NOT a fix for

The user mentioned an influencer tool called "Pixel Maniacs" that the agency uses. If that tool exposes a list of creator-game associations (or a creator roster), the most efficient path is to **import that list** rather than try to replicate its discovery via web scraping. Channel monitoring on the imported roster would close most of the YouTube gap.

A 100% recall match against manual finding using only public APIs is not realistic. Aiming for 60-70% with the work above is realistic.
