'use client'

import { useEffect, useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import styles from '../../login/login.module.css'

type Step = 'loading' | 'challenge' | 'enroll'

interface Enrollment {
  factorId: string
  qrCode: string
  secret: string
}

export default function MfaPage() {
  const supabase = createClientComponentClient()
  const [step, setStep] = useState<Step>('loading')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      if (!sessionData.session) {
        window.location.replace('/login')
        return
      }

      const { data: aal, error: aalError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aalError || !aal) {
        if (!cancelled) setError(aalError?.message ?? 'Could not check your sign-in level.')
        return
      }
      if (aal.currentLevel === 'aal2') {
        window.location.replace('/')
        return
      }

      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        if (!cancelled) setError(factorsError.message)
        return
      }

      const verified = factors.totp[0]
      if (verified) {
        if (cancelled) return
        setFactorId(verified.id)
        setStep('challenge')
        return
      }

      // No verified factor yet. Clear half-finished setups from an earlier
      // attempt, then start a fresh enrollment.
      const leftovers = (factors.all ?? []).filter(
        (f) => f.factor_type === 'totp' && f.status === 'unverified'
      )
      for (const f of leftovers) {
        await supabase.auth.mfa.unenroll({ factorId: f.id })
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      })
      if (enrollError || !enrolled) {
        if (!cancelled) setError(enrollError?.message ?? 'Could not start two-factor setup.')
        return
      }
      if (cancelled) return
      setEnrollment({
        factorId: enrolled.id,
        qrCode: enrolled.totp.qr_code,
        secret: enrolled.totp.secret,
      })
      setFactorId(enrolled.id)
      setStep('enroll')
    }

    start().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong.')
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setError(null)

    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.replace(/\s/g, ''),
    })

    if (verifyError) {
      setError(
        verifyError.message.toLowerCase().includes('invalid')
          ? 'That code is not right. Check the code in your app and try again.'
          : verifyError.message
      )
      setCode('')
      setBusy(false)
      return
    }

    // Full navigation so the upgraded session cookie is sent with the request.
    window.location.assign('/')
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.assign('/login')
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.header}>
          <img src="/images/GD_RGB.png" alt="Game Drive" className={styles.logo} />
          <h1 className={styles.title}>Game Drive</h1>
          <p className={styles.subtitle}>
            {step === 'enroll'
              ? 'Set up two-factor authentication'
              : step === 'challenge'
                ? 'Enter your verification code'
                : 'Checking your account'}
          </p>
        </div>

        {step === 'loading' && !error && (
          <p style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '14px' }}>
            Loading...
          </p>
        )}

        {step === 'enroll' && enrollment && (
          <div style={{ marginBottom: '16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
            <p style={{ marginBottom: '12px' }}>
              Your account needs a second sign-in step. Open your authenticator app (Google
              Authenticator, 1Password, Authy), choose to add an account, and scan this code from
              inside that app. Then enter the 6 digit code it shows.
            </p>
            <p style={{ marginBottom: '12px' }}>
              Do not scan it with your phone&apos;s camera app. That offers to save it in your
              password manager instead. If scanning does not work, use the key below.
            </p>
            <div style={{ textAlign: 'center', marginBottom: '12px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qrCode}
                alt="Two-factor QR code"
                width={180}
                height={180}
                style={{ background: '#fff', padding: '8px', borderRadius: '8px' }}
              />
            </div>
            <p style={{ marginBottom: '4px' }}>
              Cannot scan? In Google Authenticator tap + then &quot;Enter a setup key&quot;, and
              paste this key (account name and type &quot;Time based&quot;):
            </p>
            <code
              style={{
                display: 'block',
                wordBreak: 'break-all',
                padding: '8px',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                userSelect: 'all',
              }}
            >
              {enrollment.secret}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(enrollment.secret)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                } catch {
                  /* clipboard blocked: the key above is selectable */
                }
              }}
              style={{
                marginTop: '8px',
                padding: '4px 12px',
                fontSize: '13px',
                color: 'var(--color-text)',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <p style={{ marginTop: '12px' }}>
              If you ever lose access to your app, a Game Drive superadmin can reset it for you.
            </p>
          </div>
        )}

        {(step === 'enroll' || step === 'challenge') && (
          <form onSubmit={handleVerify}>
            <div className={styles.fieldGroupLast}>
              <label className={styles.label}>6 digit code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                placeholder="123456"
                className={styles.input}
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="submit"
              disabled={busy || code.replace(/\s/g, '').length < 6}
              className={styles.submitButton}
            >
              {busy ? 'Verifying...' : step === 'enroll' ? 'Turn on two-factor' : 'Verify'}
            </button>
          </form>
        )}

        {step === 'loading' && error && <div className={styles.error}>{error}</div>}

        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button
            type="button"
            onClick={handleSignOut}
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
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
