// ============================================================================
//  HPCI Toolkit — server
//  The "brain" that sits between the ESP32 devices and the phone web app.
//  Neither the ESPs nor the phones talk to each other directly: everything
//  flows through this server and its SQLite database.
// ============================================================================

const express  = require('express');
const Database = require('better-sqlite3');
const { CATALOG, OUTPUT_CATALOG } = require('./catalog.js');
const { makeEngine } = require('./rituals-engine.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));      // serves the web app from /public

const db = new Database('plants.db');

// ----------------------------------------------------------------------------
//  SCHEMA
//  CREATE TABLE IF NOT EXISTS only creates a table when it's absent — it will
//  NOT add new columns to an existing table. When you add a column here, also
//  run an ALTER TABLE migration on any existing plants.db (or delete it to
//  rebuild fresh). This is the single most common gotcha in this file.
// ----------------------------------------------------------------------------
db.exec(`
  -- every sensor sample an ESP has ever posted
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT, sensor_name TEXT, value REAL, ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  );

  -- a physical device. owner_id is the write-LOCK holder (null = free).
  CREATE TABLE IF NOT EXISTS devices (
    id       TEXT PRIMARY KEY,
    owner_id INTEGER
  );

  -- which user follows which device, and their personal nickname for it
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id   INTEGER,
    device_id TEXT,
    nickname  TEXT,
    PRIMARY KEY (user_id, device_id)
  );

  -- one config per device: the {inputs, outputs} the setup screen produced,
  -- stored as JSON text. The ESP fetches this to configure itself.
  CREATE TABLE IF NOT EXISTS configs (
    device_id  TEXT PRIMARY KEY,
    json       TEXT,
    updated_at INTEGER
  );

  -- desired vs reported state for each output (e.g. an RGB light).
  -- desired = what the app/ritual wants; reported = what the ESP confirms.
  CREATE TABLE IF NOT EXISTS output_states (
    device_id   TEXT,
    output_name TEXT,
    desired     TEXT,
    reported    TEXT,
    updated_at  INTEGER,
    PRIMARY KEY (device_id, output_name)
  );

  -- a ritual DEFINITION (the {devices, start, steps} graph, as JSON).
  -- hidden = 1 is a soft delete: kept for research, not shown in the app.
  CREATE TABLE IF NOT EXISTS rituals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    definition  TEXT,
    created_by  INTEGER,
    created_at  INTEGER,
    hidden      INTEGER DEFAULT 0
  );

  -- a running (or finished) RUN of a ritual. The engine advances these.
  -- current = the step id it's on; wait_until = engine sleeps until this ts;
  -- status_text = a human-readable "what's happening now" for the live view.
  CREATE TABLE IF NOT EXISTS ritual_instances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ritual_id   INTEGER,
    started_by  INTEGER,
    status      TEXT,                  -- 'running' | 'done' | 'failed'
    current     TEXT,
    wait_until  INTEGER,
    state       TEXT,                  -- JSON scratch: saved answers, etc.
    started_at  INTEGER,
    updated_at  INTEGER,
    status_text TEXT
  );

  -- a question awaiting a human answer. Only 'ask' steps create these.
  -- This is the interactive inbox; ritual_events below is the full diary.
  CREATE TABLE IF NOT EXISTS prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER,
    step_id     TEXT,
    started_by  INTEGER,               -- which user should see/answer it
    text        TEXT,
    options     TEXT,                  -- JSON array of answer choices
    answer      TEXT,                  -- the human's reply (null until answered)
    kind        TEXT,                  -- 'ask'
    answered    INTEGER DEFAULT 0,     -- 0 = waiting, 1 = answered/closed
    created_at  INTEGER
  );

  -- the complete diary of everything a ritual run did, in order.
  -- This is the research/debug record AND what the transcript renders.
  CREATE TABLE IF NOT EXISTS ritual_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER,
    step_id     TEXT,
    type        TEXT,                  -- start|say|ask|answer|sense|act|wait|timeout|end
    payload     TEXT,                  -- JSON; shape depends on type
    ts          INTEGER
  );

  CREATE TABLE IF NOT EXISTS plants (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT,
    environment_id INTEGER,           -- optional; null = not in an environment
    created_by     INTEGER,
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS attachments (
    device_id  TEXT PRIMARY KEY,       -- one row per device (a device attaches to ONE target)
    target_type TEXT,                  -- 'plant' | 'environment' | 'human'
    target_id   INTEGER,               -- the id of that plant/environment/(user)
    updated_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS environments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    created_by INTEGER,
    created_at INTEGER
  );

`);

// ----------------------------------------------------------------------------
//  THE RITUAL ENGINE — a heartbeat that advances every running instance by
//  one step each second. Lives in rituals-engine.js; we just start its clock.
// ----------------------------------------------------------------------------
const engine = makeEngine(db);
setInterval(() => engine.tick(), 1000);

// ============================================================================
//  HEALTH / CATALOG
// ============================================================================
app.get('/', (req, res) => res.send('the plant server is awake'));

// the menus of available sensors/outputs the setup screen offers
app.get('/catalog',        (req, res) => res.json(CATALOG));
app.get('/output-catalog', (req, res) => res.json(OUTPUT_CATALOG));

// ============================================================================
//  USERS
// ============================================================================

// create-or-fetch a user by name (INSERT OR IGNORE makes re-login idempotent)
app.post('/users', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(req.body.name);
  res.json(db.prepare('SELECT * FROM users WHERE name = ?').get(req.body.name));
});

