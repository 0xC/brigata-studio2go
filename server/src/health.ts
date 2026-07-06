// Host + process health for the shared backend, distilled into a single "story"
// an admin can read at a glance. Standard agents run in-process on this box, so
// the binding constraint is memory (no graceful degradation past RAM — the OOM
// killer takes the whole server). This module surfaces the leading indicators —
// free RAM, swap-in-use, event-loop lag, concurrent turns — so we scale up
// BEFORE a crash, not after.
import { readFile } from 'node:fs/promises'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { db } from './db.js'
import { turnConcurrency } from './activity.js'

// Event-loop delay histogram, enabled once at module load so it's always
// sampling. Reset on its OWN fixed cadence (not on read) so every reader —
// the 5s dashboard poll AND the 60s alert poller — sees a consistent rolling
// window. Resetting inside collectHealth would let one reader blank the other's
// data, making lag readings depend on who polled last.
const ELD_WINDOW_MS = 60_000
const eld = monitorEventLoopDelay({ resolution: 20 })
eld.enable()
setInterval(() => eld.reset(), ELD_WINDOW_MS).unref()

export type HealthLevel = 'ok' | 'warn' | 'critical'

// Running high-water marks (as gauge percentages) since process boot. Updated on
// every collectHealth call — the 5s dashboard poll AND the 60s alert poller both
// feed it, so a spike is captured even when no admin is watching. Same lifetime
// as turns.peak: resets on restart. The dashboard draws these as a vertical line
// across each meter.
const peaks: Record<string, number> = {
  memory: 0, swap: 0, disk: 0, cpu: 0, event_loop: 0,
}
function bumpPeak(key: string, pct: number): number {
  const v = Number.isFinite(pct) ? pct : 0
  if (v > peaks[key]) peaks[key] = v
  return Math.round(peaks[key] * 10) / 10
}

interface Metric {
  level: HealthLevel
  // Human sentence fragment used to build the headline story.
  note: string
}

const LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, critical: 2 }
function worst(...levels: HealthLevel[]): HealthLevel {
  return levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'ok')
}

function band(value: number, warnAt: number, critAt: number): HealthLevel {
  if (value >= critAt) return 'critical'
  if (value >= warnAt) return 'warn'
  return 'ok'
}

async function readMeminfo(): Promise<Record<string, number>> {
  // Values are in kB. Linux-only; callers fall back to os.* if this throws.
  const txt = await readFile('/proc/meminfo', 'utf8')
  const out: Record<string, number> = {}
  for (const line of txt.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/)
    if (m) out[m[1]] = Number(m[2]) * 1024 // -> bytes
  }
  return out
}

export interface HealthSnapshot {
  level: HealthLevel
  headline: string
  generated_at: string
  uptime_seconds: number
  memory: {
    total_mb: number
    available_mb: number
    used_pct: number
    process_rss_mb: number
    level: HealthLevel
    peak_pct: number
  }
  swap: {
    total_mb: number
    used_mb: number
    level: HealthLevel
    peak_pct: number
  }
  disk: {
    total_gb: number
    free_gb: number
    used_pct: number
    level: HealthLevel
    peak_pct: number
  }
  cpu: {
    cores: number
    load1: number
    load5: number
    load15: number
    load_per_core: number
    level: HealthLevel
    peak_pct: number
  }
  event_loop: {
    mean_ms: number
    p99_ms: number
    level: HealthLevel
    peak_pct: number
  }
  turns: {
    current: number
    peak: number
  }
  db: {
    online: boolean
    size: string | null
  }
}

