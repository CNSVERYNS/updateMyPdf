import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { cookieName, createSession } from '../../../../lib/admin-session'

const sessionLifetimeSeconds = 8 * 60 * 60

export async function POST(request: NextRequest) {
  const form = await request.formData()
  if (String(form.get('_logout') || '') === 'true') {
    const response = NextResponse.redirect(new URL('/admin', request.url), 303)
    response.cookies.set(cookieName, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 })
    return response
  }
  const provided = String(form.get('secret') || '')
  const configured = process.env.ADMIN_API_SECRET || ''
  const actualBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(configured)
  const matches = Boolean(configured) && actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  if (!matches || !(process.env.ADMIN_DASHBOARD_SESSION_SECRET || configured)) return NextResponse.redirect(new URL('/admin?error=1', request.url), 303)
  const response = NextResponse.redirect(new URL('/admin', request.url), 303)
  response.cookies.set(cookieName, createSession(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: sessionLifetimeSeconds })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(cookieName, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 })
  return response
}