app.get('/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY name').all());
});


// ============================================================================
//  PLANTS 
// ============================================================================

// register (name) a new plant — the first act of relationship
app.post('/plants', (req, res) => {
  const info = db.prepare('INSERT INTO plants (name, environment_id, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(req.body.name, req.body.environment_id || null, req.body.user_id, Date.now());
  res.json({ id: info.lastInsertRowid, name: req.body.name });
});

// a user's plants
app.get('/plants', (req, res) => {
  res.json(db.prepare('SELECT * FROM plants WHERE created_by = ? ORDER BY created_at DESC')
    .all(req.query.user_id));
});

// which devices are attached to a given plant
app.get('/plants/:id/devices', (req, res) => {
  const plant = db.prepare('SELECT environment_id FROM plants WHERE id = ?').get(req.params.id);
  const envId = plant ? plant.environment_id : null;
  res.json(db.prepare(`
    SELECT device_id, target_type FROM attachments
    WHERE (target_type='plant' AND target_id=?) OR (target_type='environment' AND target_id=?)
  `).all(req.params.id, envId));
});
app.post('/devices/:id/detach', (req, res) => {
  db.prepare('DELETE FROM attachments WHERE device_id = ?').run(req.params.id);
  res.json({ ok: true });
});
// name a new environment (a collection of plants sharing conditions)
app.post('/environments', (req, res) => {
  const info = db.prepare('INSERT INTO environments (name, created_by, created_at) VALUES (?, ?, ?)')
    .run(req.body.name, req.body.user_id, Date.now());
  res.json({ id: info.lastInsertRowid, name: req.body.name });
});

app.get('/environments', (req, res) => {
  res.json(db.prepare('SELECT * FROM environments WHERE created_by = ? ORDER BY created_at DESC')
    .all(req.query.user_id));
});
app.get('/environments/:id/plants', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM plants WHERE environment_id = ?').all(req.params.id));
});
// assign a plant to an environment (or null to remove it)
app.put('/plants/:id/environment', (req, res) => {
  const envId = req.body.environment_id ? Number(req.body.environment_id) : null;
  db.prepare('UPDATE plants SET environment_id = ? WHERE id = ?').run(envId, req.params.id);
  res.json({ ok: true });
});

app.get('/environments/:id/devices', (req, res) => {
  res.json(db.prepare(`SELECT device_id FROM attachments
    WHERE target_type = 'environment' AND target_id = ?`).all(req.params.id));
});
// all sensor names available for a plant = union across its devices (own + environment's)
app.get('/plants/:id/sensors', (req, res) => {
  const plant = db.prepare('SELECT environment_id FROM plants WHERE id = ?').get(req.params.id);
  const envId = plant ? plant.environment_id : null;
  const devices = db.prepare(`
    SELECT device_id FROM attachments
    WHERE (target_type='plant' AND target_id=?) OR (target_type='environment' AND target_id=?)
  `).all(req.params.id, envId).map(r => r.device_id);
  if (devices.length === 0) return res.json([]);

  const placeholders = devices.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT sensor_name FROM readings WHERE device_id IN (${placeholders})`
  ).all(...devices);
  res.json(rows.map(r => r.sensor_name));
});

// readings for one sensor on a plant (across all its devices), oldest first
app.get('/plants/:id/readings', (req, res) => {
  const sensor = req.query.sensor;
  const plant = db.prepare('SELECT environment_id FROM plants WHERE id = ?').get(req.params.id);
  const envId = plant ? plant.environment_id : null;
  const devices = db.prepare(`
    SELECT device_id FROM attachments
    WHERE (target_type='plant' AND target_id=?) OR (target_type='environment' AND target_id=?)
  `).all(req.params.id, envId).map(r => r.device_id);
  if (devices.length === 0) return res.json([]);

  const placeholders = devices.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM readings WHERE sensor_name = ? AND device_id IN (${placeholders}) ORDER BY ts ASC`
  ).all(sensor, ...devices);
  res.json(rows);
});
// ============================================================================
//  DEVICES — subscription, config, sensors
// ============================================================================

