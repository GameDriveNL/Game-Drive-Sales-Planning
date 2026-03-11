'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function CoverageClientsRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/settings/clients')
  }, [router])

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#64748b', fontSize: '14px' }}>
      Redirecting to Settings &rarr; Clients...
    </div>
  )
}
