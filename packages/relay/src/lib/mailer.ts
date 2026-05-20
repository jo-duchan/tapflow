import nodemailer from 'nodemailer'
import { config } from './config.js'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('relay:mailer')

function createTransport() {
  if (!config.smtp.host) return null
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  })
}

export async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const transport = createTransport()
  if (!transport) return false
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, html })
    return true
  } catch (err) {
    logger.error('send failed', err)
    return false
  }
}
