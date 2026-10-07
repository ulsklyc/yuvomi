/**
 * Modul: Uebergabe des Starts
 * Zweck: Was ein Start schon angefragt hat, wird weitergereicht statt ein
 *        zweites Mal geholt (Critique R18, "fuenf serielle Startabrufe").
 * Abhaengigkeiten: keine (auth und das Ereignis kommen von aussen, damit
 *        test/test-start-handoff.js den Ablauf ohne Browser fahren kann)
 *
 * KEIN CACHE. Jedes Feld gilt fuer genau EINEN Start, wird genau einmal
 * abgeholt und verfaellt, sobald dieser Start seine erste Seite gezeichnet hat.
 * Wer danach fragt, bekommt nichts und holt selbst - so wie vorher.
 *
 *   session     `/auth/me`, beim Laden des Dokuments zusammen mit `/version`
 *               angefragt; der Auth-Guard in navigate() wartet darauf, statt
 *               erst nach `/version` selbst zu fragen.
 *   version     die Antwort auf das `/version` des Starts. Mit Sitzung traegt
 *               sie schon alles, was syncPreferencesOnce() braucht.
 *   preferences das laufende `/preferences` aus syncPreferencesOnce(), fuer
 *               die Seite, die gleich zeichnet (die Uebersicht).
 */

/**
 * @param {object} deps
 * @param {{ me: (opts?: object) => Promise<any> }} deps.auth
 * @param {() => void} deps.dispatchExpired - feuert `auth:expired`
 */
export function createStartHandoff({ auth, dispatchExpired }) {
  const held = { session: null, version: null, preferences: null };

  return {
    /**
     * Fragt die Sitzung vorab an - STILL (`quietExpiry`). Feuerte ein 401 hier
     * `auth:expired`, bevor die erste Navigation laeuft, schickte der Handler
     * die Seite auf die Anmeldung, waehrend der Start noch gar nicht weiss, ob
     * stattdessen die Einrichtung dran ist.
     */
    askSession() {
      held.session = auth.me({ quietExpiry: true })
        .then((result) => ({ ok: true, result }), (error) => ({ ok: false, error }));
    },

    holdVersion(payload) { held.version = payload ?? null; },

    holdPreferences(pending) { held.preferences = pending ?? null; },

    /**
     * `/version` antwortet einer Sitzung ausfuehrlicher als einem Unbekannten
     * (server/index.js, buildVersionPayload): nur die ausfuehrliche Antwort
     * traegt `version`. Die knappe taugt nicht - nach dem Anmelden wird neu gefragt.
     */
    takeVersion() {
      const payload = held.version;
      held.version = null;
      return payload?.version ? payload : null;
    },

    /** Das `/preferences` dieses Starts, einmal; `null`, wenn es keines (mehr) gibt. */
    takePreferences() {
      const pending = held.preferences;
      held.preferences = null;
      return pending;
    },

    /**
     * Die erste Navigation ist durch: was sie nicht abgeholt hat, verfaellt.
     * Eine spaetere Anmeldung faende sonst die Antwort einer frueheren Sitzung vor.
     */
    expireStart() {
      held.session = null;
      held.version = null;
    },

    /** Die Seite dieses Starts ist gezeichnet: ihre Uebergabe verfaellt. */
    expirePage() {
      held.preferences = null;
    },

    /**
     * `auth` fuer navigate(): `me()` liefert zuerst die Antwort, die der Start
     * schon angefragt hat.
     *
     * DER 401-PFAD BLEIBT, WIE ER WAR. `auth:expired` feuert HIER, in dem
     * Moment, in dem der Auth-Guard die Antwort abholt - dieselbe Stelle und
     * dieselbe Reihenfolge wie bei einem eigenen `auth.me()`. Holt sie niemand
     * ab (oeffentliche Seite, Einrichtung), passiert nichts.
     */
    auth: {
      ...auth,
      me: async () => {
        const pending = held.session;
        held.session = null;
        if (!pending) return auth.me();
        const outcome = await pending;
        if (outcome.ok) return outcome.result;
        if (outcome.error?.status === 401) dispatchExpired();
        throw outcome.error;
      },
    },
  };
}
