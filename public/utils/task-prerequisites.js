/**
 * Modul: Aufgaben-Vorbedingungen (Vorheraufgaben) - Rueckmeldung der Oberflaeche
 * Zweck: Eine Aufgabe kann Vorbedingungen nennen, die erledigt sein muessen,
 *        bevor sie selbst abgehakt werden kann. Wer sie abhakt, waehrend noch
 *        eine offen ist, bekommt vom Server eine 409-Absage mit Grund
 *        `tasks_prerequisite_open` und der Liste der offenen Vorbedingungen
 *        (`open_prerequisites`, server/routes/tasks.js). Dieser Helfer macht
 *        daraus den Satz, den die Oberflaeche zeigt: hoechstens drei beim Namen,
 *        der Rest als Anzahl - nie ein Titel kuerzer als ein Wort.
 *
 *        Eigene Datei, weil beide Schreibwege denselben Satz brauchen: die
 *        Liste, das Brett und die Personenwahl (pages/tasks.js) und die
 *        Leseansicht (components/task-detail.js). Die Titel stammen aus der
 *        Absage - Nutzerdaten, keine Servermeldung; deshalb darf die Stelle
 *        sie nennen, wo utils/friendly-error.js den Servertext nie durchlaesst.
 * Ausfuehren: npm run test:task-prerequisites-ui
 */
import { t } from '/i18n.js';

/** Hoechstens so viele Titel nennt der Satz beim Namen; der Rest wird +N. */
export const MAX_NAMED_PREREQS = 3;

/**
 * Der Satz fuer die Absage "Vorbedingungen noch offen" - oder null, wenn es
 * ein anderer Fall ist (dann sagt der Aufrufer seinen allgemeinen Satz, wie
 * bisher: `errorSentence` / `toggleFailedSentence`).
 *
 * Kommt die Absage ohne brauchbare Titel an (uralte Antwort, teilausgefallene
 * Liste), gibt sie null - die allgemeinen Saetze der Aufrufer kennen den Fall
 * zwar nicht, sagen aber nichts Falsches.
 *
 * @param {unknown} err die gefangene ApiError-Antwort
 * @returns {string|null} uebersetzter Satz oder null
 */
export function prerequisiteBlockSentence(err) {
  if (err?.data?.reason !== 'tasks_prerequisite_open') return null;
  const open = Array.isArray(err.data.open_prerequisites) ? err.data.open_prerequisites : [];
  const titles = open.map((p) => String(p?.title ?? '').trim()).filter(Boolean);
  if (!titles.length) return null;
  const names = titles.slice(0, MAX_NAMED_PREREQS).join(', ');
  const extra = titles.length - Math.min(titles.length, MAX_NAMED_PREREQS);
  return extra > 0
    ? t('tasks.tickBlockedByPrereqsMore', { names, extra })
    : t('tasks.tickBlockedByPrereqs', { names });
}
