import nodemailer from 'nodemailer'

function createTransport() {
  const host = process.env.SMTP_HOST
  if (!host) return null
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  })
}

const FROM = process.env.SMTP_FROM ?? 'tapflow <noreply@tapflow.local>'

export async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const transport = createTransport()
  if (!transport) return false
  try {
    await transport.sendMail({ from: FROM, to, subject, html })
    return true
  } catch (err) {
    console.error('[mailer] send failed:', err)
    return false
  }
}
