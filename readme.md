# HPCI Toolkit

A no-code electronic toolkit for **Human–Plant–Computer Interaction** workshops.

Participants plug sensors and lights into ESP32 boards, configure everything from
their phone (no laptop, no code), watch their plants' signals live, and compose
**rituals** — small programmed sequences of care that sense, speak, ask, wait, and
respond. The whole thing runs self-hosted on a laptop (and, for a workshop, on a
Raspberry Pi acting as both the WiFi network and the server).

---

## What it does

- **Plug-and-play hardware.** A single generic firmware runs on every ESP32; each
  board configures itself by fetching its setup from the server on boot.
- **Phone-based setup.** Participants add sensors and outputs from a catalog; the
  app auto-allocates the right pins and shows wiring instructions. No code.
- **Live data.** Each device shows a live graph of any sensor and lets the holder
  of its "control lock" drive its RGB light.
- **Rituals.** A visual builder lets participants compose care sequences as a state
  machine — *say* a message, *ask* a question, *wait*, *act* on a light, or *sense*
  a value and branch on it. Rituals can loop, branch on sensor readings, and branch
  on the human's answers.
- **A living record.** Every run keeps a full timestamped diary (the transcript),
  rendered as a readable conversation and usable as research data.

---

## Architecture

Three parts. **The ESP32s and the phones never talk to each other directly** —
everything flows through the server and its database. This decoupling is the core
design idea: a device posts readings and polls for instructions; a phone reads and
writes through the same server; neither needs to know the other exists.

```
   ESP32 device(s)                  Server + SQLite                 Phone web app
   ----------------                 ----------------                --------------
   - read sensors      --POST-->    Node + Express          <--GET-- - device list
   - post readings                  better-sqlite3 (db)     --data-> - live graph
   - poll config       <--GET---    the ritual engine                - setup screen
   - poll outputs                   (a 1-second heartbeat)  <--PUT-- - light control
   - drive light/LED                                                 - ritual builder
                                                                     - transcripts
```

- **ESP32 firmware** (Arduino, in `firmware/`). One config-driven sketch for all
  boards. On boot and every 15s it fetches `/devices/<id>/config` and sets itself up
  dynamically. Each input is read on its own clock; outputs (RGB LED via PWM) follow
  the server's desired state and report back what they applied.
- **Server** (`plant-server/server.js`). Node + Express + better-sqlite3. Holds all
  state, serves the web app, exposes the REST API, and runs the **ritual engine**.
- **Web app** (`plant-server/public/`). Vanilla JS, multi-file, p5.js for the graph,
  Mermaid for the ritual diagrams. No build step — all scripts share one global scope.

---

## Repository layout

```
hpci-toolkit/
├── README.md
├── .gitignore
│
├── firmware/                       # the ESP32 Arduino code
│   └── hpci_device/
│       └── hpci_device.ino         # one generic, config-driven sketch
│
└── plant-server/                   # the server + web app
    ├── server.js                   # Express app, SQLite schema, all REST endpoints
    ├── rituals-engine.js           # the state-machine engine (the 1s heartbeat)
    ├── catalog.js                  # the sensor + output catalogs (what setup offers)
    ├── package.json                # node dependencies (express, better-sqlite3)
    ├── plants.db                   # the SQLite database — NOT in git (created on run)
    └── public/                     # the web app (served statically)
        ├── index.html              # all the views (login, devices, device, setup,
        │                           #   rituals, builder, transcript, preview)
        ├── style.css               # the "living field notebook" theme (design tokens)
        ├── app.js                  # shared state + showView + login  (LOADED FIRST)
        ├── devices.js              # the device list + subscribing
        ├── device.js               # one device: live graph, light control, the lock
        ├── setup.js                # the no-code sensor/output setup + pin allocator
        ├── rituals.js              # rituals page, live view, transcript, prompt box
        ├── builder.js              # the visual ritual builder (validate + compile)
        ├── p5.min.js               # graphing (self-hosted, offline)
        └── mermaid.min.js          # ritual diagrams (self-hosted, offline)
```

> Note: an Arduino `.ino` file must live in a folder of the same name — that's why
> the sketch is at `firmware/hpci_device/hpci_device.ino`, not loose in `firmware/`.
>
> Script load order in `index.html` matters: `app.js` first (it defines the shared
> state and `showView` that every other file uses).

---

## Running it

### The server

Requires **Node.js** (v18+). From the `plant-server` folder:

```bash
cd plant-server
npm install          # installs express + better-sqlite3 (from package.json)
node server.js       # starts the server on http://localhost:3000
```

Open `http://localhost:3000` in a browser. On the same network, phones reach it at
`http://<server-ip>:3000`. The database (`plants.db`) is created automatically on
first run.

**Windows / PowerShell note:** to call the API by hand, use `Invoke-RestMethod`, not
`curl`. For anything with nested quotes, put it in a `.js` file and run `node file.js`
rather than fighting PowerShell's quoting (a recurring lesson in this project).

### The firmware

Open `firmware/hpci_device/hpci_device.ino` in the Arduino IDE. Board: *ESP32 Dev
Module*, 115200 baud. Set the server address near the top of the sketch to wherever
the server is running (your laptop's hotspot IP, or the Pi's address), set the
device's id, and upload. The board self-configures from the server on boot.

---

## Core concepts

