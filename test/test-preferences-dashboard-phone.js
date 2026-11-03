/**
 * Test: Separate phone tile arrangement for the Overview (#2109)
 *
 * A per-user `dashboard_widgets_phone` key stores {id, visible, order} only
 * (no size, no options) and is independent of the desktop arrangement.
 * When no phone arrangement has been saved, `dashboard_follows_phone_default`
 * is true and `dashboard_widgets_phone` is null, meaning the phone follows
 * the desktop.  Once saved it is `false`.  Sending null clears it again.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';

const { get } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentUserId = 1;
let currentRole = 'member';

const PHONE_WIDGETS = [
  { id: 'tasks', visible: true, order: 0 },
  { id: 'calendar', visible: false, order: 1 },
];

const DESKTOP_WIDGETS = [
  { id: 'tasks', visible: true, order: 0, size: '2x2' },
  { id: 'weather', visible: true, order: 1, size: '1x1' },
];

function clearPhonePreferences() {
  get().prepare(`
    DELETE FROM sync_config
    WHERE key LIKE 'dashboard_widgets_phone:user:%'
  `).run();
}

function phoneValue(userId) {
  return get().prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(`dashboard_widgets_phone:user:${userId}`)?.value ?? null;
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = currentUserId;
    req.authRole = currentRole;
    next();
  });
  app.use('/', preferencesRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const read = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;

const write = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()).data };
};

test.beforeEach(() => {
  clearPhonePreferences();
  currentUserId = 1;
  currentRole = 'member';
});

test('without a phone arrangement, follows_phone_default is true and phone config is null', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const data = await read(baseUrl);
    assert.equal(data.dashboard_follows_phone_default, true);
    assert.equal(data.dashboard_widgets_phone, null);
  } finally {
    await close();
  }
});

test('saving a phone arrangement sets follows_phone_default to false', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const saved = await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.dashboard_follows_phone_default, false);
    assert.ok(Array.isArray(saved.data.dashboard_widgets_phone));
    assert.deepEqual(
      saved.data.dashboard_widgets_phone.map((w) => w.id),
      ['tasks', 'calendar'],
    );
  } finally {
    await close();
  }
});

test('phone arrangement is read back after save', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });
    const data = await read(baseUrl);
    assert.equal(data.dashboard_follows_phone_default, false);
    assert.deepEqual(data.dashboard_widgets_phone, PHONE_WIDGETS);
  } finally {
    await close();
  }
});

test('phone arrangement strips size and options, keeping only id/visible/order', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const withExtras = [
      { id: 'tasks', visible: true, order: 0, size: '2x2', options: { scope: 'mine' } },
    ];
    const saved = await write(baseUrl, { dashboard_widgets_phone: withExtras });
    assert.equal(saved.status, 200);
    const widget = saved.data.dashboard_widgets_phone[0];
    assert.equal('size' in widget, false, 'size must be stripped from phone config');
    assert.equal('options' in widget, false, 'options must be stripped from phone config');
    assert.deepEqual(widget, { id: 'tasks', visible: true, order: 0 });
  } finally {
    await close();
  }
});

test('phone arrangement is per-user: saving for user 1 does not affect user 2', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentUserId = 1;
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });

    currentUserId = 2;
    const other = await read(baseUrl);
    assert.equal(other.dashboard_follows_phone_default, true);
    assert.equal(other.dashboard_widgets_phone, null);
  } finally {
    await close();
  }
});

test('saving desktop arrangement does not touch phone arrangement', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });
    await write(baseUrl, { dashboard_widgets: DESKTOP_WIDGETS });

    const data = await read(baseUrl);
    assert.equal(data.dashboard_follows_phone_default, false);
    assert.deepEqual(data.dashboard_widgets_phone, PHONE_WIDGETS);
  } finally {
    await close();
  }
});

test('resetting phone arrangement with null clears it and restores follows_phone_default', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });
    assert.ok(phoneValue(1), 'phone value must exist before reset');

    const reset = await write(baseUrl, { dashboard_widgets_phone: null });
    assert.equal(reset.status, 200);
    assert.equal(phoneValue(1), null, 'phone value must be deleted after reset');
    assert.equal(reset.data.dashboard_follows_phone_default, true);
    assert.equal(reset.data.dashboard_widgets_phone, null);
  } finally {
    await close();
  }
});

test('phone arrangement rejects non-array input', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await write(baseUrl, { dashboard_widgets_phone: {} })).status, 400);
    assert.equal((await write(baseUrl, { dashboard_widgets_phone: 'tasks' })).status, 400);
    assert.equal(phoneValue(1), null, 'rejected input must not be persisted');
  } finally {
    await close();
  }
});

test('phone arrangement rejects invalid widget ids', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal(
      (await write(baseUrl, { dashboard_widgets_phone: [{ id: '../weather', visible: true, order: 0 }] })).status,
      400,
    );
    assert.equal(phoneValue(1), null, 'rejected input must not be persisted');
  } finally {
    await close();
  }
});

test('saving phone arrangement does not touch the desktop arrangement', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets: DESKTOP_WIDGETS });
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });

    const data = await read(baseUrl);
    assert.deepEqual(data.dashboard_widgets, DESKTOP_WIDGETS, 'desktop arrangement unchanged after phone save');
    assert.deepEqual(data.dashboard_widgets_phone, PHONE_WIDGETS);
  } finally {
    await close();
  }
});

test('resetting phone arrangement does not touch the desktop arrangement', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await write(baseUrl, { dashboard_widgets: DESKTOP_WIDGETS });
    await write(baseUrl, { dashboard_widgets_phone: PHONE_WIDGETS });
    await write(baseUrl, { dashboard_widgets_phone: null });

    const data = await read(baseUrl);
    assert.deepEqual(data.dashboard_widgets, DESKTOP_WIDGETS, 'desktop arrangement unchanged after phone reset');
    assert.equal(data.dashboard_widgets_phone, null);
  } finally {
    await close();
  }
});

test('phone arrangement survives a round-trip with a module-extension widget id', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const withExtension = [
      { id: 'tasks', visible: true, order: 0 },
      { id: 'my-addon:chart', visible: true, order: 1 },
    ];
    const saved = await write(baseUrl, { dashboard_widgets_phone: withExtension });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      saved.data.dashboard_widgets_phone.map((w) => w.id),
      ['tasks', 'my-addon:chart'],
    );
  } finally {
    await close();
  }
});
