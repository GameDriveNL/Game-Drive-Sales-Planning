'use client'

import { Sidebar } from '@/app/components/Sidebar'
import styles from './page.module.css'

const steps = [
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
    description: 'Sources determine where we look for coverage. Set up RSS feeds, web search, and social monitoring.',
    details: [
      'Go to PR Coverage > Sources to manage all data sources',
      'RSS Feeds: Add publication RSS URLs for automated monitoring (e.g., IGN, PC Gamer)',
      'Web Search (Tavily): Enabled globally — searches the web for matching keywords',
      'Social/Video (Apify): Monitors YouTube, Twitch, Reddit, Twitter/X for mentions',
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
    description: 'Not all discovered items are relevant. Review items and mark them as approved or dismissed.',
    details: [
      'Items start with an AI relevance score (1-100) to help prioritize',
      'Click an item to see full details and the original article link',
      'Approve relevant coverage to include it in client reports',
      'Dismiss false positives or irrelevant mentions',
      'Edit outlet information or coverage metadata if needed',
    ],
  },
  {
    number: 7,
    title: 'Generate Client Reports',
    description: 'Create professional reports to share with clients showing their media coverage.',
    details: [
      'Go to Reports to build a new client report',
      'Select a client and date range (typically monthly)',
      'The report automatically pulls approved coverage for that period',
      'Includes: coverage summary, outlet breakdown, individual items with links',
      'Export as PDF for client delivery or Excel for internal analysis',
      'For campaign-specific reports, use the "Campaign Report" type for a clean outlet+link list',
    ],
  },
  {
    number: 8,
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

export default function CoverageGuidePage() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div className={styles.container}>
          <div className={styles.header}>
            <h1 className={styles.title}>PR Coverage Tracker — Getting Started</h1>
            <p className={styles.subtitle}>
              A step-by-step guide to setting up and using the PR Coverage Tracker for media monitoring and client reporting.
            </p>
          </div>

          <div className={styles.quickNav}>
            <strong className={styles.quickNavTitle}>Quick Navigation</strong>
            <div className={styles.quickNavLinks}>
              {steps.map(step => (
                <a key={step.number} href={`#step-${step.number}`} className={styles.quickNavLink}>
                  {step.number}. {step.title}
                </a>
              ))}
            </div>
          </div>

          <div className={styles.stepList}>
            {steps.map(step => (
              <div key={step.number} id={`step-${step.number}`} className={styles.stepCard}>
                <div className={styles.stepNumber}>{step.number}</div>
                <div className={styles.stepContent}>
                  <h2 className={styles.stepTitle}>{step.title}</h2>
                  <p className={styles.stepDescription}>{step.description}</p>
                  <ul className={styles.detailList}>
                    {step.details.map((detail, i) => (
                      <li key={i} className={styles.detailItem}>{detail}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            <h3 className={styles.footerTitle}>Need Help?</h3>
            <p className={styles.footerText}>
              Contact your admin or check the settings page to verify API keys are configured correctly.
              The system requires Tavily (web search), Google AI (relevance scoring), and Apify (social monitoring) API keys.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
