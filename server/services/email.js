/**
 * Modul: Email-Service (SMTP)
 * Zweck: SMTP-Konfiguration aus sync_config (env-überschreibbar) auflösen und
 *        Mails über nodemailer versenden. Wird vom Forgot-Password-Flow und der
 *        Admin-Test-Route genutzt.
 * Abhängigkeiten: nodemailer, server/db.js
 */
import nodemailerDefault from 'nodemailer';
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('Email');

const CONFIG_KEYS = {
  host:        { key: 'email_smtp_host',    env: 'EMAIL_SMTP_HOST' },
  port:        { key: 'email_smtp_port',    env: 'EMAIL_SMTP_PORT' },
  secure:      { key: 'email_smtp_secure',  env: 'EMAIL_SMTP_SECURE' },
  user:        { key: 'email_smtp_user',    env: 'EMAIL_SMTP_USER' },
  pass:        { key: 'email_smtp_pass',    env: 'EMAIL_SMTP_PASS' },
  fromAddress: { key: 'email_from_address', env: 'EMAIL_FROM_ADDRESS' },
  fromName:    { key: 'email_from_name',    env: 'EMAIL_FROM_NAME' },
};

const VALID_SECURE = new Set(['ssl', 'starttls', 'none']);

/**
 * nodemailer-Fehlercode -> Fall der Testmail. Die Codes stehen in nodemailers
 * ERROR_CODES (lib/errors); ein Netzfehler darunter traegt den Code von Node
 * (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH ...).
 * @returns {'auth'|'connection'|'tls'|'rejected'|'unknown'}
 */
export function smtpFailureReason(err) {
  const code = String(err?.code ?? '');
  if (code === 'EAUTH' || code === 'ENOAUTH') return 'auth';
  if (code === 'ETLS' || code === 'EREQUIRETLS') return 'tls';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'rejected';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EPROXY', 'ECONNREFUSED', 'ECONNRESET',
    'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'connection';
  return 'unknown';
}

