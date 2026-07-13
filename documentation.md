# HPCI Toolkit — Technical Documentation

Complete reference for the Human–Plant–Computer Interaction toolkit: architecture, data
model, API, the ritual system, the relationship model, the firmware, the web app, and
the design decisions behind them. Everything here is taken from the actual code.

> For "get it running and adapt it," see the **Tutorial**. This document is the
> reference — the *what* and the *why*, in full.

---

## Contents
1. Overview & philosophy
2. System architecture
3. The three agents & six relationships
4. Data model
5. HTTP API reference
6. The ritual system
7. The firmware
8. The web app
9. Extension points (adapting the toolkit)
10. Design decisions & rationale
11. Glossary
12. Known limitations & gotchas

---

## 1. Overview & philosophy

The HPCI Toolkit lets workshop participants build small systems around living plants —
naming them, sensing their signals, driving lights, and composing **rituals** of care —
entirely from a phone, no code.

Four commitments shape it:

- **Plant-centric.** The plant is the primary entity. You name it; devices attach to it;
  data lives on its page. The machine is *how* a plant is sensed, not the subject.
- **No-code for participants.** All configuration happens through the web app; hardware
  self-configures from the server.
- **Decoupled by a database.** Devices and phones never talk directly — each is a client
  of one small server, which holds all state. Robust on poor networks, easy to reason about.
- **Relationships made visible.** Every ritual step enacts a directed relationship
  between human, plant, and machine; these are tagged, recorded, and visualised, because
  the relationships are the research subject.

---

## 2. System architecture

Three processes, one source of truth (the database). The ESP32s and phones never
communicate directly — a device posts readings and polls for instructions; a phone reads
and writes through the same server.

```
   ESP32 device(s)                 Server + SQLite                  Phone web app
   - read sensors      --POST-->   Node + Express          <--GET-- - plant pages
   - post readings                 better-sqlite3           --data-> - live data
   - poll config       <--GET---   + the ritual engine               - no-code setup
   - poll outputs                  (tick() every 1s)       <--PUT-- - ritual builder
   - drive RGB, report                                              - transcripts
```

- **ESP32 firmware** (`firmware/hpci_device/hpci_device.ino`): one config-driven sketch
  for all boards.
- **Server** (`plant-server/server.js`): Node + Express + better-sqlite3. All state, the
  REST API, the static web app, and the ritual engine.
- **Web app** (`plant-server/public/`): plain multi-file JS, no build step; p5.js for the
  graph, Mermaid for the diagram.

**Polling model.** Devices are pull-based — they ask the server what to do rather than
being pushed to. A rebooted device simply re-fetches its config and resumes. The server
is always authoritative.

---

## 3. The three agents & six relationships

The conceptual core. Three **agents**, each named:

- **human** — the user (their login name).
- **plant** — a plant or environment (named by the user).
- **machine** — a device (its nickname) *or* "UI" (the interface itself).

Every ritual step enacts a directed relationship between two agents:

| step | relationship | in the system |
|---|---|---|
| **say** | machine → human | the interface shows a message |
| **ask** | human → machine | the human answers (choice or open text) |
| **sense** | plant → machine, or human → machine | a device reads the plant, or reads the human (button/dial/wearable) |
| **act** | machine → plant, or machine → human | a device drives a light on the plant, or a light/buzzer toward the human |
| **tend** | human → plant | the human is asked to act on the plant, and confirms |
| **attend** | plant → human | the human is asked to notice the plant, and reports |

**The mediated pair.** No wire runs between a human and a plant, so **tend** and
**attend** can't be sensed — the toolkit *invites* them through the interface and records
the human's response. A tend is really: UI → human (the instruction), human → plant (the
act), human → UI (the confirmation). An attend: UI → human (the instruction), plant →
human (the perceiving), human → UI (the written noticing). The loop opens and closes at
the interface; the human↔plant relationship happens in the middle, in the world. Both
**always require a response** — the response is what enacts and evidences the
relationship, so a tend/attend without one would be indistinguishable from a `say`.

