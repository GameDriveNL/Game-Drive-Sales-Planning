# Steam API Capabilities — What's Possible vs Not

> Reference document for GameDrive team (Stephanie, Alisa). Created for Issue #91.

## Summary

| Capability | Available? | Source | Notes |
|-----------|-----------|--------|-------|
| Sales data (units, revenue) | Yes | Partner API | Already integrated, auto-syncs daily |
| Country/region breakdown | Yes | Partner API | Per-country revenue and units |
| Platform breakdown (Win/Mac/Linux) | Yes | Partner API | Included in sales data |
| Pricing/discount info | Yes | Partner API | Base price, sale price, discount % |
| Concurrent Users (CCU) | Yes | Public API | Can be added (not yet built) |
| Store page traffic | No | Neither API | Only visible in Steamworks dashboard |
| Wishlist data | Yes | Partner API | `GetAppWishlistReporting` — totals, adds, deletes, purchases, gifts |
| Reviews/ratings | Partial | Store API | Public aggregate data only |

## What's Already Built

### Partner API Integration (requires Financial Web API Key)

Our system uses `IPartnerFinancialsService` with three endpoints:

1. **`GetChangedDatesForPartner`** — Identifies which dates have new/updated data (incremental sync)
2. **`GetDetailedSales`** — Fetches per-day, per-product, per-country financial data
3. **`GetAppWishlistReporting`** — Fetches daily wishlist totals, adds, deletes, purchases, gifts (per-app)

**Data returned per row:**
- Date, App ID, App Name, Package ID
- Platform (Windows, Mac, Linux)
- Country code + country name + region
- Gross units sold, units returned, net units sold
- Base price, sale price, currency
- Gross revenue (USD), returns (USD), VAT/tax (USD), net revenue (USD)
- Discount percentage, line item type (game, DLC, bundle)

**Sync features:**
- Automatic daily sync (configurable 1-168 hour frequency)
- Incremental via highwatermark (only fetches new data)
- Manual sync trigger from Settings page
- CSV import fallback for clients without API keys

### CSV Import (no API key needed)

Clients can upload Steam financial CSV exports directly. The importer handles:
- Standard Steam financial export format
- Multi-platform data (Steam, PlayStation via separate import)
- Duplicate detection and deduplication
- Date range validation

## What's NOT Available via Any Steam API

### Store Page Traffic
Steam does **not** expose store page visit data through any API — public or partner. This data is only visible by logging into the Steamworks dashboard directly.

**Alternatives:**
- Manual data entry: GameDrive team can input traffic numbers from Steamworks dashboard
- Screenshot-based tracking: Periodic screenshots of Steamworks traffic graphs
- SteamDB (steamdb.info): Shows some estimated traffic/player data publicly

### Wishlist Data
Wishlist data **is** available via the Partner API using `IPartnerFinancialsService/GetAppWishlistReporting/v001`. This endpoint provides:
- **Overall totals** per date: total wishlists, additions, deletions, purchases & activations, gifts
- **Country-level breakdown**: wishlists by country
- **Language-level breakdown**: wishlists by language

Uses the same Financial Web API Key as sales data. Data is updated within a few hours of user activity.

Our system auto-syncs wishlist data via `/api/cron/steam-wishlist-sync`.

### Detailed Review Text
Individual review text is not available via the Partner API. The public Store API (`store.steampowered.com/api/appdetails`) provides aggregate review scores but not individual review content.

## Possible Future Enhancement: CCU Tracking

The **public** Steam Web API provides concurrent user counts for free:

```
GET https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={APP_ID}
```

This returns the current number of players in-game. Could be used to:
- Track player count over time (periodic polling)
- Correlate CCU spikes with sales/events
- Show CCU on the analytics dashboard

**Cost:** Free (no API key required for basic CCU endpoint)
**Effort:** Low — add a cron job to poll every 15-30 minutes, store in a new table

## API Key Requirements

| API | Key Source | Cost |
|-----|----------|------|
| Partner API (financial data) | Steamworks > Users & Permissions > Manage Groups > Financial API Key | Free |
| Public API (CCU, app details) | https://steamcommunity.com/dev/apikey | Free |

The Partner API key (Financial Web API Key) is what GameDrive clients need to provide. Each client provides their own key from their Steamworks publisher account.
