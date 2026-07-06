// The "expected" bridge revision = the BRIDGE_REV baked into the canonical bridge
// source that /api/bridge-tarball ships. We read it from the same file the tarball
// is built from, so a deployed bridge whose /health rev differs is, by definition,
// running stale code (update_available). Cached briefly so the agent endpoints can
// call this per-request without re-reading the file each time.
import { promises as fs } from 'node:fs'

const BRIDGE_SOURCE = process.env.BRIDGE_SOURCE_PATH
  ?? '/home/brigata/brigata-workspace/bridge/index.ts'
const TTL_MS = 60_000

let cache: { rev: string | null; at: number } = { rev: null, at: 0 }

export async function getExpectedBridgeRev(): Promise<string | null> {
  if (cache.rev !== null && Date.now() - cache.at < TTL_MS) return cache.rev
  try {
    const src = await fs.readFile(BRIDGE_SOURCE, 'utf8')
    const m = src.match(/BRIDGE_REV\s*=\s*['"]([^'"]+)['"]/)
    cache = { rev: m ? m[1] : null, at: Date.now() }
  } catch {
    // Keep whatever we last read; just refresh the timestamp so we retry later.
    cache = { rev: cache.rev, at: Date.now() }
  }
  return cache.rev
}