// a user follows a device under a personal nickname (re-subscribe updates it)
app.post('/devices/:id/subscribe', (req, res) => {
  const device_id = req.params.id;
  const nickname  = req.body.nickname || device_id;
  db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(device_id);
  db.prepare(`
    INSERT INTO subscriptions (user_id, device_id, nickname) VALUES (?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET nickname = excluded.nickname
  `).run(req.body.user_id, device_id, nickname);
  res.json({ ok: true, subscribed: device_id, nickname });
});

// the devices a user follows (joined to their nicknames)
app.get('/users/:id/devices', (req, res) => {
  res.json(db.prepare(`
    SELECT devices.id, subscriptions.nickname AS name
    FROM devices
    JOIN subscriptions ON devices.id = subscriptions.device_id
    WHERE subscriptions.user_id = ?
  `).all(req.params.id));
});

// the distinct sensor names this device has actually reported
app.get('/devices/:id/sensors', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT sensor_name FROM readings WHERE device_id = ?').all(req.params.id);
  res.json(rows.map(r => r.sensor_name));
});

// read a device's config — called by BOTH the setup screen and the ESP itself.
// A device with no config yet returns a sensible empty shape.
app.get('/devices/:id/config', (req, res) => {
  const row = db.prepare('SELECT json FROM configs WHERE device_id = ?').get(req.params.id);
  if (!row) return res.json({ device_id: req.params.id, sample_interval_ms: 5000, inputs: [], outputs: [] });
  res.json(JSON.parse(row.json));
});

