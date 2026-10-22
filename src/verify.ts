import type { VerifySpec } from './config.ts'

export type VerifyResult =
  | { status: 'match' }
  | { status: 'mismatch'; actual: string }
  | { status: 'unreported' }
  | { status: 'unreachable'; reason: string }

export interface VerifyOptions {
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: unknown }).cause
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message
}

/** GET `spec.url` and check that JSON field `spec.field` equals `spec.expect`. Never throws. */
export async function verifyIdentity(spec: VerifySpec, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const doFetch = opts.fetch ?? globalThis.fetch
  let res: Response
  try {
    res = await doFetch(spec.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2000) })
  } catch (err) {
    return { status: 'unreachable', reason: describe(err) }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { status: 'unreported' }
  }
  const actual = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[spec.field] : undefined
  if (typeof actual !== 'string') return { status: 'unreported' }
  return actual === spec.expect ? { status: 'match' } : { status: 'mismatch', actual }
}
