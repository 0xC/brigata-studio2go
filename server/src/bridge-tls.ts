// Studio<->bridge TLS: cert generation + a cert-pinning HTTP client.
//
// Managed droplets serve the bridge over HTTPS using a self-signed cert that
// STUDIO generates at provision time and bakes into cloud-init. Studio stores
// the exact cert PEM (agents.external_tls_cert) and pins it on every call, so
// there is no trust-on-first-use window: identity is proven by the pinned cert,
// not by a CA chain or hostname (the cert's CN is a fixed label, and we connect
// by raw IP).
//
// Backward-compat: older boxes / BYOVPS run plain HTTP. `bridgeFetch` keys off
// the URL scheme — http:// goes through global fetch untouched, so the existing
// fleet keeps working with no cert and no code change on the box.

import https from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)

// Generate a fresh self-signed RSA cert/key pair via the host `openssl`. CN is a
// fixed label (we pin the cert, so the name is irrelevant). 10-year validity:
// the cert lives and dies with the droplet, and rotation = re-provision.
export async function generateBridgeCert(): Promise<{ cert: string; key: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'brigata-tls-'))
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  try {
    await execFileP('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '3650', '-subj', '/CN=brigata-bridge',
    ])
    const [cert, key] = await Promise.all([
      readFile(certPath, 'utf8'),
      readFile(keyPath, 'utf8'),
    ])
    return { cert, key }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface BridgeResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

export interface BridgeFetchOpts {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  // Pinned cert PEM. Required for https:// targets; ignored for http://.
  certPem?: string | null
}

// fetch-like client that pins `certPem` for https bridges and falls back to the
// global fetch for http bridges. Returns a minimal Response shape (ok / status /
// text / json) that matches how every Studio call site uses the result.
export async function bridgeFetch(url: string, opts: BridgeFetchOpts = {}): Promise<BridgeResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000, certPem } = opts

  if (!url.startsWith('https://')) {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res
  }

  if (!certPem) {
    throw new Error('bridgeFetch: https target requires a pinned certPem')
  }

  return new Promise<BridgeResponse>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers,
        // Pin: trust ONLY this exact self-signed cert. rejectUnauthorized stays
        // on (default) so a different/forged cert is refused; checkServerIdentity
        // is neutered because we connect by IP and the cert CN is a fixed label —
        // the pin, not the hostname, is the identity proof.
        ca: certPem,
        checkServerIdentity: () => undefined,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const status = res.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
          })
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('bridge request timed out')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