// the app saves the whole config object at once (upsert)
app.put('/devices/:id/config', (req, res) => {
  const config = req.body;
  config.device_id = req.params.id;        // keep the id inside in sync with the URL
  db.prepare(`
    INSERT INTO configs (device_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(req.params.id, JSON.stringify(config), Date.now());
  res.json({ ok: true });
});

// attach a device to a target (plant / environment / human). Upsert: re-attaching moves it.
app.post('/devices/:id/attach', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(req.params.id);
  db.prepare(`
    INSERT INTO attachments (device_id, target_type, target_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      target_type = excluded.target_type, target_id = excluded.target_id, updated_at = excluded.updated_at
  `).run(req.params.id, req.body.target_type, req.body.target_id, Date.now());
  res.json({ ok: true });
});

// ============================================================================
//  READINGS — the ESP posts sensor samples; the app reads them back
// ============================================================================

// batch insert: the ESP posts { device_id, readings: [{name, value}, ...] }
app.post('/readings', (req, res) => {
  const ts = Date.now();
  const insert = db.prepare('INSERT INTO readings (device_id, sensor_name, value, ts) VALUES (?, ?, ?, ?)');
  for (const r of req.body.readings) insert.run(req.body.device_id, r.name, r.value, ts);
  res.json({ ok: true, stored: req.body.readings.length });
});

app.get('/readings/:device_id', (req, res) => {
  res.json(db.prepare('SELECT * FROM readings WHERE device_id = ? ORDER BY ts ASC').all(req.params.device_id));
});

// ============================================================================
//  OUTPUTS + THE WRITE-LOCK
//  Only one user may CONTROL a device's outputs at a time. owner_id is that
//  lock. Reading never needs a lock; writing always does.
// ============================================================================

// app sets a desired output value — guarded: only the lock-holder may write.
// NOTE: owner_id and user_id are both numbers here; keep them the same type.
app.put('/devices/:id/outputs/:name/desired', (req, res) => {
  const { id, name } = req.params;
  const dev = db.prepare('SELECT owner_id FROM devices WHERE id = ?').get(id);
  if (!dev || dev.owner_id !== req.body.user_id)
    return res.status(403).json({ ok: false, error: 'You do not hold the control lock for this device.' });

  db.prepare(`
    INSERT INTO output_states (device_id, output_name, desired, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, output_name) DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at
  `).run(id, name, JSON.stringify(req.body.color), Date.now());
  res.json({ ok: true });
});

// ESP fetches all desired outputs as { outputName: {r,g,b}, ... }
app.get('/devices/:id/outputs/desired', (req, res) => {
  const rows = db.prepare('SELECT output_name, desired FROM output_states WHERE device_id = ?').all(req.params.id);
  const out = {};
  for (const row of rows) if (row.desired) out[row.output_name] = JSON.parse(row.desired);
  res.json(out);
});

// ESP reports what it actually applied
app.put('/devices/:id/outputs/:name/reported', (req, res) => {
  const { id, name } = req.params;
  db.prepare(`
    INSERT INTO output_states (device_id, output_name, reported, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, output_name) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at
  `).run(id, name, JSON.stringify(req.body), Date.now());
  res.json({ ok: true });
});

// app reads desired + reported together (to show "asked for X, device confirms Y")
app.get('/devices/:id/outputs/state', (req, res) => {
  const rows = db.prepare('SELECT * FROM output_states WHERE device_id = ?').all(req.params.id);
  res.json(rows.map(r => ({
    output_name: r.output_name,
    desired:  r.desired  ? JSON.parse(r.desired)  : null,
    reported: r.reported ? JSON.parse(r.reported) : null
  })));
});

// claim the lock — ATOMIC: the WHERE clause only matches if it's free or ours,
// so two simultaneous claims can't both succeed.
app.post('/devices/:id/claim', (req, res) => {
  const userId = req.body.user_id;
  db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(req.params.id);
  const result = db.prepare(`
    UPDATE devices SET owner_id = ?
    WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)
  `).run(userId, req.params.id, userId);

  if (result.changes === 1) return res.json({ ok: true, owner_id: userId });
  const dev   = db.prepare('SELECT owner_id FROM devices WHERE id = ?').get(req.params.id);
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(dev.owner_id);
  res.status(409).json({ ok: false, held_by: owner ? owner.name : 'someone else' });
});

// release the lock — only the owner can (the owner_id = ? guard ensures it)
app.post('/devices/:id/release', (req, res) => {
  const result = db.prepare('UPDATE devices SET owner_id = NULL WHERE id = ? AND owner_id = ?')
    .run(req.params.id, req.body.user_id);
  res.json({ ok: result.changes === 1 });
});

app.get('/devices/:id/owner', (req, res) => {
  const dev = db.prepare('SELECT owner_id FROM devices WHERE id = ?').get(req.params.id);
  res.json({ owner_id: dev ? dev.owner_id : null });
});

// ============================================================================
//  RITUALS — definitions (the graphs participants build)
// ============================================================================

// save a new ritual definition
app.post('/rituals', (req, res) => {
  const info = db.prepare('INSERT INTO rituals (name, definition, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(req.body.name, JSON.stringify(req.body.definition), req.body.user_id, Date.now());
  res.json({ id: info.lastInsertRowid });
});

// list a user's own (non-hidden) rituals, paginated 4 at a time.
// We fetch limit+1 rows so we can tell the app whether another page exists.
app.get('/rituals', (req, res) => {
  const limit  = parseInt(req.query.limit  || '4', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT id, name, definition, created_by FROM rituals
    WHERE hidden = 0 AND created_by = ?
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(req.query.user_id, limit + 1, offset);
  res.json({
    rituals: rows.slice(0, limit).map(r => ({ ...r, definition: JSON.parse(r.definition) })),
    hasMore: rows.length > limit,
    offset
  });
});

// soft delete: hide from the app but keep the row (and its run history)
app.post('/rituals/:id/hide', (req, res) => {
  db.prepare('UPDATE rituals SET hidden = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================================
//  RITUALS — running them (instances), and stopping them
// ============================================================================

// start a ritual: claim its write-devices ALL-OR-NOTHING, then create the run.
// If any write-device is locked by someone else, roll back and refuse (409).
app.post('/rituals/:id/start', (req, res) => {
  const userId = req.body.user_id;
  const row = db.prepare('SELECT * FROM rituals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such ritual' });
  const def = JSON.parse(row.definition);

  const writeDevices = Object.values(def.devices || {}).filter(d => d.role === 'write').map(d => d.device_id);

  const claimed = [];
  for (const deviceId of writeDevices) {
    db.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(deviceId);
    const r = db.prepare(`
      UPDATE devices SET owner_id = ?
      WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)
    `).run(userId, deviceId, userId);

    if (r.changes === 1) { claimed.push(deviceId); }
    else {
      // roll back everything we claimed so we don't leave half-held locks
      for (const c of claimed)
        db.prepare('UPDATE devices SET owner_id = NULL WHERE id = ? AND owner_id = ?').run(c, userId);
      const dev    = db.prepare('SELECT owner_id FROM devices WHERE id = ?').get(deviceId);
      const holder = db.prepare('SELECT name FROM users WHERE id = ?').get(dev.owner_id);
      return res.status(409).json({ error: `Can't start — ${deviceId} is controlled by ${holder ? holder.name : 'someone else'}` });
    }
  }

  const info = db.prepare(`
    INSERT INTO ritual_instances (ritual_id, started_by, status, current, wait_until, state, started_at, updated_at)
    VALUES (?, ?, 'running', ?, 0, '{}', ?, ?)
  `).run(row.id, userId, def.start, Date.now(), Date.now());

  db.prepare(`INSERT INTO ritual_events (instance_id, step_id, type, payload, ts) VALUES (?, NULL, 'start', ?, ?)`)
    .run(info.lastInsertRowid, JSON.stringify({ ritual: row.name }), Date.now());

  res.json({ instance_id: info.lastInsertRowid, status: 'running' });
});

