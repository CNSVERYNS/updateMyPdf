import { NextRequest, NextResponse } from 'next/server'

const upstream = (process.env.TRANSLATION_API_URL || 'http://localhost:4000').replace(/\/$/, '')

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  const target = new URL(`${upstream}/api/v1/${path.map((part) => encodeURIComponent(part)).join('/')}`)
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value))
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const secret = process.env.INTERNAL_API_SECRET
  if (secret) headers.set('x-internal-api-secret', secret)
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
  const response = await fetch(target, { method: request.method, headers, body, cache: 'no-store' })
  const responseHeaders = new Headers()
  for (const name of ['content-type', 'content-disposition', 'x-correlation-id']) { const value = response.headers.get(name); if (value) responseHeaders.set(name, value) }
  return new NextResponse(await response.arrayBuffer(), { status: response.status, headers: responseHeaders })
}

export const GET = proxy
export const POST = proxy
export const DELETE = proxy