**Target and medium.** A device attaches to a plant, an environment, *or the human*
(the `attachments.target_type`). So **sense** and **act** target whichever pole their
device is attached to — a plant, or the human (a button/dial the person operates, an
LED/buzzer aimed at them). The relationship a sense/act enacts therefore depends on its
target: plant→machine / machine→plant, or human→machine / machine→human. These
hardware human↔machine relationships are distinct from **say**/**ask**, which are the
same directions but mediated by the **interface** (the machine pole is "UI", not a
device). The transcript and swimlane distinguish them by the machine end's name (a device
nickname vs. "UI"). A step's compiled form carries a `target` field (`plant` | `human`)
so the views render the correct poles.

**The human is always a participant.** Every ritual involves the human through the UI
(say/ask/tend/attend), so "you" is a permanent presence — always shown in the builder's
participant list (not opt-in), with any devices attached to you given read/write roles
like a plant's. Only **tend** and **attend** are plant-only targets (they *are* the
human↔plant relationships); sense/act may target the human, but tending or attending to
yourself is not part of the model.

These relationships are shown in the builder (step labels), the transcript (each event
tagged with its pole chain), the diagram (edge labels), and the **swimlane** (a
three-lane view where the interaction flows visibly between human, plant, and machine).
On the event side (transcript + swimlane), all of these derive from one function,
`eventRelationships(event)` in `rituals.js` — the single source of truth for what
relationship an event enacts, so the views cannot drift apart.

---

## 4. Data model

SQLite, defined in `server.js`. Thirteen tables.

> **Migration note.** `CREATE TABLE IF NOT EXISTS` creates a missing table but never
> alters an existing one. Adding a column to the schema requires an `ALTER TABLE … ADD
> COLUMN` on an existing `plants.db`, or deleting the db to rebuild.

**readings** — every sensor sample. `id`, `device_id`, `sensor_name`, `value`, `ts`.

**users** — `id`, `name` (UNIQUE; no password — a workshop tool).

**devices** — a physical board. `id` (TEXT), `owner_id` (the write-lock holder; null =
free).

**subscriptions** — which user follows which device, under a nickname. `user_id`,
`device_id`, `nickname`; PK (user_id, device_id).

**configs** — one config per device, as JSON. `device_id` (PK), `json`, `updated_at`.
Written by setup, read by both the app and the ESP.

**output_states** — desired vs. reported per output. `device_id`, `output_name`,
`desired` (JSON `{r,g,b}`), `reported`, `updated_at`; PK (device_id, output_name).

**rituals** — a ritual *definition*. `id`, `name`, `definition` (JSON), `created_by`,
`created_at`, `hidden` (1 = soft-deleted, kept for research).

**ritual_instances** — a *run*. `id`, `ritual_id`, `started_by`, `status`
(running/done/failed), `current` (step id), `wait_until` (engine sleeps until this ts),
`state` (JSON scratch — saved answers), `started_at`, `updated_at`, `status_text`
("what's happening now").

**prompts** — a question awaiting a human answer (created by ask, and by tend/attend
confirmations). `id`, `instance_id`, `step_id`, `started_by`, `text`, `options` (JSON
array), `answer`, `kind`, `answered` (0/1), `created_at`, and `open` (1 = free-text
response, added by migration).

**ritual_events** — the complete ordered diary of a run. `id`, `instance_id`, `step_id`,
`type`, `payload` (JSON, shape depends on type), `ts`. Both the research record and the
source of the transcript/swimlane.

**plants** — `id`, `name`, `environment_id` (optional; null = ungrouped), `created_by`,
`created_at`.

**environments** — a named group of plants. `id`, `name`, `created_by`, `created_at`.

**attachments** — which device points at which target. `device_id` (PK — a device
attaches to ONE target), `target_type` (`plant` | `environment` | `human`), `target_id`,
`updated_at`. This one polymorphic table links devices to any of the three poles.

**Relationships.** A user authors rituals and holds subscriptions; a plant optionally
belongs to an environment; a device attaches (via `attachments`) to one plant/
environment/human; a plant's data = readings from devices attached to it *or* to its
environment (computed live, never stored on the reading).

---

## 5. HTTP API reference

All bodies JSON. Base URL is the server root.

### Health & catalog
- `GET /` — liveness.
- `GET /catalog` — the sensor catalog.
- `GET /output-catalog` — the output catalog.

### Users
- `POST /users` `{name}` → `{id, name}` (create-or-fetch, idempotent).
- `GET /users` — all users.
- `GET /users/:id/attached-devices` — devices attached to the human (`target_type='human'`).
- `GET /users/:id/sensors` — sensor names across the human's attached devices.
- `GET /users/:id/readings?sensor=` — readings for one sensor across the human's devices.

(A device attaches to the human via `POST /devices/:id/attach` with
`target_type: 'human'`, `target_id: <user id>` — the same endpoint used for plants and
environments.)

### Plants
- `POST /plants` `{user_id, name, environment_id?}` → `{id, name}`.
- `GET /plants?user_id=` — the user's plants.
- `GET /plants/:id/devices` — devices attached to the plant (directly or via its
  environment); each with `target_type`.
- `GET /plants/:id/sensors` — distinct sensor names across the plant's devices.
- `GET /plants/:id/readings?sensor=` — readings for one sensor across the plant's devices.
- `PUT /plants/:id/environment` `{environment_id}` — assign to an environment (or null).

### Environments
- `POST /environments` `{user_id, name}` → `{id, name}`.
- `GET /environments?user_id=` — the user's environments.
- `GET /environments/:id/plants` — plants in the environment.
- `GET /environments/:id/devices` — devices attached to the environment.

### Devices
- `POST /devices/:id/attach` `{target_type, target_id}` — attach to a plant/environment/
  human (upsert; one target per device).
- `POST /devices/:id/detach` — remove the attachment.
- `POST /devices/:id/subscribe` `{user_id, nickname}` — follow under a nickname.
- `GET /users/:id/devices` — the user's subscribed devices (name = their nickname).
- `GET /devices/:id/sensors` — distinct sensor names this device has reported.
- `GET /devices/:id/config` — the device's config.
- `PUT /devices/:id/config` — save the config (the setup screen calls this).

### Readings
- `POST /readings` `{device_id, readings:[{name,value}]}` — batch insert (the ESP).
- `GET /readings/:device_id` — all readings for a device, oldest first.

### Outputs & the write-lock
- `PUT /devices/:id/outputs/:name/desired` `{user_id, color}` — set desired; **403**
  unless the caller holds the lock.
- `GET /devices/:id/outputs/desired` — the desired outputs (the ESP polls this).
- `PUT /devices/:id/outputs/:name/reported` `{r,g,b}` — the ESP reports what it applied.
- `GET /devices/:id/outputs/state` — desired + reported per output.
- `POST /devices/:id/claim` `{user_id}` — take the lock; **409** if held (returns
  `held_by`).
- `POST /devices/:id/release` `{user_id}` — release (owner only).
- `GET /devices/:id/owner` — `{owner_id}` (null = free).

### Rituals (definitions)
- `POST /rituals` `{user_id, name, definition}` → `{id}`.
- `GET /rituals?user_id=&offset=&limit=` → `{rituals, hasMore}` (own, non-hidden,
  paginated).
- `POST /rituals/:id/hide` — soft delete.

### Rituals (running)
- `POST /rituals/:id/start` `{user_id}` — claims write-devices all-or-nothing, creates a
  run; **409** if a write-device is locked.
- `GET /instances?user_id=&offset=&limit=` → `{runs, hasMore}` (own runs, newest first).
- `GET /instances/:id` — one run's state (incl. `status_text`, `ritual_name`).
- `GET /instances/:id/events` — the run's full event diary.
- `POST /instances/:id/stop` — mark done and release its locks.

### Prompts
- `GET /users/:id/prompts` — unanswered questions for the user whose instance is running.
- `POST /prompts/:id/answer` `{answer}` — record the answer; the engine picks it up next
  tick.

Pagination fetches `limit + 1` rows to set `hasMore` without a second query.

---

## 6. The ritual system

### Definition format
A ritual definition is JSON: `{ name, devices, start, steps }`.

- **devices** maps an alias (`d1`) to `{device_id, role}` (`read` or `write`; write
  implies read). Steps reference aliases; the engine resolves them via `realDevice`.
- **start** is the first step id.
- **steps** is an id→step map; steps point to successors by id (`next`, or `then`/`else`
  for sense, or `answer_routes` for a branching ask). `end` is terminal.

Rituals are composed in terms of **plants** in the builder; the plant + chosen
sensor/output is resolved to a device at build time, so the stored definition is
device-based and the engine is unchanged by plant-awareness.

### Step types (engine `runStep`)
- **say** — show a message; lingers ~4s (via `wait_until` + the `_sayShown` flag), then
  advances.
- **ask** — post a question. Choice mode: buttons, may route per answer (`answer_routes`)
  or all to `next`; optional `timeout_ms`/`on_timeout`. Open mode (`open:true`): a text
  field, free-text answer, single `next` (open answers can't branch).
- **wait** — sleep `duration_ms`, then advance.
- **act** — set an output's desired colour, then advance.
- **sense** — read the latest reading, compare via `op` (`<`/`>`/`=`) to `value`, branch
  `then`/`else`; a self-loop paces to `min_recheck_ms` (the sensor's interval).
- **tend** — post a "done" prompt, wait; logs `tend` then `tend_confirmed`. Always
  confirmed.
- **attend** — post a prompt (a "done" button, or a text field if `open:true`), wait;
  logs `attend` then `attend_noticed`. Always requires a response.
- **end** — mark the run done.

### The engine (`rituals-engine.js`)
`makeEngine(db)` returns `{ tick }`; the server calls `tick()` every second. Each tick
loads all `running` instances and, for each (in a try/catch so one failure is isolated as
`failed`): reads it fresh from the DB, computes `_sayShown` (true once a linger's
`wait_until` has passed, for `say`/`tend`/`attend`), skips sleeping instances *except*
`ask` (which must be polled to catch answers), runs the current step, and advances if the
step returned a next id. Nothing important is in memory, so a server restart resumes
running rituals.

### The event diary & relationships
Every step logs to `ritual_events`. Event types and key payloads: `start`; `say`{text};
`ask`{text,options,open}; `answer`{answer,open};
`act`{output,color,device,target,plant_name}; `sense`{sensor,value,passed,device,target,plant_name};
`tend`{text,plant_name};
`tend_confirmed`{text,plant_name}; `attend`{text,plant_name,open};
`attend_noticed`{noticed,plant_name}; `timeout`; `end`.

The frontend maps each event to its relationship (a chain of poles) for the transcript
and swimlane. The invitation events (tend/attend) are machine→human only; the plant is
touched at *confirmation* — `tend_confirmed` is human→plant + human→machine (acted, then
reported); `attend_noticed` is plant→human + human→machine (perceived, then reported). So
each human↔plant interaction is shown once, at the moment it actually happens.

### The lock contract
Starting a ritual claims all its `write` devices all-or-nothing (rolling back to a 409 if
any is held). Stopping (or `end`) releases them. `read` devices are never locked.
Environment-shared devices are read-only in rituals (they can't be locked by one plant's
ritual).

### Builder: validate then compile
The builder edits a friendly *draft*, then on save **validates** (three tiers: dead-end
pointers / END unreachable; a cycle of only single-exit steps; behavioural
non-termination left to the stop button) and **compiles** to the engine format (stable
draft ids → `s0…sN`, minutes → ms, hex → `{r,g,b}`, plant+sensor → device alias).

---

## 7. The firmware

One config-driven sketch (`hpci_device.ino`) for all boards. Top-of-file settings:
WiFi SSID/password, server address, device id.

**Boot:** start I2C (SDA 21, SCL 22); try to init the BME680 (0x77) and ADS1115 (0x48),
setting `bmeReady`/`adsReady` so the same binary runs on boards with different hardware;
connect WiFi; fetch config; attach PWM for RGB outputs.

**Loop:** for each configured input, check its `interval_ms` and read if due, dispatching
by `source` (`adc` → analogRead; `ads1115` → differential mV; `i2c`/BME → four named
readings); batch-POST to `/readings`. About once a second, GET desired outputs, drive the
RGB PWM, and PUT reported state.

Adding a new sensor `source` = a new branch in the read dispatch (see §9).

---

## 8. The web app

Plain JS, no build step; all `public/*.js` share one global scope, loaded in order by
`index.html` (`app.js` first). Files: `app.js` (shared state, tabs, login, relationship
rendering — `relationTag`/`POLE_GLYPH`); `plants.js` (plant home + plant pages, where data
lives); `me.js` (the "you" page — the human's attached devices + data, mirroring a plant
page, reached from the identity bar); `environments.js`; `devices.js`, `device.js` (graph,
light, lock); `setup.js` (no-code setup + pin allocator); `rituals.js` (rituals page,
transcript, swimlane, preview, prompt box, and `eventRelationships` — the single source of
truth for event relationships); `builder.js` (the visual builder).

**Navigation:** a two-tab home — **Plants** and **Rituals**, the two central acts —
with Environments and Devices as secondary buttons. The title returns to the plants tab;
sub-pages (plant, environment, device, setup, transcript, builder) drill in from a tab.
`showView(id)` toggles which `.view` is active.

**Live updates:** pollers refresh the prompt box (2s), the rituals page (3s while open),
an open transcript (2s), the rituals badge (4s), the plant graph (2s), and the device
graph (2s) — each guarded to run only when its view is active.

**Theme:** `style.css` is driven by design tokens at the top (colours, three type
families, a spacing scale). Reskinning is editing those.

---

## 9. Extension points (adapting the toolkit)

- **Add a sensor** → `catalog.js`. Reusing an existing `source` (e.g. `adc`) is
  catalog-only; a new `source` also needs a firmware read-branch. `source` = how the
  firmware reads it; `pin_kind` = how the allocator assigns pins (`adc`/`ads_channel`/
  `i2c`/`rgb`). Pin pools live in `setup.js` (ADC1-only: 32/33/34/35/36/39; outputs:
  25/26/27/16/17/18/19/23; I2C on 21/22).
- **Add an output** → `OUTPUT_CATALOG` in `catalog.js` + a firmware branch for its `type`.
- **Add a ritual step type** → a `case` in `rituals-engine.js` (behaviour), rendering +
  compile in `builder.js`, and relationship encoding in `rituals.js` (transcript, diagram,
  swimlane). Template off `say`.
- **Reskin** → the design tokens atop `style.css`.
- **Reword** → plain strings in `public/*.js` and `index.html`.
- **Change board** → the pin pools in `setup.js` + the firmware, kept in sync.

---

## 10. Design decisions & rationale

- **Why plant-centric.** Putting the plant first (not the device) makes the toolkit about
  the living thing and its care, not the electronics — which is the research subject. Data
  is computed from current attachments, so moving a device or reassigning an environment
  re-sources a plant's data automatically.
- **Why a shared database, not peer-to-peer.** Discovery and addressing are avoided;
  networks that isolate clients don't break it; the server is authoritative; a rebooted
  device resumes by re-fetching.
- **Why config-driven firmware.** One sketch for all boards, no per-board code, no
  reflashing during a workshop; `bmeReady`/`adsReady` let one binary serve varied hardware.
- **Why the write-lock.** A shared light with multiple controllers would flicker; the
  atomic lock gives one controller at a time. Reading is always free (harmless).
- **Why the six relationships are explicit.** The research is about human–plant–machine
  relating; encoding each step as a directed relationship, and requiring tend/attend to
  close through a human response, makes the relationships real and recordable rather than
  implied.
- **Why tend/attend touch the plant only at confirmation.** The invitation is a request
  to the human; the human↔plant relationship only *happens* (and is only *evidenced*) when
  the human acts/perceives and reports. So the plant appears once, at confirmation — not
  doubled between request and fulfilment.
- **Why no build step.** Plain files anyone can open, edit, and refresh — maximally
  hackable for the researchers, artists, and makers who adapt it. The cost (shared global
  scope; no duplicate function names) is accepted for the readability.
- **Why soft delete & private-per-user.** Workshop rituals and runs are research data
  (hidden, not deleted); each participant sees only their own (created_by / started_by).

---

## 11. Glossary

- **Agent / pole** — human, plant, or machine (the three parties that relate).
- **Plant / environment** — a named living subject / a named group of plants sharing a
  device.
- **Device (machine)** — a physical ESP32 (by nickname), or "UI" for the interface.
- **Attachment** — a device pointing at one target (plant/environment/human).
- **Config** — a device's `{inputs, outputs}`, produced by setup, obeyed by the firmware.
- **source / pin_kind** — how a sensor is read (firmware) / what slot it needs (allocator).
- **Write-lock (owner_id)** — exclusive control of a device's outputs.
- **Ritual / instance** — a definition (state machine) / one run of it.
- **Step** — a node in a ritual: say/ask/wait/act/sense/tend/attend/end.
- **Event** — one entry in a run's diary. **Prompt** — a question awaiting an answer.
- **Relationship** — the directed link between two agents a step enacts.

---

## 12. Known limitations & gotchas

- **`CREATE TABLE IF NOT EXISTS` won't add columns** — migrate with `ALTER TABLE` (wrap
  SQL in `node -e "..."`) or rebuild the db.
- **Shared global scope / no build step** — two files must never define the same function
  name (the last loaded wins). "No error but wrong output," or "file right but browser
  wrong," usually means a duplicate function (grep every file) or cached JS (hard-refresh).
- **p5.js claims common globals** (`line`, `text`, `map`, `width`…) — prefix your own
  helpers (`eventLine`).
- **DOM values are strings** — compare `Number(x) === id`, not `===` against DB numbers.
- **Relationship encoding — event side unified, definition side not yet.** The
  transcript and swimlane both derive from one function, `eventRelationships(event)` in
  `rituals.js` — so those cannot drift. But the ritual *diagram* (`relationText`) and
  *preview* (`previewChain`) still encode the step→relationship mapping separately (they
  work on definitions, not events). Adding a step type or changing a relationship means
  updating `eventRelationships` *and* those two definition-side functions. Unifying the
  definition side into a parallel `stepRelationships(step)` is a sensible future step.
- **The `say`/tend/attend linger** relies on `wait_until` being 0 on entry; documented in
  the engine.
- **sense reads only the latest reading** — if a sensor has never reported, the value is
  absent and the comparison takes `else`.
- **Restart Node after server edits; hard-refresh after app edits.** Check the dev console
  (F12) first when something's off.

---

*This documentation describes the toolkit as built. Remaining work: Raspberry Pi
workshop deployment, and hardware runtime testing of the plant-aware sense/act path.*