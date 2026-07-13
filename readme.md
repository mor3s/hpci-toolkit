# HPCI Toolkit

A no-code electronic toolkit for **Human–Plant–Computer Interaction** workshops.

Participants name the plants they're caring for, attach sensors and lights to them
from a phone (no laptop, no code), watch what each plant senses, and compose
**rituals** — small sequences of care and attention that move between three agents:
the **human**, the **plant**, and the **machine**. The toolkit is built to make those
relationships visible, because the relationships are the point.

The whole system is deliberately small, plain, and hackable — no build step, no
framework — so it can be cloned, reskinned, and extended with your own sensors and
your own kinds of interaction. See **Making it your own** below.

---

## The idea

Most sensor toolkits put the electronics at the centre: you wire a board, read a pin,
see a number. This one puts the **plant** at the centre. You start by naming a plant;
devices attach *to* the plant; the data lives on the plant's page, not the device's.
The machine recedes into being *how* a plant is sensed and cared for.

And it makes the **relationships** between human, plant, and machine explicit. Every
step of a ritual enacts a directed relationship — the machine speaks to the human, the
human answers, the plant informs the machine, the machine acts on the plant, the human
tends the plant, the human attends to the plant. The toolkit tags, records, and
visualises these, so a ritual can be read as a choreography of relating.

---

## What it does

- **Name your plants.** Plants are the primary entity — you name them, and optionally
  group them into **environments** (a shelf, a windowsill) that share conditions.
- **Attach devices to plants.** A device (an ESP32 with sensors/lights) attaches to a
  plant, or to an environment (so a shared climate sensor reaches every plant in it).
  A plant can have several devices; its page pools everything sensed about it.
- **Phone-based, no-code setup.** Add sensors and lights from a catalog; the app
  allocates the right pins and shows wiring instructions. The board self-configures.
- **Compose rituals.** A visual builder lets you build sequences from blocks — *say*,
  *ask*, *sense*, *act*, *tend*, *attend*, *wait* — each of which enacts one of the
  relationships between human, plant, and machine.
- **See the relationships.** A ritual's run is shown three ways: as a conversation
  transcript (tagged by relationship), as a state-machine diagram, and as a
  three-agent **swimlane** where the interaction flows visibly between human, plant,
  and machine.

---

## Architecture

Three parts. **The ESP32s and the phones never talk directly** — everything flows
through one small server and its database. A device posts readings and polls for
instructions; a phone reads and writes through the same server; neither needs to know
the other exists. This makes the system robust on flaky networks and easy to reason
about.

```
   ESP32 device(s)                 Server + SQLite                  Phone web app
   ----------------                ----------------                 --------------
   - read sensors      --POST-->   Node + Express          <--GET-- - plant pages
   - post readings                 better-sqlite3 (db)     --data-> - live data
   - poll config       <--GET---   + the ritual engine               - no-code setup
   - poll outputs                  (a 1-second heartbeat)  <--PUT-- - ritual builder
   - drive RGB, report                                              - transcripts
```

- **ESP32 firmware** (`firmware/`): one generic, config-driven Arduino sketch for all
  boards. It fetches its config from the server and reads whatever sensors that config
  lists.
- **Server** (`plant-server/server.js`): Node + Express + better-sqlite3. Holds all
  state, serves the web app, exposes the REST API, and runs the ritual engine.
- **Web app** (`plant-server/public/`): plain multi-file JavaScript — no build step —
  with p5.js for graphs and Mermaid for the ritual diagram.

---

## Repository layout

```
hpci-toolkit/
├── README.md
├── firmware/
│   └── hpci_device/
│       └── hpci_device.ino         # one generic, config-driven sketch
└── plant-server/
    ├── server.js                   # Express app, SQLite schema, REST API
    ├── rituals-engine.js           # the ritual state-machine engine (1s heartbeat)
    ├── catalog.js                  # the sensor + output catalog — ADD SENSORS HERE
    ├── package.json
    └── public/
        ├── index.html              # all the views + the tab navigation
        ├── style.css               # the theme — RESKIN HERE (design tokens at top)
        ├── app.js                  # shared state, tabs, login, relationship rendering
        ├── plants.js               # plant home + plant pages (data lives here)
        ├── environments.js         # environments (groups of plants)
        ├── devices.js              # the device list + subscribing
        ├── device.js               # one device: live graph + light control + lock
        ├── setup.js                # no-code sensor/output setup + pin allocator
        ├── rituals.js              # rituals page, transcript, swimlane, preview
        └── builder.js              # the visual ritual builder
```

