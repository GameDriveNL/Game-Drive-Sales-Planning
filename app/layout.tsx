import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import ChatBot from './components/ChatBot'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'GameDrive Sales Planning Tool',
  description: 'Professional game sales planning across Steam, PlayStation, Xbox, Nintendo, and Epic',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
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
