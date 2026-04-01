import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import ChatBot from './components/ChatBot'

// Force all pages to render dynamically — every page needs Supabase auth
export const dynamic = 'force-dynamic'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Game Drive — Sales Planning & PR Coverage',
  description: 'Game Drive: Professional game sales planning and PR coverage tracking across Steam, PlayStation, Xbox, Nintendo, and Epic',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/images/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/images/favicon-64.png" sizes="64x64" type="image/png" />
        <link rel="icon" href="/images/favicon-192.png" sizes="192x192" type="image/png" />
        <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
      </head>
      <body className={inter.className}>
        <Providers>
          {children}
          <ChatBot />
        </Providers>
      </body>
    </html>
  )
}
