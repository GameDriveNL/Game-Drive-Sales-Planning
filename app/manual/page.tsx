'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from '../components/Sidebar'

// Comprehensive in-app manual. Single page, anchor-linked TOC. Aimed at PR/marketing
// users (not engineers): focused on workflows, not implementation. Keep terse.

interface Section {
  id: string
  title: string
  blocks: Array<
    | { kind: 'p'; text: string }
    | { kind: 'h3'; text: string }
    | { kind: 'list'; items: string[] }
    | { kind: 'steps'; items: string[] }
    | { kind: 'tip'; text: string }
    | { kind: 'warn'; text: string }
  >
}

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'Overview',
    blocks: [
      { kind: 'p', text: 'Game Drive Sales Planning is the tool agency staff use to plan game sales across Steam, PlayStation, Xbox, Nintendo, and Epic, and track press coverage for client games. Most work happens in one of three places: Sales Timeline (planning sales), Analytics (performance + demos), or PR Coverage (press tracking).' },
      { kind: 'h3', text: 'Who uses what' },
      { kind: 'list', items: [
        'Agency staff (you): all features. Plan sales, run reports, manage clients.',
        'Clients (game studios): typically only see their own data via shared reports or read-only views — they do not log in to manage their own products.',
      ]},
      { kind: 'tip', text: 'If you are new, the fastest way to learn is: pick one client → open Sales Timeline → look at one of their games. The interactive Gantt covers ~80% of daily work.' },
    ],
  },
  {
    id: 'getting-around',
    title: 'Getting around',
    blocks: [
      { kind: 'p', text: 'Left sidebar links each major tool. Top-right of most pages has filters (Client / Game / Product). Sign out is at the bottom of the sidebar.' },
      { kind: 'list', items: [
        'Dashboard — high-level client overview',
        'Sales Timeline — the interactive Gantt chart',
        'Analytics — revenue, units, regions, and the Wishlists & Demo sub-page',
        'PR Coverage — incoming press articles, sources, and reports',
        'Reports — assemble client-ready PDF / PPTX reports',
        'Manual — this page',
        'Settings — clients, API keys, users, platforms',
      ]},
    ],
  },
  {
    id: 'sales-timeline',
    title: 'Sales Timeline (Gantt)',
    blocks: [
      { kind: 'p', text: 'The main tool. Each row in the timeline is a (product × platform) lane. Coloured blocks are scheduled sales. Diagonal stripes are cooldown periods (platform rules force gaps between sales).' },

      { kind: 'h3', text: 'Adding a client, game, or product' },
      { kind: 'steps', items: [
        'Click Manage Clients in the toolbar.',
        'Add a Client (the studio you work with).',
        'Add a Game under that client. Steam App ID is optional but required for wishlist/sales syncs to work.',
        'Add Products under that game (Base Game, DLC, Soundtrack, Edition, Demo, Bundle).',
        'When you add a product, check only the platforms it is actually on. This is critical — see "Per-product platforms" below.',
      ]},

      { kind: 'h3', text: 'Per-product platforms' },
      { kind: 'p', text: 'Each product has its own list of platforms it ships on. Set this correctly per product. The timeline will only show rows for platforms you assigned. If you leave it empty for legacy products, the timeline falls back to "show every platform that has historical sales", which can include leftover test data.' },
      { kind: 'warn', text: 'If you see platform rows you do not expect (e.g. Nintendo on a Steam-only game), open the product, check only the correct platforms, save. The unwanted rows disappear on reload.' },

      { kind: 'h3', text: 'Adding sales' },
      { kind: 'list', items: [
        'Click any empty slot on the timeline to open the Add Sale modal.',
        'Or click "+ Add Sale" in the toolbar.',
        'Discount, sale type (custom / seasonal / festival / special), and platform are required.',
        'If the dates overlap a cooldown or a platform event, the modal warns you. You can override if you have permission.',
      ]},

      { kind: 'h3', text: 'Auto-generated sales calendar' },
      { kind: 'p', text: 'When you add a product, the system can auto-generate a 12-month sales plan from the launch date. It picks reasonable platform-specific cadences (Steam summer sale, lunar new year, etc.). Use this as a starting point, then tweak.' },

      { kind: 'h3', text: 'Cooldowns and conflicts' },
      { kind: 'p', text: 'Each platform has a cooldown_days setting (Settings → Platforms). The chart greys-out the cooldown window after every sale. The "Conflicts" stat card at the top shows launch-sale overlaps with platform events (e.g. your launch sale overlaps Steam Summer Sale).' },

      { kind: 'h3', text: 'Versions (committed snapshots)' },
      { kind: 'p', text: 'Click Versions in the toolbar to save the current sales plan as a named snapshot. Useful for "Q1 plan v1", "client-approved version", etc. You can switch between versions to compare. The "working draft" is whatever you are currently editing.' },

      { kind: 'h3', text: 'Import / Export' },
      { kind: 'list', items: [
        'Import CSV — drop a sales CSV (matches the client\'s Excel format).',
        'Export — produces an Excel workbook with the current timeline, suitable for sending to a client.',
      ]},
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    blocks: [
      { kind: 'p', text: 'Performance dashboard for any client. Pick a client and (optionally) a product, region, platform, and date range. Widgets show revenue, units, region breakdown, growth, and a country world map.' },

      { kind: 'h3', text: 'Where the data comes from' },
      { kind: 'list', items: [
        'Steam Financial API — auto-syncs daily once a client\'s publisher key is configured (Settings → Client API Keys).',
        'PlayStation API — similarly automated when a key is set.',
        'CSV import — Settings → Import CSV. Useful for Xbox / Nintendo / Epic, which do not expose APIs.',
      ]},

      { kind: 'h3', text: 'Dashboard Builder (edit mode)' },
      { kind: 'p', text: 'Click "Dashboard Builder" to enter edit mode. Drag widgets around, add new ones, remove the ones you do not use. Click Save Layout to persist. Layout is per-user.' },

      { kind: 'h3', text: 'Wishlists & Demo (sub-page)' },
      { kind: 'p', text: 'Top-right of Analytics → "Wishlists & Demo". Has three tabs: Wishlists, Bundles, Demo. All three are scoped to one game at a time — pick the client and game at the top of the page.' },

      { kind: 'h3', text: 'Wishlists tab' },
      { kind: 'list', items: [
        'Auto-syncs from Steam Partner API when configured.',
        'Sync from Steam API button pulls the last ~90 days. Click again for older data.',
        'Import CSV — drop a Steamworks wishlist export when no API key is available.',
        'Store page live date — when set, the chart anchors its x-axis here. Steam autofills it when you sync wishlists, but you can override manually. Use the Set / Override button next to the date.',
      ]},

      { kind: 'h3', text: 'Demo tab' },
      { kind: 'p', text: 'Shows demo → wishlist conversion for any game that has a product with type "Demo". For each demo: how many people activated it, how many people put the parent game on their wish list during the same window, how much press coverage the game got, and the conversion rate (wishlist adds ÷ activations).' },
      { kind: 'list', items: [
        'Window picker defaults to "demo launch date → game release date (or today if unreleased)". Narrow it for event-specific demos (e.g. one Next Fest week).',
        'Backfill historical activations — until 12 May 2026 the Steam sync threw away demo install counts. Click this button to re-fetch historical data from Steam. Processes 30 dates per click; click again to continue. Activations show up afterwards.',
      ]},
      { kind: 'tip', text: 'For the Demo tab to work, the demo product must exist in the system (Manage Clients → add a product with type Demo on the parent game). Use the demo\'s separate Steam app ID as the Steam Product ID.' },

      { kind: 'h3', text: 'Bundles tab' },
      { kind: 'p', text: 'Steam shows bundle revenue only to the bundle creator. If your client participates in a third-party bundle, you have to import the CSV manually from Steamworks. The page tells you when this applies.' },
    ],
  },
  {
    id: 'pr-coverage',
    title: 'PR Coverage',
    blocks: [
      { kind: 'p', text: 'Automatically discovers and tracks press coverage for client games across RSS feeds, web search, YouTube, Twitch, Reddit, Twitter/X, TikTok, and Instagram. The Feed is your main inbox.' },

      { kind: 'h3', text: 'Feed' },
      { kind: 'p', text: 'Every new piece of press coverage shows up here. Filter by client, game, tier, type. Each item has a relevance score (Gemini AI) and an approval status. Manually approved or auto-approved items count toward client reports.' },

      { kind: 'h3', text: 'Sources' },
      { kind: 'p', text: 'Where coverage gets discovered. Three tabs:' },
      { kind: 'list', items: [
        'RSS — outlet feeds (PC Gamer, IGN, etc.). Add a feed URL, pick a tier.',
        'Tavily — web search across the open web. Costs ~$20-40/month at typical volume.',
        'Apify — YouTube, Twitch, Reddit, Twitter, TikTok, Instagram via one provider. Costs ~$30-65/month.',
      ]},

      { kind: 'h3', text: 'Keywords' },
      { kind: 'p', text: 'Per game, define whitelist keywords (must include) and blacklist keywords (must exclude). When a game gets PR tracking enabled, the system auto-creates a whitelist keyword for the game name. Add common abbreviations and exclude common false-positive terms.' },

      { kind: 'h3', text: 'Dashboard' },
      { kind: 'p', text: 'High-level "how is coverage going" summary. Total pieces, audience reach, sentiment, top outlets, coverage by tier. Useful for client reviews.' },

      { kind: 'h3', text: 'Coverage Reports' },
      { kind: 'p', text: 'The PR-side report builder (separate from the main Reports tab). Generates campaign reports for specific game launches or campaigns.' },
    ],
  },
  {
    id: 'reports',
    title: 'Reports',
    blocks: [
      { kind: 'p', text: 'The main client report builder. Pick a client, optionally a game, choose a date range, and the report assembles four sections automatically: Executive Summary, Sales, PR Coverage, Social.' },

      { kind: 'h3', text: 'Workflow' },
      { kind: 'steps', items: [
        'Pick the client (and optionally one game to scope all sections).',
        'Pick a date range — Last 30 Days, Last Quarter, custom, etc.',
        'Edit the annotations in each section to add context. Annotations save automatically and persist across exports.',
        'Toggle off any sections you do not want in the export.',
        'Click Export PDF or Export PPTX.',
      ]},

      { kind: 'h3', text: 'Sharing' },
      { kind: 'p', text: 'Reports can be shared via a public link (Share button). Anyone with the link sees a read-only version. The link can be revoked at any time.' },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    blocks: [
      { kind: 'h3', text: 'Clients' },
      { kind: 'p', text: 'Add, edit, and disable agency clients. Toggle Sales Planning / PR Tracking per client to control which features apply.' },

      { kind: 'h3', text: 'Client API Keys' },
      { kind: 'p', text: 'Per-client Steam Partner API keys and PlayStation API keys. Without these, the corresponding analytics will not auto-sync. To set up Steam: the client creates a Financial API Key in Steamworks (Manage Groups → Financial API Group), copies it, pastes it here. Same idea for PlayStation.' },
      { kind: 'warn', text: 'A Steam key only works if it was created inside a "Financial API Group" with the relevant apps assigned. If sync returns "403 Forbidden", the client needs to re-issue from the right group.' },

      { kind: 'h3', text: 'System API Keys' },
      { kind: 'p', text: 'Agency-wide keys: Tavily (web search), Google Gemini (AI scoring), Apify (social scrapers), Discord webhooks (notifications). Configure these once, then PR Coverage can run.' },

      { kind: 'h3', text: 'Users & Permissions' },
      { kind: 'p', text: 'Invite teammates, assign roles (superadmin / editor / viewer), and (for non-superadmins) pick which clients they can see. Editors can modify data; viewers only read.' },

      { kind: 'h3', text: 'Platforms' },
      { kind: 'p', text: 'Edit the cooldown days, approval requirements, and discount limits for each platform. These rules drive the cooldown logic in the timeline. Generally set once and rarely changed.' },

      { kind: 'h3', text: 'Product Matching' },
      { kind: 'p', text: 'When CSV imports or API syncs report a product name that does not exist in your database, the system queues it here for resolution. You either confirm "this is my existing product X", "create a new product", or "ignore". Review periodically.' },
    ],
  },
  {
    id: 'common-tasks',
    title: 'Common workflows',
    blocks: [
      { kind: 'h3', text: 'Onboarding a new client' },
      { kind: 'steps', items: [
        'Settings → Clients → Add the client. Toggle on Sales Planning and (if relevant) PR Tracking.',
        'Settings → Client API Keys → Add their Steam / PlayStation key.',
        'Sales Timeline → Manage Clients → Add their games. Use the real Steam App ID.',
        'For each game, add the Base Game product. Check only the platforms the game actually ships on.',
        'Wait for the first auto-sync (or trigger manually) to pull in their existing sales + wishlist data.',
      ]},

      { kind: 'h3', text: 'Building a monthly client report' },
      { kind: 'steps', items: [
        'Reports → pick client → "Last Month" preset.',
        'Skim each section, write an executive summary annotation.',
        'Export PDF, send to the client.',
      ]},

      { kind: 'h3', text: 'Tracking a Next Fest demo' },
      { kind: 'steps', items: [
        'Add a product of type Demo on the game, with the demo\'s Steam app ID and launch date set to the fest start.',
        'Wait a day for the next sales sync.',
        'Click Backfill historical activations on the Demo tab to pull retroactive Steam data.',
        'Open Analytics → Wishlists & Demo → Demo tab → narrow the window to the fest week. The conversion rate is your headline number.',
      ]},

      { kind: 'h3', text: 'Cleaning up unwanted platform rows on the timeline' },
      { kind: 'steps', items: [
        'Open Manage Clients → find the product.',
        'In the Available Platforms section, check only the platforms the product is actually on.',
        'Save. Reload the timeline. Unwanted rows disappear.',
      ]},
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    blocks: [
      { kind: 'h3', text: 'Steam sync returns "403 Forbidden"' },
      { kind: 'p', text: 'The API key is dead, revoked, or was not created from a Financial API Group. The client needs to issue a new key from Steamworks → Manage Groups → Financial API Group (with their app IDs assigned) and paste it into Settings → Client API Keys.' },

      { kind: 'h3', text: 'Steam sync succeeds but no data appears' },
      { kind: 'p', text: 'The key connected but Steam has no financial data to return. Most likely cause: the Financial API Group has no apps assigned. The client needs to add their apps in Steamworks.' },

      { kind: 'h3', text: 'Demo tab shows 0 activations even after a sync' },
      { kind: 'p', text: 'Historical demo activation data is not auto-backfilled. Click "Backfill historical activations" on the Demo tab. The first click pulls 30 of the most recent dates; click again to continue further back.' },

      { kind: 'h3', text: 'Conflict count includes a sale I never created' },
      { kind: 'p', text: 'Auto-generated calendars sometimes create sales on every platform regardless of whether the product ships there. Either delete the bogus sale (Sales Table → find it → delete) or, better, set the product\'s per-product platforms correctly so future generation respects that.' },

      { kind: 'h3', text: 'Login link in invitation email goes to a missing page' },
      { kind: 'p', text: 'Older invites pointed at an invalid URL. Re-send the invite from Settings → Users (the modern invites work).' },
    ],
  },
]

export default function ManualPage() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id)

  // Highlight the current section in the sticky TOC as the user scrolls
  useEffect(() => {
    const obs = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length > 0) setActiveId(visible[0].target.id)
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
    )
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  const card: React.CSSProperties = {
    backgroundColor: 'white',
    borderRadius: '12px',
    padding: '32px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    marginBottom: '16px',
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Sidebar />
      <div style={{ flex: 1, padding: '32px', overflow: 'auto' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', gap: '32px' }}>
          {/* Sticky TOC */}
          <nav style={{
            width: '220px', flexShrink: 0,
            position: 'sticky', top: '32px', alignSelf: 'flex-start',
            backgroundColor: 'white', borderRadius: '12px', padding: '20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            maxHeight: 'calc(100vh - 64px)', overflowY: 'auto',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
              Contents
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {SECTIONS.map(s => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    style={{
                      display: 'block',
                      padding: '6px 10px',
                      fontSize: '13px',
                      color: activeId === s.id ? '#2563eb' : '#475569',
                      backgroundColor: activeId === s.id ? '#eff6ff' : 'transparent',
                      borderRadius: '6px',
                      textDecoration: 'none',
                      fontWeight: activeId === s.id ? 600 : 400,
                      marginBottom: '2px',
                    }}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <header style={{ marginBottom: '24px' }}>
              <h1 style={{ fontSize: '32px', fontWeight: 700, color: '#0f172a', margin: '0 0 6px 0' }}>
                Manual
              </h1>
              <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>
                Everything you need to know to use Game Drive. Skim the contents on the left or scroll through.
              </p>
            </header>

            {SECTIONS.map(section => (
              <section key={section.id} id={section.id} style={card}>
                <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', margin: '0 0 16px 0' }}>
                  {section.title}
                </h2>
                {section.blocks.map((b, i) => {
                  if (b.kind === 'p') {
                    return <p key={i} style={{ fontSize: '14px', lineHeight: 1.6, color: '#334155', margin: '0 0 12px 0' }}>{b.text}</p>
                  }
                  if (b.kind === 'h3') {
                    return <h3 key={i} style={{ fontSize: '16px', fontWeight: 600, color: '#0f172a', margin: '20px 0 8px 0' }}>{b.text}</h3>
                  }
                  if (b.kind === 'list') {
                    return (
                      <ul key={i} style={{ paddingLeft: '20px', margin: '0 0 12px 0' }}>
                        {b.items.map((item, j) => (
                          <li key={j} style={{ fontSize: '14px', lineHeight: 1.6, color: '#334155', margin: '0 0 4px 0' }}>{item}</li>
                        ))}
                      </ul>
                    )
                  }
                  if (b.kind === 'steps') {
                    return (
                      <ol key={i} style={{ paddingLeft: '24px', margin: '0 0 12px 0' }}>
                        {b.items.map((item, j) => (
                          <li key={j} style={{ fontSize: '14px', lineHeight: 1.6, color: '#334155', margin: '0 0 6px 0' }}>{item}</li>
                        ))}
                      </ol>
                    )
                  }
                  if (b.kind === 'tip') {
                    return (
                      <div key={i} style={{
                        padding: '10px 14px',
                        backgroundColor: '#eff6ff',
                        borderLeft: '3px solid #2563eb',
                        borderRadius: '4px',
                        fontSize: '13px',
                        color: '#1e40af',
                        margin: '8px 0 12px 0',
                      }}>
                        <strong>Tip.</strong> {b.text}
                      </div>
                    )
                  }
                  if (b.kind === 'warn') {
                    return (
                      <div key={i} style={{
                        padding: '10px 14px',
                        backgroundColor: '#fef3c7',
                        borderLeft: '3px solid #d97706',
                        borderRadius: '4px',
                        fontSize: '13px',
                        color: '#92400e',
                        margin: '8px 0 12px 0',
                      }}>
                        <strong>Heads up.</strong> {b.text}
                      </div>
                    )
                  }
                  return null
                })}
              </section>
            ))}

            <footer style={{ textAlign: 'center', padding: '24px 0', fontSize: '12px', color: '#94a3b8' }}>
              Something missing or unclear? Tell Josh and it goes in the next revision.
            </footer>
          </div>
        </div>
      </div>
    </div>
  )
}