> No build step: the `public/*.js` files share one global scope, loaded in order by
> `index.html` (`app.js` first). This is deliberate — it keeps the app hackable with no
> toolchain. The trade-off is that two files must never define the same function name.

---

## Running it

Requires **Node.js v18+**.

```bash
git clone https://github.com/mor3s/hpci-toolkit.git
cd hpci-toolkit/plant-server
npm install
node server.js          # http://localhost:3000
```

Open the address in a browser; phones on the same network reach it at
`http://<server-ip>:3000`. The database (`plants.db`) is created on first run.

**Flash a board:** open `firmware/hpci_device/hpci_device.ino` in the Arduino IDE, set
the WiFi, server address, and device id at the top, choose *ESP32 Dev Module* at
115200 baud, and upload. See the tutorial for the first-run walkthrough.

**Windows / PowerShell note:** to run a one-off database command, wrap SQL in Node
(`node -e "..."`) or a small `.js` script — SQL typed straight into the shell won't run.

---

## The three agents and six relationships

The conceptual core. Three **agents**: the **human** (named by the user), the **plant**
(named by you), the **machine** (a device's nickname, or "UI" for the interface). Every
ritual step enacts a directed relationship between two of them:

| step | relationship |
|---|---|
| **say** | machine to human (the interface tells you something) |
| **ask** | human to machine (you answer the interface) |
| **sense** | plant to machine (a device reads the plant) |
| **act** | machine to plant (a device drives a light on the plant) |
| **tend** | human to plant (you're asked to *act on* the plant, and confirm) |
| **attend** | plant to human (you're asked to *notice* the plant, and report) |

The last two can't be sensed by hardware — no wire runs between a human and a plant —
so the toolkit *invites* them through the interface and records the human's confirmation
or written noticing. That mediation (UI asks, human acts/perceives, human reports) is
shown explicitly in the transcript and swimlane.

---

## Making it your own

The toolkit is built to be adapted. The main extension points:

**Add a sensor.** Edit `plant-server/catalog.js`. If your sensor is read like one that
already exists (e.g. any analog sensor uses `source: "adc"`), a catalog entry is all you
need — no other code. If it's a genuinely new *kind* of reading, you add a new `source`
and a matching branch in the firmware. See the tutorial's "Add your own sensor".

**Reskin the interface.** Edit the design tokens at the top of
`plant-server/public/style.css` — a handful of colour, font, and spacing variables drive
the whole look.

**Add a ritual step type.** Add a `case` in `rituals-engine.js` (how it behaves) and
matching rendering in `builder.js` (how it's built), and its relationship encoding in
`rituals.js`. Use an existing simple step (`say`) as the template.

**Change the hardware/board.** The pin pools in `plant-server/public/setup.js` describe
the ESP32's usable pins; they must match your board and the firmware. Change both in
sync.

**Change the words.** All participant-facing text is plain strings in the `public/*.js`
files and `index.html` — edit in place.

The tutorial and technical documentation go into each of these in detail.

---

## Status

Functionally complete and running end to end: plant-centric organisation, no-code
setup, live data on plant pages, the full ritual engine (all six relationships,
sensing, branching, loops, open text responses), the visual builder, and three ways of
seeing a run (transcript, diagram, swimlane). Remaining practical work is workshop
deployment — a Raspberry Pi as WiFi access point + server — and hardware runtime
testing of the plant-aware sense/act path.

---

## License

<a href="https://github.com/mor3s/hpci-toolkit">HPCI Toolkit</a> © 2026 by <a href="https://orcid.org/0000-0003-3863-3199">Nour Boulahcen</a> is licensed under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International</a><img src="https://mirrors.creativecommons.org/presskit/icons/cc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/by.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/sa.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;">