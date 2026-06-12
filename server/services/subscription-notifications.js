import cron from 'node-cron';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { privateAddress } from './subscription-logo.js';

const log = createLogger('SubscriptionNotifications');
let scheduledTask = null;

async function assertAllowedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notification URL must use HTTP or HTTPS.');
  const addresses = await dns.lookup(url.hostname, { all: true });
  const privateTarget = addresses.some(({ address }) => privateAddress(address));
  if (privateTarget && process.env.SUBSCRIPTION_NOTIFICATION_ALLOW_PRIVATE !== 'true') {
    throw new Error('Private notification targets require SUBSCRIPTION_NOTIFICATION_ALLOW_PRIVATE=true.');
  }
  return url;
}

async function postJson(urlValue, payload, headers = {}) {
  const url = await assertAllowedUrl(urlValue);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Notification target returned HTTP ${response.status}.`);
}

function messageFor(subscription) {
  return `Upcoming subscription payment: ${subscription.name} (${subscription.amount} ${subscription.currency}) on ${subscription.next_payment_date}.`;
}

function smtpCommand(socket, command, accepted = ['250']) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (!/^\d{3} /.test(last)) return;
      socket.off('data', onData);
      const code = last.slice(0, 3);
      if (!accepted.includes(code)) reject(new Error(`SMTP ${code}: ${last.slice(4)}`));
      else resolve(last);
    };
    socket.on('data', onData);
    if (command !== null) socket.write(`${command}\r\n`);
  });
}

async function sendEmail(recipient, subject, text) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === 'true' ? 465 : 25));
  const from = process.env.SMTP_FROM;
  if (!host || !from) throw new Error('SMTP_HOST and SMTP_FROM are required for email notifications.');
  const socket = process.env.SMTP_SECURE === 'true'
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  await new Promise((resolve, reject) => {
    socket.once(process.env.SMTP_SECURE === 'true' ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  try {
    await smtpCommand(socket, null, ['220']);
    await smtpCommand(socket, `EHLO ${process.env.SMTP_HELO || 'yuvomi.local'}`);
    if (process.env.SMTP_USER) {
      await smtpCommand(socket, 'AUTH LOGIN', ['334']);
      await smtpCommand(socket, Buffer.from(process.env.SMTP_USER).toString('base64'), ['334']);
      await smtpCommand(socket, Buffer.from(process.env.SMTP_PASS || '').toString('base64'), ['235']);
    }
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${recipient}>`, ['250', '251']);
    await smtpCommand(socket, 'DATA', ['354']);
    const safeText = text.replace(/^\./gm, '..');
    socket.write(`From: ${from}\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${safeText}\r\n.\r\n`);
    await smtpCommand(socket, null);
    await smtpCommand(socket, 'QUIT', ['221']);
  } finally {
    socket.end();
  }
}

async function sendAgent(agent, subscription) {
  const config = JSON.parse(agent.config_json);
  const message = messageFor(subscription);
  if (agent.type === 'email') return sendEmail(config.recipient, 'Upcoming subscription payment', message);
  if (agent.type === 'discord') return postJson(config.url, { content: message });
  if (agent.type === 'telegram') {
    return postJson(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, { chat_id: config.chat_id, text: message });
  }
  if (agent.type === 'pushover') {
    const body = new URLSearchParams({ token: config.app_token, user: config.user_key, message });
    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Pushover returned HTTP ${response.status}.`);
    return;
  }
  if (agent.type === 'gotify') {
    const url = new URL('/message', await assertAllowedUrl(config.url));
    url.searchParams.set('token', config.token);
    return postJson(url, { title: 'Subscription reminder', message, priority: 5 });
  }
  if (agent.type === 'serverchan') {
    return postJson(`https://sctapi.ftqq.com/${config.send_key}.send`, { title: 'Subscription reminder', desp: message });
  }
  if (agent.type === 'ntfy') {
    const url = new URL(encodeURIComponent(config.topic), `${String(config.url).replace(/\/+$/, '')}/`);
    return postJson(url, { topic: config.topic, title: 'Subscription reminder', message },
      config.token ? { Authorization: `Bearer ${config.token}` } : {});
  }
  return postJson(config.url, {
    event: 'subscription.reminder',
    subscription: {
      id: subscription.id,
      name: subscription.name,
      amount: subscription.amount,
      currency: subscription.currency,
      next_payment_date: subscription.next_payment_date,
    },
    message,
  }, config.token ? { Authorization: `Bearer ${config.token}` } : {});
}

async function processDueNotifications() {
  const database = db.get();
  const subscriptions = database.prepare(`
    SELECT * FROM budget_subscriptions
    WHERE enabled = 1
      AND date(next_payment_date, '-' || reminder_days || ' days') <= date('now')
      AND date(next_payment_date) >= date('now')
  `).all();
  const agents = database.prepare('SELECT * FROM subscription_notification_agents WHERE enabled = 1').all();
  const delivered = database.prepare(`
    SELECT 1 FROM subscription_notification_deliveries
    WHERE subscription_id = ? AND agent_id = ? AND payment_date = ?
  `);
  const record = database.prepare(`
    INSERT INTO subscription_notification_deliveries (subscription_id, agent_id, payment_date)
    VALUES (?, ?, ?)
  `);
  for (const subscription of subscriptions) {
    for (const agent of agents) {
      if (delivered.get(subscription.id, agent.id, subscription.next_payment_date)) continue;
      try {
        await sendAgent(agent, subscription);
        record.run(subscription.id, agent.id, subscription.next_payment_date);
        database.prepare('UPDATE subscription_notification_agents SET last_error = NULL WHERE id = ?').run(agent.id);
      } catch (err) {
        database.prepare('UPDATE subscription_notification_agents SET last_error = ? WHERE id = ?')
          .run(String(err.message).slice(0, 1000), agent.id);
        log.warn(`Agent ${agent.id} failed: ${err.message}`);
      }
    }
  }
}

function startScheduler() {
  if (scheduledTask || process.env.SUBSCRIPTION_NOTIFICATIONS_ENABLED === 'false') return;
  scheduledTask = cron.schedule('0 * * * *', () => {
    processDueNotifications().catch((err) => log.error('Scheduled delivery failed:', err));
  });
  setTimeout(() => processDueNotifications().catch((err) => log.error('Initial delivery failed:', err)), 15000);
}

export { assertAllowedUrl, processDueNotifications, sendAgent, startScheduler };