### Devices, subscriptions, and the write-lock
A **device** is identified by a string id (e.g. `esp32-bme`). Users **subscribe** to
devices under personal nicknames. Reading a device never needs permission; **writing**
to its outputs requires holding its **lock** (`owner_id`). The lock is claimed and
released atomically, so two people can't both control the same light at once.

### Config is the contract
A device's **config** (`{inputs, outputs}`) is written by the setup screen and read
by *both* the app and the ESP. Adding a sensor allocates a hardware pin and bakes a
wiring instruction into the config; the ESP reads that same config to know what to do.

### Rituals: definitions vs. instances
A **ritual** is a definition — a state machine of steps connected by `next`/`then`/
`else`/`answer_routes` pointers. Running one creates an **instance** that the engine
walks, one step per second. Definitions are private to their author; runs are private
to whoever started them. "Deleting" a ritual hides it (soft delete) — the data stays
for research.

### The ritual engine
A heartbeat (`tick()` every second) advances each running instance by one step. Step
types:
- **say** — show a message (lingers briefly so it can be read)
- **ask** — pose a question; routes per answer, or all to one step; optional timeout
- **wait** — sleep for a duration
- **act** — set an output's desired value (the ESP applies it)
- **sense** — read the latest sensor value, compare, branch `then`/`else`; a self-loop
  paces itself to the sensor's own sampling interval
- **end** — finish, releasing any locks

Every step logs to the **event diary** (`ritual_events`) — the research/debug record
and the source of the transcript. The instance also carries a `status_text` ("what's
happening now") that drives the live view.

### The builder: edit friendly, compile precise
Participants edit a **draft** in the browser (minutes, hex colors, step numbers).
On save it is **validated** then **compiled** into the engine's exact format. Steps
carry stable ids (`k7`) so pointers survive reordering; compile renumbers them to
`s0…sN`. Validation catches three tiers:
1. **Dead ends** — a pointer to nowhere, or END unreachable (graph traversal).
2. **Structural infinite loops** — a cycle of only single-exit steps (decidable).
3. **Behavioral non-termination** — left to the human via the **stop** button
   (undecidable in general, and often intentional, e.g. an open-ended vigil).

---

## Hardware notes

- **Board:** ESP32-WROOM-32 (USB-C, CH340). Arduino board setting: *ESP32 Dev Module*,
  115200 baud.
- **BME680** (temp/humidity/pressure/gas) on I²C `0x77` — SDA 21, SCL 22.
- **ADS1115** (external ADC for plant bioelectricity) on I²C `0x48`, differential A0–A1.
- **Capacitive soil moisture** — analog, **ADC1 pins only** (32, 33, 34, 35, 36, 39).
  *ADC2 pins stop working when WiFi is on — never use them.*
- **RGB LED** — three PWM pins from the output pool (25, 26, 27, 16, 17, 18, 19, 23),
  avoiding the I²C pins (21/22). Use current-limiting resistors.

These constraints are encoded in the pin pools in `plant-server/public/setup.js` —
don't change them without knowing why each pool is what it is.

---

## Gotchas worth remembering

These bit us repeatedly during the build; they're worth keeping in mind:

- **`CREATE TABLE IF NOT EXISTS` does not add columns** to an existing table. After
  adding a column to the schema, run an `ALTER TABLE … ADD COLUMN` on an existing
  `plants.db`, or delete the db to rebuild fresh.
- **No build / shared global scope.** All `public/*.js` share one namespace. Two files
  (or two paste-overs) defining the same function name silently collide — the last one
  wins. "No error but wrong output" usually means a duplicate function, a stale view,
  or a name clash.
- **p5.js claims common names** as globals (`line`, `text`, `color`, `map`, `random`,
  `width`, `height`…). Don't name your own helpers those — prefix them (e.g.
  `eventLine`). A weird object with `_`-prefixed fields is the tell of a p5 clash.
- **Don't re-render a field someone's typing in.** Store on `oninput`, rebuild on
  `onblur` (or debounce) — otherwise the cursor jumps. Same idea: only touch the DOM
  when the displayed data actually changed (the prompt box's anti-flicker).
- **Restart Node after editing `server.js`; hard-refresh the browser after editing the
  app.** Check the dev console (F12) first when something's off.

---

## Workshop deployment (Raspberry Pi)

For a workshop, the Pi becomes both the **WiFi access point** participants' phones and
ESP32s join, and the **server**, so nothing depends on venue WiFi. Outline:

1. Run the Pi as a WiFi access point (e.g. `nmcli device wifi hotspot`); the Pi sits at
   a fixed address (commonly `192.168.4.1`).
2. Run the Node server on the Pi, ideally on **port 80** so phones just type the address
   with no `:3000`.
3. Auto-start the server on boot (systemd or pm2) so it survives a reboot.
4. Point the **firmware's** server address at the Pi.
5. Pre-flight: confirm phones can load the app, an ESP can post readings, and a light
   responds — before participants arrive.

*(This section is the next thing to build out; the rest of the system is complete.)*

---

## Status

The software is functionally complete and runs end to end: self-configuring devices,
no-code setup, live data, the full ritual engine (sensing + answer branching + loops),
the visual builder with validation and a state-machine diagram, and the live
transcript. What remains is the physical workshop setup (the Pi access point, tutorial
sheets for wiring, and a pre-flight checklist).