// list a user's runs, newest first, paginated (default 4 — what the app uses)
app.get('/instances', (req, res) => {
  const limit  = parseInt(req.query.limit  || '4', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT ritual_instances.*, rituals.name AS ritual_name
    FROM ritual_instances JOIN rituals ON rituals.id = ritual_instances.ritual_id
    WHERE ritual_instances.started_by = ?
    ORDER BY ritual_instances.started_at DESC
    LIMIT ? OFFSET ?
  `).all(req.query.user_id, limit + 1, offset);
  res.json({ runs: rows.slice(0, limit), hasMore: rows.length > limit, offset });
});

// one run's current state (for the live banner + transcript header)
app.get('/instances/:id', (req, res) => {
  res.json(db.prepare(`
    SELECT ritual_instances.*, rituals.name AS ritual_name
    FROM ritual_instances JOIN rituals ON rituals.id = ritual_instances.ritual_id
    WHERE ritual_instances.id = ?
  `).get(req.params.id) || null);
});

// one run's full event diary (the transcript)
app.get('/instances/:id/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM ritual_events WHERE instance_id = ? ORDER BY ts ASC')
    .all(req.params.id).map(e => ({ ...e, payload: JSON.parse(e.payload) })));
});

// stop a running ritual: mark done AND release the write-locks it held.
// (start acquires the locks; stop must release them — the mirror image.)
app.post('/instances/:id/stop', (req, res) => {
  const inst = db.prepare('SELECT * FROM ritual_instances WHERE id = ?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'no such instance' });

  db.prepare("UPDATE ritual_instances SET status = 'done' WHERE id = ?").run(inst.id);

  const def = JSON.parse(db.prepare('SELECT definition FROM rituals WHERE id = ?').get(inst.ritual_id).definition);
  for (const d of Object.values(def.devices || {}))
    if (d.role === 'write')
      db.prepare('UPDATE devices SET owner_id = NULL WHERE id = ? AND owner_id = ?').run(d.device_id, inst.started_by);

  db.prepare(`INSERT INTO ritual_events (instance_id, step_id, type, payload, ts) VALUES (?, NULL, 'end', ?, ?)`)
    .run(inst.id, JSON.stringify({ stopped: true }), Date.now());
  res.json({ ok: true });
});

// ============================================================================
//  PROMPTS — questions awaiting a human answer
// ============================================================================

// the questions this user must answer — ONLY for still-running instances,
// so a stopped/abandoned ritual's questions don't linger in the prompt box.
app.get('/users/:id/prompts', (req, res) => {
  const rows = db.prepare(`
    SELECT prompts.* FROM prompts
    JOIN ritual_instances ON ritual_instances.id = prompts.instance_id
    WHERE prompts.started_by = ? AND prompts.answered = 0
      AND ritual_instances.status = 'running'
    ORDER BY prompts.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(p => ({ ...p, options: p.options ? JSON.parse(p.options) : [] })));
});

// the human answers; the engine notices on its next tick and advances
app.post('/prompts/:id/answer', (req, res) => {
  db.prepare('UPDATE prompts SET answer = ?, answered = 1 WHERE id = ?').run(req.body.answer, req.params.id);
  res.json({ ok: true });
});

// ============================================================================
app.listen(3000, () => console.log('listening on http://localhost:3000'));