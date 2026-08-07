import crypto from 'node:crypto'

export const cookieName = 'updatemypdf_admin_session'
const sessionLifetimeSeconds = 8 * 60 * 60

const sessionSecret = () => process.env.ADMIN_DASHBOARD_SESSION_SECRET || process.env.ADMIN_API_SECRET || ''
const encode = (value: string | Buffer) => Buffer.from(value).toString('base64url')
const signature = (payload: string) => encode(crypto.createHmac('sha256', sessionSecret()).update(payload).digest())

export const createSession = () => {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds
  const payload = encode(JSON.stringify({ exp: expiresAt }))
  return `${payload}.${signature(payload)}`
}

export const validSession = (value: string | undefined) => {
  if (!value || !sessionSecret()) return false
  const [payload, provided] = value.split('.')
  if (!payload || !provided) return false
  const expected = signature(payload)
  const actualBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number }
    return Number(decoded.exp) > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}
