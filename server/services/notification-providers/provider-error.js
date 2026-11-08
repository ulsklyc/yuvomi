/**
 * Modul: eigener Satz eines Benachrichtigungsanbieters
 * Zweck: markiert, welche Fehlermeldung ein Kanaltest speichern und dem Admin
 * zeigen darf (Phase 0, Abschnitt H).
 *
 * Ein Kanaltest legt seinen Fehler als `last_error` am Kanal ab, und die
 * Kanalliste gibt ihn zurueck. Die Saetze der Anbieter selbst ("Gotify
 * authentication failed.", "Email is not configured ...") sind dort gewollt:
 * sie sagen, was zu tun ist. Alles andere - Node, fetch, nodemailer - nennt
 * Host, Port oder die Antwort des SMTP-Servers und wird nur als Klasse
 * gespeichert. Die Unterscheidung haengt am Typ, nie am Wortlaut.
 */
export class NotificationProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotificationProviderError';
  }
}
