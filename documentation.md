# HPCI Toolkit — Technical Documentation

Complete reference for the Human–Plant–Computer Interaction toolkit: architecture,
data model, API, the ritual system, the firmware, the web app, and the design
decisions behind them. This documents the system as built — every endpoint, field,
and pin here is taken from the actual code.

> For a hands-on "get it running and add your own sensors" walkthrough, see the
> **Tutorial**. This document is the reference: the *what* and the *why*, in full.

---

## Contents

1. [Overview & philosophy](#1-overview--philosophy)
2. [System architecture](#2-system-architecture)
3. [Data model](#3-data-model)
4. [HTTP API reference](#4-http-api-reference)
5. [The ritual system](#5-the-ritual-system)
6. [The firmware](#6-the-firmware)
7. [The web app](#7-the-web-app)
8. [The catalog schema](#8-the-catalog-schema)
9. [Design decisions & rationale](#9-design-decisions--rationale)
10. [Glossary](#10-glossary)
11. [Known limitations & gotchas](#11-known-limitations--gotchas)

---

## 1. Overview & philosophy

The HPCI Toolkit lets workshop participants build small electronic systems around
living plants — sensing their signals, driving lights in response, and composing
**rituals** of care — entirely from a phone, with no code and no laptop.

Three design commitments shape everything:

- **No-code for participants.** All configuration (which sensors, which pins, what a
  ritual does) happens through the web app. The hardware self-configures from the
  server; participants never edit code or flash boards during a workshop.
- **Decoupled by a shared database.** Devices and phones never talk directly. Each
  side reads and writes through one small server, so neither needs to discover or
  address the other. This makes the system robust to flaky networks and easy to reason
  about.
- **A legible record.** Every ritual run keeps a full timestamped diary, presented as
  a readable conversation — useful both to participants (seeing what happened) and as
  research data (response latencies, decisions, sensor values behind each branch).

---

## 2. System architecture

```
   ESP32 device(s)                  Server + SQLite                 Phone web app
   ----------------                 ----------------                --------------
   - read sensors      --POST-->    Node + Express          <--GET-- - device list
   - post readings        /readings  better-sqlite3 (db)    --data-> - live graph
   - poll config       <--GET---    + the ritual engine               - setup screen
       /config                       (tick() every 1s)      <--PUT-- - light control
   - poll outputs      <--GET---                                     - ritual builder
       /outputs/desired                                             - transcripts
   - drive RGB, report --PUT-->
       /outputs/.../reported
```

Three processes, one source of truth (the database):

- **ESP32 firmware** (`firmware/hpci_device/hpci_device.ino`). One generic Arduino
  sketch runs on every board. It fetches its config from the server, reads whatever
  sensors that config lists (each on its own interval), posts readings in batches, and
  polls for desired output states to drive its RGB LED — reporting back what it applied.
- **Server** (`plant-server/server.js`). Node + Express + better-sqlite3. Owns all
  state, serves the static web app, exposes the REST API, and runs the ritual engine on
  a 1-second timer.
- **Web app** (`plant-server/public/`). Plain multi-file JavaScript (no build step),
  with p5.js for the live sensor graph and Mermaid for the ritual state-machine diagram.

**The polling model.** Devices are *pull*-based: they ask the server what to do rather
than being pushed to. The firmware re-fetches config periodically and polls desired
outputs about once a second. This keeps the firmware simple and stateless — the server
is always authoritative, and a device that reboots simply re-fetches and resumes.

---

## 3. Data model

SQLite, defined in `server.js`. Nine tables.

> **Migration note.** `CREATE TABLE IF NOT EXISTS` creates a missing table but never
> alters an existing one. Adding a column to the schema requires an
> `ALTER TABLE … ADD COLUMN` on any existing `plants.db`, or deleting the db to rebuild.

### `readings`
Every sensor sample ever posted.

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `device_id` | TEXT | which device posted it |
| `sensor_name` | TEXT | the reading's name (e.g. `soil`, `air.temperature`) |
| `value` | REAL | the numeric value |
| `ts` | INTEGER | timestamp (ms) |

### `users`
| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `name` | TEXT UNIQUE | login name (no password — a workshop tool) |

### `devices`
One row per physical board.

| column | type | meaning |
|---|---|---|
| `id` | TEXT PK | the device id (e.g. `esp32-plant`) |
| `owner_id` | INTEGER | the **write-lock** holder; `NULL` = free |

### `subscriptions`
Which user follows which device, and their personal nickname for it.

| column | type | meaning |
|---|---|---|
| `user_id` | INTEGER | PK (with device_id) |
| `device_id` | TEXT | PK (with user_id) |
| `nickname` | TEXT | this user's label for the device |

### `configs`
One config per device — the `{inputs, outputs}` the setup screen produced, as JSON.
Read by both the app and the ESP.

| column | type | meaning |
|---|---|---|
| `device_id` | TEXT PK | |
| `json` | TEXT | the full config object as JSON |
| `updated_at` | INTEGER | |

### `output_states`
Desired vs. reported state per output. `desired` = what the app/ritual wants;
`reported` = what the ESP confirms it applied.

| column | type | meaning |
|---|---|---|
| `device_id` | TEXT | PK (with output_name) |
| `output_name` | TEXT | PK (with device_id) |
| `desired` | TEXT | JSON colour, e.g. `{"r":255,"g":0,"b":120}` |
| `reported` | TEXT | JSON colour the ESP confirms |
| `updated_at` | INTEGER | |

### `rituals`
A ritual **definition** — the state-machine graph, as JSON.

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `name` | TEXT | |
| `definition` | TEXT | the `{name, devices, start, steps}` object as JSON |
| `created_by` | INTEGER | author (rituals are private to their author) |
| `created_at` | INTEGER | |
| `hidden` | INTEGER | `1` = soft-deleted (kept for research, hidden in app) |

### `ritual_instances`
A running or finished **run** of a ritual. The engine advances these.

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `ritual_id` | INTEGER | which definition is running |
| `started_by` | INTEGER | who started it (= who holds any locks; runs are private to this user) |
| `status` | TEXT | `running` / `done` / `failed` |
| `current` | TEXT | the step id it's currently on |
| `wait_until` | INTEGER | engine sleeps past this timestamp (waits/timeouts/sense-pacing) |
| `state` | TEXT | JSON scratch (saved answers, etc.) |
| `started_at` | INTEGER | |
| `updated_at` | INTEGER | |
| `status_text` | TEXT | human-readable "what's happening now" for the live view |

### `prompts`
A question awaiting a human answer. Only `ask` steps create these — the interactive
inbox, distinct from the full diary below.

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `instance_id` | INTEGER | which run it belongs to |
| `step_id` | TEXT | which step posted it |
| `started_by` | INTEGER | which user should see/answer it |
| `text` | TEXT | the question |
| `options` | TEXT | JSON array of answer choices |
| `answer` | TEXT | the reply (null until answered) |
| `kind` | TEXT | `ask` |
| `answered` | INTEGER | `0` waiting / `1` answered or closed |
| `created_at` | INTEGER | |

### `ritual_events`
The complete, ordered diary of everything a run did. Both the research/debug record
and the source of the rendered transcript.

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | auto |
| `instance_id` | INTEGER | which run |
| `step_id` | TEXT | which step (null for start/stop) |
| `type` | TEXT | `start`/`say`/`ask`/`answer`/`sense`/`act`/`timeout`/`end` |
| `payload` | TEXT | JSON; shape depends on `type` (see [§5](#5-the-ritual-system)) |
| `ts` | INTEGER | timestamp (ms) |

**Relationships.** A user has many subscriptions (→ devices) and authors many rituals;
a ritual has many instances; an instance has many events and many prompts; a device has
one config and many readings and output_states.

---

## 4. HTTP API reference

All bodies are JSON. Base URL is the server root (e.g. `http://localhost:3000`).

### Health & catalog
| Method | Path | Returns |
|---|---|---|
| GET | `/` | a liveness string |
| GET | `/catalog` | the sensor catalog array |
| GET | `/output-catalog` | the output catalog array |

### Users
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/users` | `{name}` | `{id, name}` (create-or-fetch, idempotent) |
| GET | `/users` | — | all users |

### Devices
| Method | Path | Body | Returns / notes |
|---|---|---|---|
| POST | `/devices/:id/subscribe` | `{user_id, nickname}` | follows a device under a nickname (upsert) |
| GET | `/users/:id/devices` | — | `[{id, name}]` the user's devices (name = their nickname) |
| GET | `/devices/:id/sensors` | — | distinct sensor names this device has reported |
| GET | `/devices/:id/config` | — | the device's config; empty shape if none yet |
| PUT | `/devices/:id/config` | the full config | saves it (upsert). Called by the app's setup screen |

### Readings
| Method | Path | Body | Returns / notes |
|---|---|---|---|
| POST | `/readings` | `{device_id, readings:[{name,value}]}` | batch insert (the ESP posts here) |
| GET | `/readings/:device_id` | — | all readings for a device, oldest first |

### Outputs & the write-lock
| Method | Path | Body | Returns / notes |
|---|---|---|---|
| PUT | `/devices/:id/outputs/:name/desired` | `{user_id, color}` | set desired colour — **403 unless caller holds the lock** |
| GET | `/devices/:id/outputs/desired` | — | `{outputName:{r,g,b}}` (the ESP polls this) |
| PUT | `/devices/:id/outputs/:name/reported` | `{r,g,b}` | the ESP reports what it applied |
| GET | `/devices/:id/outputs/state` | — | desired + reported per output (app shows confirmation) |
| POST | `/devices/:id/claim` | `{user_id}` | take the lock; **409** with `held_by` if someone else has it |
| POST | `/devices/:id/release` | `{user_id}` | release (only the owner can) |
| GET | `/devices/:id/owner` | — | `{owner_id}` (null = free) |

The lock is **atomic**: claim runs `UPDATE devices SET owner_id=? WHERE id=? AND
(owner_id IS NULL OR owner_id=?)`, so two simultaneous claims can't both succeed.

### Rituals (definitions)
| Method | Path | Body / query | Returns / notes |
|---|---|---|---|
| POST | `/rituals` | `{user_id, name, definition}` | save a definition → `{id}` |
| GET | `/rituals` | `?user_id=&offset=&limit=` | `{rituals, hasMore, offset}` — the user's own, non-hidden, paginated |
| POST | `/rituals/:id/hide` | — | soft delete (sets `hidden=1`) |

### Rituals (running them)
| Method | Path | Body / query | Returns / notes |
|---|---|---|---|
| POST | `/rituals/:id/start` | `{user_id}` | claims write-devices all-or-nothing, creates a run → `{instance_id, status}`; **409** if a write-device is locked |
| GET | `/instances` | `?user_id=&offset=&limit=` | `{runs, hasMore, offset}` — the user's runs, newest first |
| GET | `/instances/:id` | — | one run's current state (incl. `status_text`, `ritual_name`) |
| GET | `/instances/:id/events` | — | the run's full event diary (the transcript) |
| POST | `/instances/:id/stop` | — | mark done **and release its write-locks** |

### Prompts
| Method | Path | Body | Returns / notes |
|---|---|---|---|
| GET | `/users/:id/prompts` | — | unanswered questions for this user **whose instance is still running** |
| POST | `/prompts/:id/answer` | `{answer}` | record the answer; the engine picks it up next tick |

The pagination convention (`/rituals`, `/instances`) fetches `limit + 1` rows to set
`hasMore` without a second query, then returns `limit`.

---

## 5. The ritual system

### Definition format
A ritual definition is JSON:

```json
{
  "name": "Morning check",
  "devices": { "d1": { "device_id": "esp32-plant", "role": "write" } },
  "start": "s0",
  "steps": {
    "s0": { "type": "say", "text": "Good morning.", "next": "s1" },
    "s1": { "type": "sense", "device": "d1", "sensor": "soil",
            "op": "<", "value": 1500, "min_recheck_ms": 5000,
            "then": "s2", "else": "s3" },
    "s2": { "type": "ask", "text": "It's dry — water it?",
            "options": ["done","later"], "save_as": "answer2",
            "next": "end",
            "answer_routes": { "done": "end", "later": "s3" } },
    "s3": { "type": "act", "device": "d1", "output": "leaf_light",
            "color": { "r": 0, "g": 180, "b": 80 }, "next": "end" },
    "end": { "type": "end" }
  }
}
```

- **`devices`** maps an **alias** (`d1`) to a real device and a **role** (`read` or
  `write`). Steps reference the alias; the engine resolves it. `write` implies `read`.
- **`start`** is the id of the first step.
- **`steps`** is an id→step map. Steps point to successors by id (`next`, or `then`/
  `else` for sense, or `answer_routes` for a branching ask). `end` is the terminal step.

### Step types
| type | fields | behaviour |
|---|---|---|
| `say` | `text`, `next`, `linger_ms?` | log + show the message, linger (~4s default), then advance |
| `ask` | `text`, `options[]`, `save_as`, `next`, `timeout_ms?`, `on_timeout?`, `answer_routes?` | post a question; on answer, route per `answer_routes[answer]` else `next`; on timeout, `on_timeout` else `next` |
| `wait` | `duration_ms`, `next` | sleep, then advance |
| `act` | `device`, `output`, `color{r,g,b}`, `next` | set the output's desired colour, then advance |
| `sense` | `device`, `sensor`, `op` (`<`/`>`/`=`), `value`, `then`, `else`, `min_recheck_ms?` | read the latest sensor value, compare, branch; if it loops to itself, pace rechecks to `min_recheck_ms` |
| `end` | — | mark the run `done` |

### The engine (`rituals-engine.js`)
`makeEngine(db)` returns `{ tick }`. The server calls `tick()` every second. Each tick:

1. Load all `running` instances.
2. For each (wrapped in try/catch so one failure is isolated as `failed`):
   - Load its ritual definition and current step.
   - **Sleep-guard:** if `wait_until` is in the future, skip — *except* for `ask`,
     which must be polled every tick to catch an answer immediately.
   - Run the step (`runStep`), which returns the next step id or `null` (stay).
   - If it returned a next id, advance `current` and reset `wait_until` to 0.

`runStep` reads/writes everything through the DB; nothing important is in-memory, so a
server restart resumes running rituals where they were.

Two timing mechanisms share `wait_until`:
- **`wait` and `say`** set `wait_until` and stay until it passes (flags `_waiting` /
  `_sayShown`, computed in the tick loop, tell `runStep` the timer elapsed).
- **`ask`** sets `wait_until` as a *timeout deadline* but is still polled every tick.
- **`sense`** sets `wait_until` only when it loops directly back to itself, to pace
  rechecks to the sensor's update rate.

### Event payloads
Each diary entry's `payload` shape by `type`:
- `start` → `{ritual}` · `say` → `{text}` · `ask` → `{text, options}` ·
  `answer` → `{text, answer}` · `act` → `{device, output, color}` ·
  `sense` → `{device, sensor, op, threshold, value, passed}` ·
  `timeout` → `{text}` · `end` → `{}` or `{stopped:true}` (manual stop).

The `sense` payload captures the **value behind each decision** — the heart of the
research record. The transcript view collapses consecutive same-sensor `sense` events
into one summary line (display only; all events stay in the DB).

### The lock contract
Starting a ritual **claims all its `write` devices, all-or-nothing** (rolling back if
any is held by someone else → 409). Stopping it (or `end`) **releases** them. `read`
devices are never locked. This is why start and stop are mirror images.

---

## 6. The firmware

One sketch (`hpci_device.ino`) runs on every board; behaviour is entirely
config-driven. Top-of-file settings: `WIFI_SSID`, `WIFI_PASS`, `SERVER`, `deviceId`.

**Boot (`setup`)**
- Start I²C on pins 21 (SDA) / 22 (SCL).
- Try to initialise the BME680 (`0x77`) and ADS1115 (`0x48`); set `bmeReady` /
  `adsReady` so the board only reads chips it actually has. *The same firmware runs on
  boards with different hardware* — missing chips are simply skipped.
- Connect WiFi, fetch config.
- For each `rgb` output in the config, attach PWM (`ledcAttach`, 5 kHz, 8-bit) on its
  three pins.

**Loop**
- For each input in the config, check its own `interval_ms` against a stored `_last`
  timestamp; only read inputs that are *due*. Read by `source`:
  - `adc` → `analogRead(pin)`
  - `ads1115` → `ads.readADC_Differential_0_1()` → millivolts
  - `i2c` (BME680) → one read yields four values, posted as `name.temperature`,
    `name.humidity`, `name.pressure`, `name.gas`
- Batch all due readings into one POST to `/readings`.
- About once a second, `applyOutputs()`: GET `/outputs/desired`, drive each RGB
  output's three PWM channels, and PUT `/outputs/:name/reported` with what it set.

**To add a new sensor `source`** you add a branch in the loop's read section matching a
new `source` string from the catalog (see the Tutorial for the full walkthrough).

---

## 7. The web app

Plain JavaScript, no build step. **All scripts share one global scope** — that's why a
function in one file is callable from another, and why duplicate function names across
files silently collide. Load order matters: `app.js` first.

| file | responsibility |
|---|---|
| `app.js` | shared state (`currentUser`, `currentDevice`, `currentSensor`), `showView`, login, Mermaid init |
| `devices.js` | the device list, subscribing |
| `device.js` | one device: live graph (p5), output control, the claim/release lock, `hexToRgb` (shared) |
| `setup.js` | the no-code sensor/output setup + the pin allocator |
| `rituals.js` | rituals page, live "now" section, transcript, ritual preview + diagram, the prompt box |
| `builder.js` | the visual ritual builder: draft → validate → compile → save |

**Views** are sibling `<div class="view">` blocks in `index.html`; `showView(id)`
toggles which is `active`. The eight views: login, devices, device, setup, rituals,
builder, transcript, ritual-preview.

**Polling** (timers in `rituals.js`, each guarded to act only when relevant): the
prompt box every 2s (from any view), the rituals badge every 4s, the rituals page every
3s while open, an open transcript every 2s while open. The device graph polls readings
every 2s (`device.js`).

**The builder.** A *draft* (held in the browser) is edited in friendly units, then on
save:
1. **`validateDraft()`** — three tiers (see [§9](#9-design-decisions--rationale)).
2. **`compileDraft()`** — translates draft step ids (`k7`) to engine ids (`s0…sN`),
   minutes → ms, hex → `{r,g,b}`, comma-text → options array, and stamps each `sense`
   step's `min_recheck_ms` from its sensor's catalog interval.
3. POST to `/rituals`.

Steps carry stable ids so pointers survive reordering; the displayed number is just the
current position.

**The transcript** renders the event diary with three "voices" (CSS classes): the
plant/computer in serif (`voice-plant`), the human's answers as a right-aligned bubble
(`voice-human`), and machine actions in mono (`voice-machine`). The **ritual preview**
shows a Mermaid state-machine diagram (generated from the definition's pointers) above a
plain-language step list.

**Theme.** `style.css` is driven by design tokens at the top — a small palette
(`--ink`, `--paper`, `--moss`, `--clay`, `--bark`, `--line`), three type families
(serif / sans / mono), and a spacing scale (`--s1…--s6`). Re-skinning is editing those.

---

## 8. The catalog schema

`catalog.js` exports `{ CATALOG, OUTPUT_CATALOG }`. This is the menu the setup screen
offers — the kinds of sensors/outputs that *exist*, independent of any board.

### A sensor entry (`CATALOG`)
```js
{
  id: "soil_capacitive",          // unique key
  label: "Soil moisture (capacitive)",  // shown in the dropdown
  source: "adc",                  // how the FIRMWARE reads it: adc | i2c | ads1115
  pin_kind: "adc",                // how the APP allocates: adc | i2c | ads_channel | rgb
  default_name: "soil",           // suggested name on add
  unit: "raw",                    // (informational)
  range: [0, 4095],               // (informational)
  interval_ms: 5000,              // how often to read; also paces sense self-loops
  instructions: "… GPIO {pin} …"  // wiring text; {pin} is filled with the allocated pin
}
```

Variations seen in the real catalog:
- **I²C sensor (BME680):** `source:"i2c"`, `pin_kind:"i2c"`, an `address` (`"0x77"`),
  and a `channels` array — one physical sensor that yields several named readings
  (`temperature`, `humidity`, `pressure`, `gas`). No pin is allocated (it shares the bus).
- **External ADC (ADS1115):** `source:"ads1115"`, `pin_kind:"ads_channel"`, an
  `address` (`"0x48"`), a `mode` (`"differential"`), a `channel` (`"0-1"`), and a `gain`.
  Allocated a differential channel-pair, not an ESP pin.

### An output entry (`OUTPUT_CATALOG`)
```js
{
  id: "rgb_led",
  label: "RGB LED",
  type: "rgb",                    // how the firmware drives it (3-channel PWM)
  pin_kind: "rgb",                // allocates THREE output pins together
  default_name: "leaf_light",
  instructions: "… R→GPIO {r}, G→GPIO {g}, B→GPIO {b} …"  // {r}{g}{b} filled in
}
```

### Pin allocation (`setup.js`)
The allocator hands out free slots from fixed pools, recomputed from the current config
each time (so removing a sensor frees its pin):

| `pin_kind` | pool | why |
|---|---|---|
| `adc` | `32, 33, 34, 35, 36, 39` | ADC1 pins only — **ADC2 stops working with WiFi on** |
| `ads_channel` | `"0-1", "2-3"` | the ADS1115's differential pairs |
| `rgb` | `25, 26, 27, 16, 17, 18, 19, 23` | PWM-capable, clear of I²C (21/22) |
| `i2c` | — | shares the bus, no pin allocated |

**`source` and `pin_kind` are the two halves of adding a sensor:** `source` is matched
by a firmware read-handler; `pin_kind` is matched by the allocator. A new analog sensor
reuses `source:"adc"` and needs no firmware change; a genuinely new sensor needs a new
`source` *and* a matching firmware branch.

---

## 9. Design decisions & rationale

**Why a shared database instead of direct device↔phone communication.** Direct
peer-to-peer would need discovery, addressing, and would break on networks that isolate
clients (common on public/venue WiFi). Routing everything through the server makes each
side a simple client of one known endpoint, makes the server the single source of truth,
and lets a rebooted device resume by re-fetching. The cost — a poll-and-store round trip
— is negligible at workshop scale.

**Why config-driven firmware.** One sketch for all boards means no per-board code and no
re-flashing during a workshop. A board's behaviour is data (its config), set from the
phone. The `bmeReady`/`adsReady` flags let the *same* binary run on boards with
different hardware.

**Why a write-lock (not free-for-all).** A shared light with multiple controllers would
flicker chaotically. The atomic lock gives one person control at a time, with a clear UI
of who holds it; reading is always free because it's harmless.

**Why rituals are definitions vs. instances.** Separating the *recipe* (definition) from
each *cooking* (instance) lets one ritual be run many times, each run carrying its own
state, history, and locks — and lets the engine treat "advance every running thing" as a
uniform loop.

**Why soft delete.** A workshop's rituals and runs are research data. Hiding rather than
deleting preserves everything while keeping the participant's view clean; it's also
reversible.

**Why private-per-user.** Each participant sees only their own rituals and runs, matching
how their device list works — a clean, self-contained session per person. (Definitions
filter on `created_by`, runs on `started_by`.)

**The three tiers of ritual safety.** The builder distinguishes what's *decidable* from
what isn't:
1. **Dead ends** — a pointer to nowhere, or END unreachable. Caught by graph traversal.
2. **Structural infinite loops** — a cycle made only of single-exit steps can *never*
   escape; that's decidable, so it's rejected. A cycle containing a multi-exit step
   (`sense`, or a branching `ask`) *might* terminate, so it's allowed.
3. **Behavioural non-termination** — whether a "check until dry" loop ever ends depends
   on the world (will anyone water it?). This is the halting problem — undecidable, and
   often *intentional* (an open-ended vigil). So it's not validated; it's handled at
   runtime by the **stop** button.

**Why the event diary captures sensor values.** Logging *that* a ritual branched isn't
enough for research; logging the value it saw and the conclusion it drew (`sense`
payload) records the *reasoning*. The gap between an `ask` and its `answer` is itself
data — response latency, a measure of attention.

**Why three typographic voices in the transcript.** Encoding *who speaks* in the
typeface (serif = plant/computer, sans bubble = human, mono = machine) makes a log read
as a conversation at a glance, without labels.

---

## 10. Glossary

- **Device** — a physical ESP32 board, identified by a string id.
- **Subscription** — a user following a device under a personal nickname.
- **Config** — a device's `{inputs, outputs}`, produced by setup, obeyed by the firmware.
- **Input / output** — a configured sensor / a configured actuator (the RGB LED).
- **Source** — *how* a sensor is read (`adc`/`i2c`/`ads1115`); matched in firmware.
- **pin_kind** — *what kind of slot* a sensor/output needs; matched by the allocator.
- **Write-lock (`owner_id`)** — exclusive control of a device's outputs.
- **Ritual** — a definition: a state machine of steps.
- **Instance / run** — one execution of a ritual.
- **Step** — a node in the ritual graph (`say`/`ask`/`wait`/`act`/`sense`/`end`).
- **Alias** — a ritual's short handle (`d1`) for a device, mapped in its header.
- **Event** — one entry in a run's diary (`ritual_events`).
- **Prompt** — a question awaiting a human answer.
- **Draft** — a ritual being built in the browser, before validate + compile.

---

## 11. Known limitations & gotchas

- **`CREATE TABLE IF NOT EXISTS` won't add columns.** Migrate with `ALTER TABLE` or
  rebuild the db when the schema changes.
- **Shared global scope / no build step.** Duplicate function names across `public/*.js`
  silently collide (last definition wins). "No error but wrong output" usually means a
  duplicate, a stale view (re-derive on navigation, don't just `showView`), or a name
  clash. **p5.js claims many short globals** (`line`, `text`, `color`, `map`, `random`,
  `width`, `height`) — prefix your own helpers (`eventLine`).
- **Don't re-render an input the user is typing in** — it steals focus. Store on
  `oninput`, rebuild on `onblur` (as the answers field does). Same principle: only touch
  the DOM when the displayed data changed (the prompt box's anti-flicker).
- **The `say` linger relies on `wait_until` being 0 on entry** (advancing resets it).
  Documented in the engine; if a `say` ever fails to linger, that's the place to look.
- **`owner_id` vs `user_id` are compared with `!==`** in the desired-output guard; both
  are numbers as the app sends them. If a user id ever arrived as a string it would fail.
- **Single sensor read drives sense** — `sense` reads only the *latest* reading; if a
  sensor has never reported, the value is null and the comparison fails (takes `else`).
- **Restart Node after server edits; hard-refresh after app edits.** Check the dev
  console (F12) first when something's off.

---

*This documentation describes the toolkit as built. The software is functionally
complete; the remaining work is workshop deployment — a Raspberry Pi access point +
server, wiring tutorial sheets, and a pre-flight checklist.*