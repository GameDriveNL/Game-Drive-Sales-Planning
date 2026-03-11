'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

const NAV_TABS = [
  { label: 'Outlets',         href: '/coverage' },
  { label: 'Keywords',        href: '/coverage/keywords' },
  { label: 'Sources',         href: '/coverage/sources' },
  { label: 'Feed',            href: '/coverage/feed' },
  { label: 'Dashboard',       href: '/coverage/dashboard' },
  { label: 'Timeline',        href: '/coverage/timeline' },
  { label: 'PR Report',       href: '/coverage/report' },
]

const GUIDE_STEPS = [
  {
    number: 1,
    title: 'Access the PR Coverage Tool',
    description: 'Navigate to PR Coverage from the sidebar menu. The coverage feed is your main hub for tracking media mentions.',
    details: [
      'Click "PR Coverage" in the left sidebar to open the coverage feed',
      'The feed shows all discovered articles, reviews, and mentions for your tracked games',
      'Use the Dashboard tab for a high-level overview of coverage metrics',
    ],
  },
  {
    number: 2,
    title: 'Set Up Tracking Keywords',
    description: 'Keywords tell the system what to search for. Add game names, abbreviations, and related terms.',
    details: [
      'Go to PR Coverage > Keywords from the sidebar or coverage navigation',
      'Click "+ Add Keyword" and enter the game name or search term',
      'Link keywords to a specific game and client',
      'Add variations: full game name, abbreviations, common misspellings',
      'Example: "shapez 2", "shapez2", "shapez sequel"',
    ],
  },
  {
    number: 3,
    title: 'Configure Coverage Sources',
    description: 'Sources determine where we look for coverage. There are three discovery methods with different scopes.',
    details: [
      'Go to PR Coverage > Sources to manage all data sources',
      'RSS Feeds: Monitor specific outlets by their RSS feed URL — only finds articles from those outlets (e.g., IGN, PC Gamer, Eurogamer)',
      'Web Search (Tavily): Searches the entire web for matching keywords — discovers coverage from any outlet, even ones you haven\'t added yet',
      'Social/Video (Apify): Monitors YouTube, Twitch, Reddit, Twitter/X, TikTok, Instagram for mentions and content',
      'RSS gives you targeted monitoring of known outlets; Tavily casts a wide net to find unexpected coverage',
      'New outlets found by Tavily or social scanners are auto-created in your Outlets list',
      'Each source can be enabled/disabled independently',
    ],
  },
  {
    number: 4,
    title: 'Understanding the Coverage Feed',
    description: 'The feed shows discovered coverage items with key information at a glance.',
    details: [
      'Each item shows: outlet name, article title, publish date, coverage type',
      'Coverage types: Article, Review, Preview, Video, Stream, Social Post',
      'Outlet tiers (A/B/C/D) indicate the publication\'s reach and authority',
      'Monthly unique visitors show estimated audience size',
      'Filter by game, client, date range, coverage type, or outlet tier',
    ],
  },
  {
    number: 5,
    title: 'Run Manual Scans',
    description: 'While automated scans run on schedule, you can trigger manual scans anytime.',
    details: [
      'Go to Sources and click the scan/refresh button next to any source',
      'RSS scans fetch the latest items from configured feed URLs',
      'Tavily scans run a web search for your active keywords',
      'Apify scans check YouTube, Twitch, Reddit, etc. for recent mentions',
      'New items appear in the feed with AI-generated relevance scores',
    ],
  },
  {
    number: 6,
    title: 'Review and Approve Coverage',
    description: 'Not all discovered items are relevant. Review items and use filtering tools to manage quality.',
    details: [
      'Items start with an AI relevance score (1-100) to help prioritize',
      'Articles flagged as AI-generated show an amber "AI" badge — use the AI Filter dropdown to show/hide them',
      'Approve relevant coverage to include it in client reports',
      'Dismiss false positives or irrelevant mentions',
      'Use bulk actions: select multiple items, then bulk approve, reject, or delete',
      'Edit outlet information or coverage metadata if needed',
    ],
  },
  {
    number: 7,
    title: 'Manage Blacklists & Quality',
    description: 'Control what gets through the scanners with keyword and outlet blacklisting.',
    details: [
      'Keyword Blacklist: Go to Keywords and toggle a keyword to "Blacklist" type — scanners will skip articles containing these terms',
      'Outlet Blacklist: Go to Outlets and click "Block" on any outlet — all scanners will skip coverage from that outlet entirely',
      'Blocked outlets show a red "BLOCKED" label and a count appears in the stats bar',
      'AI Detection: The AI enrichment automatically flags articles that appear to be AI-generated or AI-rewritten',
      'Use the AI Filter on the Feed page to isolate AI-generated content for review',
      'Blacklists apply to all future scans — existing items are not retroactively removed',
    ],
  },
  {
    number: 8,
    title: 'Generate Client Reports',
    description: 'Create professional reports to share with clients showing their media coverage.',
    details: [
      'Go to PR Report to build a new client report',
      'Select a client and date range (typically monthly)',
      'The report automatically pulls approved coverage for that period',
      'Includes: coverage summary, outlet breakdown, individual items with links',
      'Export as PDF for client delivery or Excel for internal analysis',
      'For campaign-specific reports, use the "Simple List" mode for a clean outlet+link list',
    ],
  },
  {
    number: 9,
    title: 'Share Live Coverage Feeds',
    description: 'Give clients a live, always-updated view of their coverage.',
    details: [
      'Go to PR Coverage > Clients to manage public feed links',
      'Each client can have a shareable URL for their coverage feed',
      'The live feed updates automatically as new coverage is discovered',
      'No login required — share the link directly with your client',
      'Clients see approved coverage items only',
    ],
  },
]

