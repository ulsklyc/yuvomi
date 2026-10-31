# Design: Konsequenzen (Strafen) im Belohnungssystem — optional, Haushalts-Schalter

## Problem (Nutzerwunsch, 2026-10-29)
Eltern sollen auf Fehlverhalten reagieren können (schlechte Noten, unordentliches
Zimmer, Geschrei, zu spaet ins Bett, „Ramba Zamba" beim Zubettgehen) — als
spiegelbildliche Buchungen zu Punkten. Alles optional: Familien ohne Strafen
sollen nichts davon sehen.

## Was der Kern schon traegt
- `reward_ledger.delta` ist **vorzeichenbehaftet** (Bonus positiv, adjust negativ).
- `reward_ledger.type`-CHECK: ('earn','bonus','redeem','adjust','reversal').
- Haushaltsschalter laufen ueber `sync_config` + `PUT /api/v1/preferences`
  (Muster: `rewards_require_approval`).
- Rollen: `users.family_role` in ('dad','mom','parent',...), `admin` umgeht Rechte.

## Entscheidungen
1. **Eigener Typ `penalty`** statt `adjust`-zweckentfremdung: die Herkunft ist
   die Antwort auf "warum ist mein Konto minus?" — ein Kind sieht "Konsequenz:
   Zimmer unordentlich (-5)", nicht "Korrektur". CHECK-Erweiterung braucht einen
   bewachten Tabellen-Rebuild (Muster existiert, z. B. v11).
2. **Schalter `rewards_penalties_enabled`** (sync_config, Standard **aus**).
   Aus: Route antwortet 403 mit klarer Meldung, UI zeigt nichts.
3. **Wer darf verhaengen:** Eltern (`family_role` dad/mom/parent) und Admin —
   aber NUR gegenueber Kindern (`family_role = 'child'`) und dem eigenen
   Haushalt; Admin gegenueber allen. Ein Elternteil darf sich nicht selbst und
   kein anderes Elternteil bestrafen. (Pruefung ueber resolvePermissions-artige
   Rollenabfrage, kein Admin-Bypass fuer Eltern-Regel.)
4. **Grund ist Pflicht** (2–200 Zeichen) plus optionale Kategorie aus fester
   Liste (Eltern-Beispiele als Vorschlaege):
   `noten`, `zimmer`, `geschrei`, `bettzeit`, `ritual`, `other`. Kategorie ist
   frei waehlbar, Grund beschreibt den Einzelfall — beides bleibt lesbar im
   Verlauf.
5. **Hoehe:** positiver Betrag 1–100, wird als negativer delta gebucht.
   Punkte-Konto darf ins Negative gehen (das ist der paedagogische Zweck); der
   Catalog-Einloesungsflow bleibt unveraendert (man kann nichts mit minus
   kaufen).
6. **Rueckgaengig** wie ein Haken: `reversal`-Zeile, die den penalty-Stand
   neutralisiert (Muster: reverseTaskEarnings). Ein Kind sieht die Buchung
   geloescht-Status nicht als "nie gewesen", sondern als transparente Korrektur.
7. **Sichtbarkeit:** Strafen sind fuer das betroffene Kind und Eltern/Admin
   sichtbar — dieselbe Regel wie der Ledger selbst (`rewards-ledger-visibility`);
   Geschwister sehen einander nicht.

## Migration (273)
- Rebuild `reward_ledger` mit erweitertem type-CHECK (+ 'penalty'), bewacht
  (nur wenn CHECK den Wert noch nicht enthaelt — Pruefung ueber
  `sqlite_master.sql`), Indizes neu anlegen.
- Kein neues Pool-Feeling: `created_by` ist schon da (wer hat vergeben).

## API
- `POST /api/v1/rewards/penalty` — body: `{ userId, amount (1..100), reason (2..200), category? }`.
  403 wenn Schalter aus oder kein Elternteil/Admin; 400 bei ungueltigen Werten
  (Amount als Zahl wie im Bonus-Pfad); 404 bei fremder/fehlender Kennung.
  Buucht delta = -amount, type 'penalty', created_by = agierendes Elternkonto.
- `DELETE /api/v1/rewards/penalty/:id` — nur Urheber oder Admin, schreibt
  `reversal` (+amount, reason "Konsequenz zurueckgenommen"), nur wenn die
  penalty-Zeile noch nicht revidiert ist.
- `GET /ledger` liefert penalties automatisch mit (type-Feld differenziert).
- `GET/PUT /api/v1/preferences`: Schluessel `rewards_penalties_enabled` (boolean,
  analog rewards_require_approval).

## UI (public/, Vanilla wie bisher)
- Einstellungen → Belohnungen: Checkbox "Konsequenzen erlauben" (mit
  Hilfetext: "Eltern koennen Kindern Punkte fuer Fehlverhalten abziehen.").
- Punkte-Ansicht des Kindes (Eltern-/Admin-Sicht): Button "Konsequenz…" —
  Dialog: Betrag, Kategorie-Select, Grund-Feld. Ledger-Zeilen zeigen
  "-5 · Zimmer unordentlich" mit eigenem Icon (lucide `minus-circle`, rot wie
  der Abzug).
- Kind-Sicht: Eintrag sichtbar, kein eigener Buttons.
- i18n de/en (restliche Locales ueberfallen den englischen Text wie ueblich).

## Tests (test-penalties.js, Muster test-rewards.js/test-rewards-routes.js)
- Schalter aus: POST 403 (Elter UND Kind); Schalter an: Elter 201.
- Kind darf nicht verhaengen; Elter gegen Erwtachsene 403.
- amount 0/-3/101/"abc" → 400; reason fehlt → 400.
- Buchung: delta negativ, type 'penalty', Ledger-Saldo sinkt; Kind sieht nur
  eigene (Sichtbarkeits-Analogie).
- DELETE: zweite Loeschung 409; Fremder 403/404.
- Rebuild-Migration laeuft zweimal ohne Fehler (guard-Test wie die anderen
  Migrations-Tests).

## Upstream-Chance
Meldung im Issue-Stil: "Optional consequences (penalties) for the rewards
system" — der Schalter macht es fuer Familien ohne Strafen unsichtbar, fuer
andere ein voller Gegenpol. Design hier laesst sich 1:1 als Issue texten.

## Reihenfolge
1. opencode liefert Rotation-UI ab (laeuft).
2. Danach: Backend-Migration + Service + Routes + Tests (kein paralleler
   package.json/test-suites.md/Edit — Konfliktgefahr).
3. UI + i18n + Settings-Schalter.
