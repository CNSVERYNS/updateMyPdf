import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'

if (process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const directory = path.resolve(process.cwd(), 'migrations')
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort()
  for (const file of files) await pool.query(fs.readFileSync(path.join(directory, file), 'utf8'))
  await pool.end()
  console.log(JSON.stringify({ event: 'database_migrations_applied', count: files.length }))
} else {
  console.log(JSON.stringify({ event: 'database_migrations_skipped', reason: 'DATABASE_URL is not configured' }))
}
