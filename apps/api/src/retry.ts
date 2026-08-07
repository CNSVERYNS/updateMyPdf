export const retryDelayMs = (attempt: number, retryAfterHeader?: string | null) => {
  const retryAfter = Number(retryAfterHeader)
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 300000)
  return [5000, 15000, 30000, 60000, 120000][Math.min(Math.max(attempt, 0), 4)]
}

export const isRetryableStatus = (status: number) => [408, 429, 500, 502, 503, 504].includes(status)

export const isRetryableError = (error: unknown) => {
  const item = error as { status?: number; code?: string; name?: string }
  return (typeof item?.status === 'number' && isRetryableStatus(item.status)) || ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'AbortError'].includes(String(item?.code || item?.name))
}

