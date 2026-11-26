// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 250,
    description: 'housekeeping: open payment tasks belong to the adults who pay',
    // DER OFFENE ALTBESTAND DER ZAHLUNGSAUFGABEN (R20, Ulas 2026-10-17). Seit
    // R20 entsteht eine Zahlungsaufgabe auf `assignees`, zugewiesen der Person,
    // die eincheckt (wenn sie Betraege sehen darf), und den aktiven Admins.
    // Aeltere stehen auf `all` und nennen den Lohn jedem Konto mit
    // Aufgabenrecht, auch einem Kind ohne `housekeeping_view_amounts`.
    //
    // Nachgezogen werden nur OFFENE (nicht erledigt, nicht archiviert), die
    // ueber `housekeeping_work_sessions.payment_task_id` verknuepft sind und
    // noch auf `all` stehen. Erledigte bleiben stehen (Ulas' Entscheidung);
    // sie zieht das naechste Bearbeiten ihres Besuchs nach. Gibt es fuer eine
    // Aufgabe niemanden, dem sie gehoeren darf (Ersteller ohne Betragsrecht und
    // kein aktiver Admin), wird sie privat fuer die Erstellerin, ohne
    // Zuweisungen und ohne Beschreibung (die nennt den Lohn) - nie `all`.
    //
    // EINGEFROREN - NIE AN DIE LAUFZEITREGEL ANGLEICHEN. Die Regel steht hier
    // als selbsttragende Kopie von services/payment-task-audience.js im Stand
    // von Version 250, und sie liest nur Tabellen und Spalten, die es bei 250
    // gibt. Eine Migration muss fuer immer dasselbe tun: rief sie die
    // Laufzeitregel auf, aenderte jede spaetere Aenderung dort rueckwirkend,
    // was 250 auf einer noch nicht migrierten Installation tut, und eine
    // Spalte, die erst eine juengere Migration anlegt, braeche das
    // Durchmigrieren alter Installationen ab. Dass beide HEUTE dasselbe
    // ergeben, haelt der Aequivalenztest in test/test-payment-task-backfill.js;
    // weicht die Laufzeitregel spaeter bewusst ab, wird dieser Test angepasst,
    // nicht diese Migration. Wiederholt laufen aendert nichts, die Auswahl
    // trifft nur `all`.
    up(database) {
      const FAMILY_ROLES_AT_250 = new Set(['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other']);
      const capabilityRow = database.prepare(`
        SELECT access FROM access_permissions
        WHERE subject_type = ? AND subject_id = ? AND resource_type = 'capability'
          AND resource_key = 'housekeeping_view_amounts' AND access IN ('none', 'allow')
      `);
      // Betragsrecht wie resolvePermissions() bei 250: Admin immer, sonst
      // Standard `allow`, dann das Rollenprofil, dann die Mitglied-Zeile.
      const seesAmounts = (user) => {
        if (user.role === 'admin') return true;
        let access = 'allow';
        if (user.family_role && FAMILY_ROLES_AT_250.has(user.family_role)) {
          access = capabilityRow.get('role', user.family_role)?.access ?? access;
        }
        access = capabilityRow.get('user', String(user.id))?.access ?? access;
        return access === 'allow';
      };
      // Admins als Haushaltsmitglieder, wie householdMemberSql() bei 250 (aktiv,
      // kein Hauspersonal, kein Gast, kein Wandtablett) - als Text eingefroren.
      // Die Zuweisung schreibt die Datenbank selbst (INSERT ... SELECT), die
      // erste Admin-Person holt eine Einzelzeile.
      const ADMIN_MEMBER_AT_250 = `u.role = 'admin' AND u.deactivated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM display_accounts da WHERE da.user_id = u.id)`;
      const firstAdmin = database.prepare(`
        SELECT u.id FROM users u WHERE ${ADMIN_MEMBER_AT_250} ORDER BY u.id ASC LIMIT 1
      `);
      const assignAdmins = database.prepare(`
        INSERT OR IGNORE INTO task_assignments (task_id, user_id)
        SELECT ?, u.id FROM users u WHERE ${ADMIN_MEMBER_AT_250}
      `);
      const tasks = database.prepare(`
        SELECT DISTINCT t.id, t.created_by FROM housekeeping_work_sessions s
        JOIN tasks t ON t.id = s.payment_task_id
        WHERE t.visibility = 'all' AND t.status <> 'done' AND t.archived_at IS NULL
        ORDER BY t.id
      `).all();
      const readUser = database.prepare('SELECT id, role, family_role, deactivated_at FROM users WHERE id = ?');
      const update = database.prepare(`
        UPDATE tasks SET visibility = 'assignees', created_by = ?, assigned_to = ? WHERE id = ?
      `);
      const clear = database.prepare('DELETE FROM task_assignments WHERE task_id = ?');
      const closeTask = database.prepare(`
        UPDATE tasks SET visibility = 'private', assigned_to = NULL, description = NULL WHERE id = ?
      `);
      const assign = database.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
      for (const task of tasks) {
        const creator = task.created_by == null ? null : readUser.get(task.created_by);
        const creatorPays = Boolean(creator && creator.deactivated_at == null && seesAmounts(creator));
        const owner = creatorPays ? creator.id : firstAdmin.get()?.id;
        if (owner == null) {
          // Niemand, dem sie gehoeren darf (kein aktiver Admin, Erstellerin
          // ohne Betragsrecht): schliessen statt auf `all` lassen - privat fuer
          // die Erstellerin, ohne Zuweisungen und ohne die Beschreibung, die
          // den Lohn nennt (wie normalizePaymentTaskAudience, R20).
          closeTask.run(task.id);
          clear.run(task.id);
          continue;
        }
        update.run(owner, owner, task.id);
        clear.run(task.id);
        if (creatorPays) assign.run(task.id, creator.id);
        assignAdmins.run(task.id);
      }
    },
  };
