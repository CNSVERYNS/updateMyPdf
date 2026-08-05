const resendEndpoint = 'https://api.resend.com/emails'
const normalizeEmailAddress = (value) => String(value || '').match(/<([^>]+)>/)?.[1] || String(value || '').trim()

export const getEmailStatus = () => ({
  configured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
  provider: 'resend',
  from: process.env.EMAIL_FROM || null,
})

export const sendResendEmail = async ({ to, subject, html, text, replyTo, attachments }) => {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from) {
    const error = new Error('RESEND_API_KEY and EMAIL_FROM are required.')
    error.code = 'EMAIL_NOT_CONFIGURED'
    throw error
  }
  const recipients = Array.isArray(to) ? to : [to]
  if (!recipients.length || recipients.some((recipient) => !String(recipient || '').includes('@'))) {
    const error = new Error('At least one valid email recipient is required.')
    error.code = 'EMAIL_RECIPIENT_INVALID'
    throw error
  }
  const response = await fetch(resendEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject: String(subject || '').slice(0, 200),
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: normalizeEmailAddress(replyTo) } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    }),
  })
  const raw = await response.text()
  let payload = {}
  try { payload = raw ? JSON.parse(raw) : {} } catch (_error) { payload = { raw } }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Resend request failed with HTTP ${response.status}.`)
    error.code = 'EMAIL_PROVIDER_ERROR'
    error.status = response.status
    throw error
  }
  return payload
}