export function createEmailService({ db, nodemailer = nodemailerDefault, env = process.env } = {}) {
  const getDb = () => (db || dbModule.get());

  function cfgGet(key) {
    const row = getDb().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  // env (non-empty) wins over DB, mirroring ensureVapid() in services/push.js.
  function resolve(field) {
    const { key, env: envName } = CONFIG_KEYS[field];
    const fromEnv = env[envName];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
      // Getrimmt wird geprüft, zurückgegeben aber nur, wo Trimmen unschädlich
      // ist. Ein Passwort darf mit einem Leerzeichen anfangen oder enden; wer
      // es abschneidet, macht aus einer gültigen Zugangsdatei eine ungültige,
      // und das fällt erst beim ersten Versandversuch auf. Bei Host, Port und
      // den Adressfeldern ist ein versehentliches Leerzeichen dagegen der
      // wahrscheinlichere Fall, dort hilft das Trimmen.
      return field === 'pass' ? String(fromEnv) : String(fromEnv).trim();
    }
    return cfgGet(key);
  }

  /**
   * Steht dieses Feld unter env-Kontrolle? Der Vorrang oben galt schon immer,
   * aber die Settings-Seite wusste nichts davon: sie zeigte Eingabefelder,
   * speicherte brav in die Datenbank, und der Wert wirkte nie. Ohne Hinweis.
   * Bei WEBDAV_BACKUP_* und DOCUMENT_STORAGE_WEBDAV_* war dasselbe
   * Vorrangverhalten längst sichtbar gelöst, bei SMTP nicht.
   */
  function isEnvControlled(field) {
    const fromEnv = env[CONFIG_KEYS[field].env];
    return fromEnv !== undefined && String(fromEnv).trim() !== '';
  }

  /** Pro Feld, nicht pro Gruppe: wer nur EMAIL_SMTP_HOST setzt, darf den Rest weiter in der UI pflegen. */
  function envControlledFields() {
    return Object.fromEntries(Object.keys(CONFIG_KEYS).map(f => [f, isEnvControlled(f)]));
  }

  function getRawConfig() {
    const secure = (resolve('secure') || 'starttls').toLowerCase();
    return {
      host: resolve('host'),
      port: Number.parseInt(resolve('port'), 10) || null,
      secure: VALID_SECURE.has(secure) ? secure : 'starttls',
      user: resolve('user'),
      pass: resolve('pass'),
      fromAddress: resolve('fromAddress'),
      fromName: resolve('fromName') || 'Yuvomi',
    };
  }

  function isConfigured() {
    const c = getRawConfig();
    return Boolean(c.host && c.fromAddress);
  }

  // Public view for the settings UI — never exposes the password.
  function getPublicConfig() {
    const c = getRawConfig();
    return {
      host: c.host || '',
      port: c.port || (c.secure === 'ssl' ? 465 : 587),
      secure: c.secure,
      user: c.user || '',
      fromAddress: c.fromAddress || '',
      fromName: c.fromName,
      passwordSet: Boolean(c.pass),
      configured: isConfigured(),
      envControlled: envControlledFields(),
    };
  }

  /**
   * ZEITSCHRANKEN AM TRANSPORT, und sie sind absichtlich knapper als die des
   * Aufrufers. Ohne sie wartet nodemailer unbegrenzt auf einen SMTP-Server, der
   * die Verbindung offen laesst. Fuer den Erinnerungslauf (#944) ist das mehr
   * als eine Verzoegerung: er arbeitet alle faelligen Erinnerungen nacheinander
   * ab, und sein Abbruch nach 8 s liesse den Versand darunter WEITERLAUFEN -
   * die Zustellung gaelte als gescheitert, wuerde erneut versucht, und die Mail
   * kaeme womoeglich zweimal an. Deshalb muss der Transport zuerst aufgeben,
   * nicht der Aufrufer: dann ist die Verbindung wirklich zu und ein erneuter
   * Versuch ist redlich.
   */
  const TRANSPORT_TIMEOUT_MS = 5_000;

  function buildTransport(c) {
    const opts = {
      host: c.host,
      port: c.port || (c.secure === 'ssl' ? 465 : 587),
      secure: c.secure === 'ssl',
      connectionTimeout: TRANSPORT_TIMEOUT_MS,
      greetingTimeout: TRANSPORT_TIMEOUT_MS,
      socketTimeout: TRANSPORT_TIMEOUT_MS,
    };
    if (c.secure === 'starttls') opts.requireTLS = true;
    if (c.user) opts.auth = { user: c.user, pass: c.pass || '' };
    return nodemailer.createTransport(opts);
  }

  function fromHeader(c) {
    return c.fromName ? `"${c.fromName}" <${c.fromAddress}>` : c.fromAddress;
  }

  /**
   * `logLabel` haelt den Betreff aus dem Log. Solange hier nur Passwort-Reset
   * und Einladungen liefen, war der Betreff fest formuliert und im Log
   * nuetzlich. Eine Erinnerungsmail (#944) traegt dagegen den Aufgaben- oder
   * Terminnamen im Betreff - bei Medikamenten-Erinnerungen einen
   * Gesundheitsdatensatz. Der landete damit auf stdout des Containers, wo er
   * dauerhaft liegen bleibt und von jeder Log-Sammlung mitgenommen wird.
   * Wer eine Mail mit variablem Betreff verschickt, nennt hier stattdessen
   * ihre Gattung.
   */
  async function sendMail({ to, subject, html, text, logLabel = null }) {
    if (!isConfigured()) throw new Error('Email is not configured.');
    const c = getRawConfig();
    const transport = buildTransport(c);
    const info = await transport.sendMail({ from: fromHeader(c), to, subject, html, text });
    log.info(`Mail sent to ${to} (${logLabel || subject})`);
    return info;
  }

  // Verifies the connection, then sends a probe mail. Never throws — returns a result.
  async function sendTest(to) {
    try {
      if (!isConfigured()) return { ok: false, reason: 'not_configured', error: 'Email is not configured.' };
      const c = getRawConfig();
      const transport = buildTransport(c);
      await transport.verify();
      await transport.sendMail({
        from: fromHeader(c),
        to,
        subject: 'Yuvomi SMTP test',
        text: 'This is a test message confirming your Yuvomi SMTP configuration works.',
        html: '<p>This is a test message confirming your Yuvomi SMTP configuration works.</p>',
      });
      return { ok: true };
    } catch (err) {
      log.warn('SMTP test failed:', err?.message || err);
      // Der Grund als Fall, nicht als Satz (Re-Critique 2026-10-17): die Seite
      // zeigte den englischen Text von nodemailer ("Invalid login: 535 ...").
      // `error` bleibt fuer Logs und API-Clients stehen, die Oberflaeche liest
      // `reason` und sagt den Satz in der Sprache der Person.
      return { ok: false, reason: smtpFailureReason(err), error: err?.message || String(err) };
    }
  }

  return { isConfigured, getPublicConfig, getRawConfig, isEnvControlled, sendMail, sendTest };
}

export const emailService = createEmailService();
