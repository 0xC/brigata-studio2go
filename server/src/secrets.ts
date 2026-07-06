// Encryption-at-rest for integration secrets (Discord bot tokens, Matrix access
// tokens, ...). These live in the integrations.config JSONB and were previously
// stored plaintext. A Matrix access token grants full account access, so we
// encrypt before persisting.
//
// Key: INTEGRATION_SECRET_KEY env var, a 32-byte key as hex (64 chars) or base64.
// Rollout is non-breaking: when the key is unset we store plaintext (today's
// behavior) and decrypt() passes plaintext through; legacy plaintext values
// already in the DB decrypt to themselves and get encrypted on their next write.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'enc:v1:'

function getKey(): Buffer | null {
  const raw = process.env.INTEGRATION_SECRET_KEY
  if (!raw) return null
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('INTEGRATION_SECRET_KEY must decode to 32 bytes (hex or base64)')
  }
  return key
}

export function secretsKeyConfigured(): boolean {
  return !!process.env.INTEGRATION_SECRET_KEY
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

// Encrypt a plaintext secret for storage. With no key configured, returns the
// plaintext unchanged so the integration still works (caller may warn).
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  if (!key) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

// Decrypt a stored secret. Legacy plaintext (no enc: prefix) passes through.
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value
  const key = getKey()
  if (!key) {
    throw new Error('INTEGRATION_SECRET_KEY is not set but an encrypted secret was found')
  }
  const parts = value.split(':')
  // enc:v1:<iv>:<tag>:<ct> — base64 segments never contain ':'
  const [, , ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
