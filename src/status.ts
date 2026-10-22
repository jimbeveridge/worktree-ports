import { connect } from 'node:net'
import type { ResolvedPorts } from './resolve.ts'
import { verifyIdentity, type VerifyOptions } from './verify.ts'

export type Owner = 'mine' | 'other' | 'unknown'

export interface ServiceStatus {
  service: string
  port: number
  /** Something accepted a TCP connection on 127.0.0.1 or ::1. */
  listening: boolean
  /**
   * Who the listener belongs to. Present only for the service that `verify.url` points at,
   * and only while it is listening. Other services cannot be attributed.
   */
  owner?: Owner
  /** The worktree root the service reported (owner `mine` or `other`). */
  ownerRoot?: string
}

/** Dev servers bound to `localhost` may listen on only one of these, so probe both. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const

/** True when something accepts a TCP connection on `host:port`. Never throws. */
export function probe(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function isListening(port: number, timeoutMs?: number): Promise<boolean> {
  const results = await Promise.all(LOOPBACK_HOSTS.map((host) => probe(port, host, timeoutMs)))
  return results.some(Boolean)
}

function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number(parsed.port)
    if (parsed.protocol === 'http:') return 80
    if (parsed.protocol === 'https:') return 443
    return undefined
  } catch {
    return undefined
  }
}

export interface StatusOptions {
  probeTimeoutMs?: number
  verify?: VerifyOptions
}

/**
 * Report, for every resolved service port, whether it is listening and (for the verify target) whose it is.
 * Reads only `ports` and `verify` (whose `expect` is already rendered against `root`).
 */
export async function serviceStatus(
  resolved: Pick<ResolvedPorts, 'ports' | 'verify'>,
  opts: StatusOptions = {},
): Promise<ServiceStatus[]> {
  const spec = resolved.verify
  const verifyPort = spec ? portOf(spec.url) : undefined
  return Promise.all(
    Object.entries(resolved.ports).map(async ([service, port]): Promise<ServiceStatus> => {
      const listening = await isListening(port, opts.probeTimeoutMs)
      const status: ServiceStatus = { service, port, listening }
      if (listening && spec && port === verifyPort) {
        const result = await verifyIdentity(spec, opts.verify)
        if (result.status === 'match') {
          status.owner = 'mine'
          status.ownerRoot = spec.expect
        } else if (result.status === 'mismatch') {
          status.owner = 'other'
          status.ownerRoot = result.actual
        } else {
          status.owner = 'unknown'
        }
      }
      return status
    }),
  )
}
