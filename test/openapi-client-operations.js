/**
 * Die Operationen, aus denen ein nativer Client seine Modelle erzeugt. Zwei Suiten
 * lesen die Liste: `test:openapi-client-contract` prueft die Spec, und
 * `test:openapi-client-responses` faehrt jede davon gegen einen echten Server.
 */
export const CLIENT_OPERATIONS = [
  // Instanz
  ['get', '/api/v1/version'],
  // Anmeldung
  ['post', '/api/v1/auth/login'],
  ['post', '/api/v1/auth/2fa/verify'],
  ['get', '/api/v1/auth/me'],
  ['get', '/api/v1/auth/oidc/config'],
  // Geraete
  ['post', '/api/v1/auth/devices'],
  ['get', '/api/v1/auth/devices'],
  ['delete', '/api/v1/auth/devices/current'],
  ['delete', '/api/v1/auth/devices/{id}'],
  ['post', '/api/v1/auth/devices/pair/redeem'],
  // Uebersicht
  ['get', '/api/v1/dashboard'],
  // Aufgaben
  ['get', '/api/v1/tasks'],
  ['post', '/api/v1/tasks'],
  ['get', '/api/v1/tasks/meta/options'],
  ['get', '/api/v1/tasks/{id}'],
  ['put', '/api/v1/tasks/{id}'],
  ['delete', '/api/v1/tasks/{id}'],
  ['patch', '/api/v1/tasks/{id}/status'],
  ['patch', '/api/v1/tasks/{id}/check'],
  // Einkauf
  ['get', '/api/v1/shopping'],
  ['post', '/api/v1/shopping'],
  ['get', '/api/v1/shopping/versions'],
  ['get', '/api/v1/shopping/suggestions'],
  ['get', '/api/v1/shopping/categories'],
  ['get', '/api/v1/shopping/{listId}/items'],
  ['post', '/api/v1/shopping/{listId}/items'],
  ['patch', '/api/v1/shopping/items/{itemId}'],
  ['delete', '/api/v1/shopping/items/{itemId}'],
  ['delete', '/api/v1/shopping/{listId}/items/checked'],
  // Kalender
  ['get', '/api/v1/calendar'],
  ['post', '/api/v1/calendar'],
  ['get', '/api/v1/calendar/upcoming'],
  ['get', '/api/v1/calendar/calendars'],
  ['get', '/api/v1/calendar/{id}'],
  ['put', '/api/v1/calendar/{id}'],
  ['delete', '/api/v1/calendar/{id}'],
  // Erinnerungen
  ['get', '/api/v1/reminders/upcoming'],
  ['get', '/api/v1/reminders/pending'],
  ['patch', '/api/v1/reminders/{id}/dismiss'],
];
