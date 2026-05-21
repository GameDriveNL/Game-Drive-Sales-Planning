'use client';

import { useEffect } from 'react';

/**
 * Root error boundary — catches client-side exceptions on every route that
 * doesn't have its own error.tsx. Prevents a single bad date / undefined ref /
 * etc. from showing a blank white page (B15).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Page error:', error);
  }, [error]);

  return (
    <div style={{ padding: '32px', maxWidth: '720px', margin: '0 auto', fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#ef4444', marginBottom: 8 }}>Something went wrong</h2>
      <p style={{ color: '#475569', marginBottom: 24 }}>
        The page encountered an unexpected error. Your data is safe — this is just a display issue.
        If this keeps happening, try refreshing or click below to retry.
      </p>
      <button
        onClick={reset}
        style={{
          marginRight: 12,
          padding: '10px 20px',
          background: '#d22939',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        Try again
      </button>
      <button
        onClick={() => (window.location.href = '/dashboard')}
        style={{
          padding: '10px 20px',
          background: 'white',
          color: '#475569',
          border: '1px solid #cbd5e1',
          borderRadius: '6px',
          cursor: 'pointer',
        }}
      >
        Go to Dashboard
      </button>
      <details style={{ marginTop: 32 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#64748b' }}>
          Technical details
        </summary>
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            overflow: 'auto',
            fontSize: 12,
            maxHeight: 240,
          }}
        >
          {error.message}
          {'\n\n'}
          {error.stack}
        </pre>
      </details>
    </div>
  );
}