export function CoverageNav() {
  const pathname = usePathname()
  const [showHelp, setShowHelp] = useState(false)

  return (
    <>
      <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '2px solid #e2e8f0', alignItems: 'flex-end' }}>
        {NAV_TABS.map(tab => {
          const isActive = tab.href === '/coverage'
            ? pathname === '/coverage'
            : pathname === tab.href
          return isActive ? (
            <div key={tab.href} style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 600,
              color: '#2563eb', borderBottom: '2px solid #2563eb', marginBottom: '-2px'
            }}>
              {tab.label}
            </div>
          ) : (
            <Link key={tab.href} href={tab.href} style={{
              padding: '10px 20px', fontSize: '14px', fontWeight: 500,
              color: '#64748b', textDecoration: 'none', marginBottom: '-2px'
            }}>
              {tab.label}
            </Link>
          )
        })}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingBottom: '8px' }}>
          <button
            onClick={() => setShowHelp(true)}
            style={{
              width: '28px', height: '28px', borderRadius: '50%', border: '1px solid #e2e8f0',
              backgroundColor: 'white', color: '#64748b', fontSize: '14px', fontWeight: 700,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            title="Getting started guide"
          >
            ?
          </button>
        </div>
      </div>

      {showHelp && (
        <div
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
            zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            paddingTop: '60px', paddingBottom: '40px', overflow: 'auto'
          }}
          onClick={() => setShowHelp(false)}
        >
          <div
            style={{
              backgroundColor: 'white', borderRadius: '12px', padding: '32px',
              maxWidth: '680px', width: '100%', margin: '0 16px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '80vh', overflowY: 'auto'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
              <div>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                  PR Coverage Tracker — Getting Started
                </h2>
                <p style={{ fontSize: '13px', color: '#64748b', margin: '4px 0 0' }}>
                  A step-by-step guide to setting up and using the PR Coverage Tracker.
                </p>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                style={{
                  border: 'none', background: 'none', fontSize: '20px',
                  color: '#94a3b8', cursor: 'pointer', padding: '4px 8px', lineHeight: 1
                }}
              >
                &times;
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '24px', padding: '12px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
              {GUIDE_STEPS.map(step => (
                <a
                  key={step.number}
                  href={`#help-step-${step.number}`}
                  onClick={e => {
                    e.preventDefault()
                    document.getElementById(`help-step-${step.number}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }}
                  style={{ fontSize: '12px', color: '#3b82f6', textDecoration: 'none', padding: '4px 8px', borderRadius: '4px', backgroundColor: 'white', border: '1px solid #e2e8f0' }}
                >
                  {step.number}. {step.title}
                </a>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {GUIDE_STEPS.map(step => (
                <div key={step.number} id={`help-step-${step.number}`} style={{ display: 'flex', gap: '16px', padding: '16px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#2563eb',
                    color: 'white', fontSize: '14px', fontWeight: 700, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', flexShrink: 0
                  }}>
                    {step.number}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b', margin: '0 0 4px' }}>{step.title}</h3>
                    <p style={{ fontSize: '13px', color: '#475569', margin: '0 0 8px', lineHeight: 1.5 }}>{step.description}</p>
                    <ul style={{ margin: 0, paddingLeft: '16px', listStyle: 'none' }}>
                      {step.details.map((detail, i) => (
                        <li key={i} style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.6, position: 'relative', paddingLeft: '12px' }}>
                          <span style={{ position: 'absolute', left: 0 }}>&rarr;</span>
                          {detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '24px', padding: '16px', backgroundColor: '#eff6ff', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ fontSize: '13px', color: '#1e40af', margin: 0 }}>
                Need help? Check Settings to verify API keys are configured correctly.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
