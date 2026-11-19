/**
 * Signed webhook URLs.
 *
 * Apify calls /api/sullygnome-collect when a run finishes, with no session.
 * Without a check, anyone who knew a source_id could feed rows into coverage.
 * The URL we register now carries `sig`, an HMAC of the source id keyed with
 * CRON_SECRET. The secret itself never appears in a URL.
 */
import { createHmac, timingSafeEqual } from 'crypto'

function sign(sourceId: string): string | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return null
  return createHmac('sha256', secret).update(`sullygnome-collect:${sourceId}`).digest('hex')
}

/** Builds the webhook URL Apify should call for a source. */
export function signedCollectUrl(baseUrl: string, sourceId: string): string {
  const sig = sign(sourceId)
  const url = `${baseUrl}/api/sullygnome-collect?source_id=${encodeURIComponent(sourceId)}`
  return sig ? `${url}&sig=${sig}` : url
}

/** True when `sig` is the valid signature for this source id. Fails closed. */
export function verifyCollectSig(sourceId: string, sig: string | null): boolean {
  const expected = sign(sourceId)
  if (!expected || !sig) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Apify dataset ids are short alphanumeric strings. Reject anything else. */
export function isValidDatasetId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9]{8,40}$/.test(id)
}
