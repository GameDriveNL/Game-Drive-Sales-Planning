'use client'

import { useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter } from 'next/navigation'
import styles from './login.module.css'

type Mode = 'signin' | 'forgot'

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClientComponentClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)

    const redirectTo = `${window.location.origin}/auth/reset`
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    })

    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setInfo(
        "If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder)."
      )
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setInfo(null)
    setPassword('')
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.header}>
          <img src="/images/GD_RGB.png" alt="Game Drive" className={styles.logo} />
          <h1 className={styles.title}>Game Drive</h1>
          <p className={styles.subtitle}>
            {mode === 'signin' ? 'Sign in to your account' : 'Reset your password'}
          </p>
        </div>

        {mode === 'signin' ? (
          <form onSubmit={handleLogin}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@gamedrive.com"
                className={styles.input}
              />
            </div>

            <div className={styles.fieldGroupLast}>
              <label className={styles.label}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Enter your password"
                className={styles.input}
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="submit"
              disabled={loading}
              className={styles.submitButton}
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>

            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-muted)',
                  fontSize: '13px',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Forgot password?
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleForgot}>
            <div className={styles.fieldGroupLast}>
              <label className={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@gamedrive.com"
                className={styles.input}
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}
            {info && (
              <div
                style={{
                  padding: '10px 12px',
                  marginBottom: '16px',
                  fontSize: '13px',
                  color: '#065f46',
                  background: '#ecfdf5',
                  border: '1px solid #a7f3d0',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {info}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className={styles.submitButton}
            >
              {loading ? 'Sending...' : 'Send reset link'}
            </button>

            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => switchMode('signin')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-muted)',
                  fontSize: '13px',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Back to sign in
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
