/**
 * Modul: requireAdmin-Middleware
 * Zweck: Admin-Gate für Routen, die Konfiguration schreiben.
 *
 * Steht bewusst hier und nicht in server/auth.js: dieses Modul ist frei von
 * Seiteneffekten. auth.js prüft beim Laden SESSION_SECRET und wirft ohne, sodass
 * jeder Router, der von dort nur das Admin-Gate zieht, in Tests eine vollständige
 * Umgebung erzwingen würde, obwohl er nichts davon braucht. auth.js exportiert
 * diese Funktion unverändert weiter - Bestandsimporte bleiben gültig.
 */

/**
 * Ob die Anfrage mit Admin-Rolle kommt. `requireAuth` legt die geltende Rolle
 * für Session und API-Token gleichermaßen in `req.authRole` ab.
 */
export function isAdminRequest(req) {
  return req.authRole === 'admin';
}

/**
 * Lässt nur Admins durch; alle anderen erhalten 403. Ein angemeldetes Gerät
 * bekommt seinen eigenen Grund: die Person mag Admin sein, nur eben nicht von
 * diesem Gerät aus (siehe `requireAuth` in server/auth.js).
 */
export function requireAdmin(req, res, next) {
  if (isAdminRequest(req)) {
    return next();
  }
  if (req.authDeviceId != null) {
    return res.status(403).json({ error: 'This is not available on a signed-in device.', code: 403, reason: 'device_credential' });
  }
  res.status(403).json({ error: 'Permission denied.', code: 403 });
}
