// Hosting classification for agents. Three buckets surface in the UI:
//  - 'pro_droplet'  → Pro · Managed: a dedicated managed VPS we provision
//  - 'external'     → Pro · BYOVPS: Pro running on the subscriber's own server
//                     (a +$10/mo Pro add-on — this is a Pro flavor, NOT a tier below Pro)
//  - anything else  → Standard: runs in-process on the shared backend (local)
// Both 'pro' and 'byovps' are Pro-tier and should read as Pro in the UI; only
// 'standard' is the non-Pro tier and must be visually distinct from them.
export type HostingKind = 'pro' | 'byovps' | 'standard'

export function hostingKind(hosting: string | null | undefined): HostingKind {
  if (hosting === 'pro_droplet') return 'pro'
  if (hosting === 'external') return 'byovps'
  return 'standard'
}

export function isByovps(hosting: string | null | undefined): boolean {
  return hosting === 'external'
}

export const HOSTING_LABEL: Record<HostingKind, string> = {
  pro: 'Pro · Managed',
  byovps: 'Pro · BYOVPS',
  standard: 'Standard',
}
