/**
 * Modul: Email Notification Provider
 * Zweck: Yuvomi Reminder-Payloads als Mail zustellen (#944).
 * Abhaengigkeiten: server/services/email.js, public/utils/html.js
 */
import { emailService as defaultEmailService } from '../email.js';
import { esc } from '../../../public/utils/html-escape.js';
import { NotificationProviderError } from './provider-error.js';

/**
 * KEINE EIGENEN ZUGANGSDATEN. Gotify, ntfy und Webhook bringen je Kanal ihren
 * eigenen Endpunkt und ihr eigenes Geheimnis mit - Mail nicht. Der SMTP-Zugang
 * steht app-weit genau einmal in `services/email.js` (Settings oder EMAIL_SMTP_*)
 * und traegt bereits Passwort-Reset und Einladungen. Ein zweiter Satz je Kanal
 * waere eine zweite Schreibweise fuer dieselbe Sache: zwei Orte, an denen ein
 * Serverwechsel nachgezogen werden muss, und einer davon wird vergessen.
 *
 * Der Kanal traegt deshalb nur die Zieladresse - genau so, wie ein ntfy-Kanal
 * nur sein Topic traegt.
 */

// Ein Betreff ist ein Header. Ein Aufgabentitel mit Zeilenumbruch darf keine
// weiteren Header oeffnen - nodemailer kodiert zwar, aber die Zusicherung
// gehoert an die Stelle, die den Wert baut, nicht an die Bibliothek dahinter.
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Betreff: Herkunft UND Sache. Bei Push traegt der Titel die Herkunft
 * („Kalender") und der Body die Sache („Zahnarzttermin") - im Posteingang ist
 * aber nur der Betreff sichtbar, und „Kalender" allein sagt dort nichts. Sind
 * beide da und verschieden, stehen beide drin.
 */
function subjectFor(payload) {
  const title = headerSafe(payload?.title);
  const body = headerSafe(payload?.body);
  if (title && body && title !== body) return `${title}: ${body}`;
  return title || body || 'Yuvomi';
}

/**
 * Aus dem relativen Ziel (`/calendar`) wird nur mit BASE_URL ein Link. Der
 * Request-Host wird hier bewusst nicht herangezogen - dieselbe Regel wie beim
 * Passwort-Reset, und hier kommt ohnehin kein Request vorbei: der Versand
 * laeuft im Hintergrund-Lauf. Fehlt BASE_URL, traegt die Mail keinen Link
 * statt eines kaputten.
 */
function absoluteUrl(payload, baseUrl) {
  const origin = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const path = String(payload?.url ?? '').trim();
  if (!origin || !path) return null;
  try {
    return new URL(path, `${origin}/`).toString();
  } catch {
    return null;
  }
}

function renderText(payload, link) {
  const lines = [String(payload?.body ?? '').trim() || 'Reminder'];
  if (link) lines.push('', link);
  return lines.join('\n');
}

// payload.title und payload.body sind Nutzerdaten (Aufgabentitel, Terminname).
// In eine HTML-Mail gehoeren sie escaped - dieselbe Regel wie im Frontend, und
// hier zusaetzlich, weil manche Clients HTML grosszuegig interpretieren.
function renderHtml(payload, link) {
  const body = esc(String(payload?.body ?? '').trim() || 'Reminder');
  const parts = [`<p>${body}</p>`];
  if (link) parts.push(`<p><a href="${esc(link)}">${esc(link)}</a></p>`);
  return parts.join('');
}

export const emailProvider = {
  id: 'email',

  /**
   * Einsatzbereit? Als Provider-Faehigkeit formuliert, nicht als Sonderfall in
   * der Route: die fragt „bist du bereit", statt „bist du zufaellig email".
   * Wer den Kanal ohne SMTP anlegt, erfaehrt das sonst erst durch einen
   * Testversand - und die Test-Route meldet generisches „Internal error",
   * womit der eine Satz verloren geht, der hier weiterhilft.
   */
  isAvailable({ emailService = defaultEmailService } = {}) {
    return emailService.isConfigured();
  },

  async send({
    channel,
    payload,
    emailService = defaultEmailService,
    signal,
    env = process.env,
  } = {}) {
    const to = String(channel?.config?.toAddress ?? '').trim();
    if (!to) throw new NotificationProviderError('Email notification channel has no recipient address.');
    // Der Grund gehoert in die Meldung: „nicht konfiguriert" ist im
    // Kanal-Testknopf eine Handlungsanweisung, ein generischer Fehler nicht.
    if (!emailService.isConfigured()) {
      throw new NotificationProviderError('Email is not configured. Set up SMTP in Settings before using an email channel.');
    }

    const link = absoluteUrl(payload, env.BASE_URL);
    const send = emailService.sendMail({
      to,
      subject: subjectFor(payload),
      text: renderText(payload, link),
      html: renderHtml(payload, link),
      // Der Betreff traegt hier Nutzerdaten - bei einer Medikamenten-Erinnerung
      // einen Gesundheitsdatensatz. Er gehoert in die Mail, nicht ins Log.
      logLabel: 'reminder notification',
    });

    // NODEMAILER KENNT KEIN AbortSignal, deshalb dieses Rennen - aber es ist das
    // ZWEITE Netz, nicht das erste. Das erste sind die Zeitschranken am
    // Transport (services/email.js): sie sind knapper gesetzt als der Abbruch
    // des Aufrufers, damit im Regelfall nodemailer selbst aufgibt und die
    // Verbindung wirklich zu ist. Nur dann ist ein erneuter Versuch redlich.
    //
    // Greift trotzdem das Rennen hier, laeuft der Versand darunter weiter: die
    // Zustellung gilt als gescheitert, wird wiederholt, und die Mail kann
    // zweimal ankommen. Das ist bewusst der guenstigere Fehler. Die Alternative
    // waere ein Lauf, der an einem stummen Server haengt - und der haelt nicht
    // eine Meldung auf, sondern alle, fuer alle, bei jedem Weckruf erneut.
    if (!signal) return send.then(() => ({ ok: true }));
    if (signal.aborted) throw new NotificationProviderError('Email delivery timed out.');
    return Promise.race([
      send.then(() => ({ ok: true })),
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new NotificationProviderError('Email delivery timed out.')), { once: true });
      }),
    ]);
  },
};

export default emailProvider;
