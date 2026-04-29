'use client'

import { Suspense, useEffect, useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter, useSearchParams } from 'next/navigation'

function ResetPasswordInner() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(true)
  const [ready, setReady] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClientComponentClient()

  // Supabase recovery emails can deliver the token in two forms:
  //   1. New: `?token_hash=...&type=recovery` (verifyOtp)
  //   2. Legacy: `#access_token=...&refresh_token=...&type=recovery` (hash fragment)
  // We support both so older email templates still work.
  useEffect(() => {
    async function establishSession() {
      const tokenHash = searchParams.get('token_hash')
      const type = searchParams.get('type')

      if (tokenHash && type === 'recovery') {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: 'recovery',
        })
        if (error) {
          setError('This reset link is invalid or has expired. Request a new one from the sign-in page.')
          setVerifying(false)
          return
        }
        setReady(true)
        setVerifying(false)
        return
      }

      // Fallback: legacy hash fragment flow. Supabase auto-detects on load,
      // so we just need to confirm a session was established.
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        setReady(true)
      } else {
        setError('No reset session found. Open the password reset link from your email again.')
      }
      setVerifying(false)
    }

    establishSession()
  }, [searchParams, supabase])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    setInfo('Password updated. Redirecting to your dashboard...')
    setTimeout(() => {
      router.push('/')
      router.refresh()
    }, 800)
  }

  if (verifying) {
    return (
      <Centered>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Verifying reset link...</p>
      </Centered>
    )
  }

  if (!ready) {
    return (
      <Centered>
        <Card>
          <Badge color="var(--color-danger)">!</Badge>
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 8px 0' }}>
            Reset link unavailable
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', margin: 0 }}>
            {error}
          </p>
          <a
            href="/login"
            style={{
              display: 'inline-block', marginTop: '20px', fontSize: '13px',
              color: 'var(--color-primary)', textDecoration: 'underline',
            }}
          >
            Back to sign in
          </a>
        </Card>
      </Centered>
    )
  }

  return (
    <Centered>
      <Card>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <Badge color="var(--color-primary)">GD</Badge>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 4px 0' }}>
            Choose a new password
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', margin: 0 }}>
            Pick something at least 6 characters long.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <Field label="New password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              placeholder="At least 6 characters"
              style={inputStyle}
            />
          </Field>

          <Field label="Confirm new password" last>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              placeholder="Re-enter your password"
              style={inputStyle}
            />
          </Field>

          {error && (
            <div style={{
              padding: '10px 12px', marginBottom: '16px', fontSize: '13px',
              color: 'var(--color-danger)', background: '#fef2f2',
              border: '1px solid #fecaca', borderRadius: 'var(--radius-md)',
            }}>{error}</div>
          )}

          {info && (
            <div style={{
              padding: '10px 12px', marginBottom: '16px', fontSize: '13px',
              color: '#065f46', background: '#ecfdf5',
              border: '1px solid #a7f3d0', borderRadius: 'var(--radius-md)',
            }}>{info}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '11px 16px', fontSize: '14px', fontWeight: 600,
              color: '#fff',
              background: loading ? 'var(--color-text-light)' : 'var(--color-primary)',
              border: 'none', borderRadius: 'var(--radius-md)',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'var(--transition)',
            }}
          >
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </Card>
    </Centered>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', fontSize: '14px',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
  outline: 'none', background: 'var(--color-bg)', color: 'var(--color-text)',
  boxSizing: 'border-box',
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #2d1b3d 50%, #1a1a2e 100%)',
      fontFamily: 'Inter, sans-serif',
    }}>
      {children}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', maxWidth: '400px', padding: '40px',
      background: 'var(--color-surface)', borderRadius: '12px',
      boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
      border: '1px solid rgba(210, 41, 57, 0.1)',
      textAlign: 'center',
    }}>
      {children}
    </div>
  )
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '48px', height: '48px', borderRadius: 'var(--radius-md)',
      background: color, color: '#fff', fontSize: '18px', fontWeight: 700,
      marginBottom: '16px',
    }}>{children}</div>
  )
}

function Field({ label, last, children }: { label: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: last ? '24px' : '16px', textAlign: 'left' }}>
      <label style={{
        display: 'block', fontSize: '13px', fontWeight: 500,
        color: 'var(--color-text)', marginBottom: '6px',
      }}>{label}</label>
      {children}
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  )
}
