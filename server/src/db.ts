import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL not set')
}

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
})

export async function healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { rows } = await db.query<{ version: string }>('SELECT version()')
    return { ok: true, version: rows[0]?.version }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
