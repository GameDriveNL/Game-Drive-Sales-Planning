import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Product Matching · GD' }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
