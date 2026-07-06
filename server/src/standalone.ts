// Standalone / self-host mode. When STANDALONE_MODE is set, Brigata Studio runs
// as a single-tenant, self-hosted install: no Google OAuth, no Stripe billing,
// no Pro-tier VPS provisioning. A single admin logs in with a shared password
// and gets one entitled workspace with one Standard (in-process/SDK) agent.
//
// EVERYTHING here is INERT unless STANDALONE_MODE is truthy. With the flag unset
// the server behaves byte-identically to the multi-tenant cloud build — every
// call site guards on isStandalone() before diverging. The flag is read fresh
// each call so the operator flips it via .env + restart, no code change.

// True only when STANDALONE_MODE is explicitly turned on. Modeled on
// isDemoEnabled() in demo.ts.
export function isStandalone(): boolean {
  const flag = (process.env.STANDALONE_MODE || '').toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes'
}

// Cookie domain for the session cookie in standalone mode. Returns
// SESSION_COOKIE_DOMAIN if the operator set one (e.g. a custom hostname), or
// undefined so the cookie is host-only (the correct default for localhost).
// Only used to replace the hardcoded '.brigata.ai' domain on the standalone
// login path; the cloud path is untouched.
export function sessionCookieDomain(): string | undefined {
  const d = process.env.SESSION_COOKIE_DOMAIN
  return d && d.trim() ? d.trim() : undefined
}

// The single synthetic admin identity used in standalone mode. The standalone
// login upserts this user; the first-boot seed provisions its workspace.
export const STANDALONE_ADMIN_GOOGLE_SUB = 'standalone-admin'
export const STANDALONE_ADMIN_EMAIL = 'admin@localhost'
export const STANDALONE_ADMIN_NAME = 'Admin'
