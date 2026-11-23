const nodemailer = require('nodemailer');
const config = require('../config/env');
const logger = require('./logger');

/**
 * Sends email over SMTP_URL (any provider). Without SMTP_URL the message is only
 * rendered and logged, so local runs and the demo work with no email account.
 * Callers use mailer.send, so tests can spy on it or swap the transport.
 */
let transport = null;

function createTransport() {
  return config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : nodemailer.createTransport({ jsonTransport: true });
}

async function send(message) {
  transport ??= createTransport();
  const info = await transport.sendMail({ from: config.MAIL_FROM, ...message });
  if (!config.SMTP_URL) {
    logger.info({ to: message.to, subject: message.subject }, 'Email logged, not sent (SMTP_URL is not set)');
  }
  return info;
}

const mailer = {
  send,
  /** Tests only. */
  setTransport(t) {
    transport = t;
  },
};

module.exports = mailer;
