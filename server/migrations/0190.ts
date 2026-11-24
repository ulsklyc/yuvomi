// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 190,
    description: 'account username on inventory items and subscriptions',
    up: `
      -- DIE KONTOANGABE OHNE DAS GEHEIMNIS (#1004).
      --
      -- Unter welcher Adresse oder welchem Benutzernamen ein Geraet oder ein Abo
      -- registriert ist. Das ist KEIN Passwortfeld und wird es nie: ein
      -- Benutzername ohne sein Passwort ist ein Telefonbucheintrag, und genau
      -- deshalb darf er unverschluesselt in der normalen Datenbank stehen. Die
      -- Grenze dazu steht dauerhaft in docs/SCOPE.md, Abschnitt 2.
      --
      -- HAUSHALTSWEIT IM INVENTAR, und das ist eine Entscheidung, keine
      -- Nachlaessigkeit: inventory_items traegt weder owner_id noch visibility,
      -- der Zugriff faellt einmal je Mitglied auf Modulebene (#467). Ein
      -- eigentuemer-gebundenes Feld haette also bedeutet, dem Inventar ein
      -- Besitzmodell zu geben, nur um eine Spalte zu halten. Der Melder hat das
      -- in #1004 selbst so entschieden: Kontonamen sind meist E-Mail-Adressen,
      -- und wer im Netz und auf dem Server ohnehin vertraut ist, kennt sie.
      --
      -- Bei budget_subscriptions liegt die Spalte dagegen in einer Zeile, die
      -- owner_id und visibility schon hat - sie folgt ihnen ohne Zutun.
      ALTER TABLE inventory_items      ADD COLUMN account_username TEXT;
      ALTER TABLE budget_subscriptions ADD COLUMN account_username TEXT;
    `,
  };
