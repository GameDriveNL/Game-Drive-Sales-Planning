import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'API Usage' }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