export async function collectHealth(): Promise<HealthSnapshot> {
  const metrics: Metric[] = []

  // ---- Memory ----
  let memTotal: number, memAvail: number, swapTotal: number, swapUsed: number
  try {
    const mi = await readMeminfo()
    memTotal = mi.MemTotal
    memAvail = mi.MemAvailable
    swapTotal = mi.SwapTotal ?? 0
    swapUsed = (mi.SwapTotal ?? 0) - (mi.SwapFree ?? 0)
  } catch {
    memTotal = os.totalmem()
    memAvail = os.freemem() // coarser than MemAvailable but a safe fallback
    swapTotal = 0
    swapUsed = 0
  }
  const memUsedPct = memTotal > 0 ? ((memTotal - memAvail) / memTotal) * 100 : 0
  const availMb = memAvail / 1024 / 1024
  // Free-RAM thresholds: warn under 800MB, critical under 350MB. On a 4GB box
  // these map to roughly the "scale soon" and "scale now / OOM risk" lines.
  const memLevel = availMb < 350 ? 'critical' : availMb < 800 ? 'warn' : 'ok'
  metrics.push({
    level: memLevel,
    note: memLevel === 'ok'
      ? `${Math.round(availMb)} MB RAM free`
      : `only ${Math.round(availMb)} MB RAM free`,
  })

  // ---- Swap (any sustained swap use = we're past RAM) ----
  const swapUsedMb = swapUsed / 1024 / 1024
  const swapLevel: HealthLevel = swapTotal === 0
    ? (memLevel === 'critical' ? 'critical' : 'warn') // no swap cushion at all
    : band(swapUsedMb, 128, 768)
  if (swapTotal === 0) {
    metrics.push({ level: swapLevel, note: 'no swap configured (OOM = hard crash)' })
  } else if (swapUsedMb >= 128) {
    metrics.push({ level: swapLevel, note: `${Math.round(swapUsedMb)} MB swap in use` })
  }

  // ---- Disk ----
  let diskTotalGb = 0, diskFreeGb = 0, diskUsedPct = 0
  let diskLevel: HealthLevel = 'ok'
  try {
    const fs = await statfs('/')
    const total = fs.blocks * fs.bsize
    const free = fs.bfree * fs.bsize
    diskTotalGb = total / 1024 ** 3
    diskFreeGb = free / 1024 ** 3
    diskUsedPct = total > 0 ? ((total - free) / total) * 100 : 0
    diskLevel = band(diskUsedPct, 80, 92)
    if (diskUsedPct >= 80) {
      metrics.push({ level: diskLevel, note: `disk ${Math.round(diskUsedPct)}% full` })
    }
  } catch { /* statfs unavailable -> leave disk at ok/zero */ }

  // ---- CPU load ----
  const cores = os.cpus().length || 1
  const [load1, load5, load15] = os.loadavg()
  const loadPerCore = load1 / cores
  const cpuLevel = band(loadPerCore, 1.0, 2.0)
  if (loadPerCore >= 1.0) {
    metrics.push({ level: cpuLevel, note: `CPU load ${load1.toFixed(2)} on ${cores} cores` })
  }

  // ---- Event-loop lag ----
  // eld.mean is NaN until the histogram has at least one sample; coerce to 0.
  // No reset here — the window resets on a fixed timer (see module top).
  const meanMs = Number.isFinite(eld.mean) ? eld.mean / 1e6 : 0
  const p99Ms = Number.isFinite(eld.percentile(99)) ? eld.percentile(99) / 1e6 : 0
  const loopLevel = band(p99Ms, 80, 250)
  if (p99Ms >= 80) {
    metrics.push({ level: loopLevel, note: `event-loop lag ${Math.round(p99Ms)} ms` })
  }

  // ---- Turns (informational; pressure shows up in mem/loop above) ----
  const turns = turnConcurrency()

  // ---- DB ----
  const dbOnline = await db.query('SELECT 1').then(() => true).catch(() => false)
  let dbSize: string | null = null
  try {
    const r = await db.query<{ s: string }>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS s`,
    )
    dbSize = r.rows[0]?.s ?? null
  } catch { /* ignore */ }
  if (!dbOnline) metrics.push({ level: 'critical', note: 'database unreachable' })

  // ---- Compute the story ----
  const overall = worst(memLevel, swapLevel, diskLevel, cpuLevel, loopLevel, dbOnline ? 'ok' : 'critical')
  const problems = metrics.filter(m => m.level !== 'ok').map(m => m.note)
  let headline: string
  if (overall === 'ok') {
    headline = `All healthy — ${Math.round(availMb)} MB RAM free, ${turns.current} active turn${turns.current === 1 ? '' : 's'}, event loop crisp (${Math.round(p99Ms)} ms).`
  } else if (overall === 'warn') {
    headline = `Watch — ${problems.join('; ')}. ${turns.current} active turn${turns.current === 1 ? '' : 's'} (peak ${turns.peak}).`
  } else {
    headline = `Action needed — ${problems.join('; ')}. Consider scaling the backend.`
  }

  return {
    level: overall,
    headline,
    generated_at: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      total_mb: Math.round(memTotal / 1024 / 1024),
      available_mb: Math.round(availMb),
      used_pct: Math.round(memUsedPct),
      process_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      level: memLevel,
      peak_pct: bumpPeak('memory', memUsedPct),
    },
    swap: {
      total_mb: Math.round(swapTotal / 1024 / 1024),
      used_mb: Math.round(swapUsedMb),
      level: swapLevel,
      peak_pct: bumpPeak('swap', swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0),
    },
    disk: {
      total_gb: Math.round(diskTotalGb * 10) / 10,
      free_gb: Math.round(diskFreeGb * 10) / 10,
      used_pct: Math.round(diskUsedPct),
      level: diskLevel,
      peak_pct: bumpPeak('disk', diskUsedPct),
    },
    cpu: {
      cores,
      load1: Math.round(load1 * 100) / 100,
      load5: Math.round(load5 * 100) / 100,
      load15: Math.round(load15 * 100) / 100,
      load_per_core: Math.round(loadPerCore * 100) / 100,
      level: cpuLevel,
      peak_pct: bumpPeak('cpu', loadPerCore * 100),
    },
    event_loop: {
      mean_ms: Math.round(meanMs * 10) / 10,
      p99_ms: Math.round(p99Ms * 10) / 10,
      level: loopLevel,
      peak_pct: bumpPeak('event_loop', (p99Ms / 250) * 100),
    },
    turns,
    db: { online: dbOnline, size: dbSize },
  }
}
