# HPCI Toolkit — Tutorial & Adaptation Guide

This guide takes you from a fresh clone to a running workshop, then shows you how to
**make the toolkit your own** — your own sensors, your own look, your own kinds of
interaction. It assumes no prior experience with the codebase, just willingness to edit
a few plain text files.

The toolkit has three parts that never talk to each other directly — they all go
through one small server:

- **ESP32 boards** read sensors and drive lights. They ask the server what to do.
- **A server** (Node.js) holds everything and serves the web app.
- **A phone web app** where people name plants, attach devices, and build rituals.

You'll spend most of your adapting time in two files: `plant-server/catalog.js` (what
sensors/outputs the app offers) and `firmware/hpci_device/hpci_device.ino` (how the
board reads them). Both are explained below.

---

## Part 1 — Get it running

### 1.1 What you need
- A computer with **Node.js v18+** ([nodejs.org](https://nodejs.org)).
- One or more **ESP32 boards** (the build targets the ESP32-WROOM-32).
- The **Arduino IDE** with ESP32 board support.
- Sensors and an RGB LED (see Part 3 for what's supported out of the box).

### 1.2 Run the server
```bash
git clone https://github.com/mor3s/hpci-toolkit.git
cd hpci-toolkit/plant-server
npm install
node server.js
```
You'll see `listening on http://localhost:3000`. Open that in a browser. The database
(`plants.db`) is created automatically.

To reach it from a **phone**, put the phone on the same network and open
`http://<computer-ip>:3000`. For a real workshop you'd run the server on a Raspberry Pi
that *is* the network — see Part 6.

### 1.3 Flash a board
Open `firmware/hpci_device/hpci_device.ino` in the Arduino IDE. Near the top, set:
- **WiFi name and password** — the network the board joins (same one the server is on).
- **Server address** — e.g. `http://192.168.1.50:3000` (your computer's IP).
- **Device id** — a unique name for this board, e.g. `esp32-basil`.

Set the board to **ESP32 Dev Module**, 115200 baud, pick the serial port, and upload.
The same firmware runs on every board — a board doesn't know what's plugged into it
until the server tells it, which is the point of setup.

### 1.4 First run — the plant-first flow
1. **Enter your name** to sign in (no password — it's a workshop tool).
2. You land on **Plants**. **Name a plant** (e.g. "Basil"). This is the first act —
   naming the thing you're caring for.
3. **Tap the plant** to open its page. To sense it, you need a device — tap
   **"Register a device"** (or go to *Devices & hardware*), subscribe to your board by
   its id, then come back to the plant and **attach** it.
4. On the device, open **Setup** and add a sensor from the dropdown. The app picks a
   pin and shows you how to wire it. Wire it as instructed.
5. Within seconds the board reconfigures itself and starts sending readings. Back on
   the **plant's page**, you'll see **"What this plant senses"** — a live graph, sourced
   from the plant's devices.

That's the core loop: **name a plant, attach a device, add a sensor, see the data on
the plant.** No code.

---

## Part 2 — The mental model

Five ideas, and you'll understand the whole system.

**Plants are the centre.** You name plants; devices attach to them; data shows on the
plant's page. The electronics are *how* a plant is sensed, not the thing you look at.

**Environments group plants.** An environment (e.g. "the windowsill") is a named group.
A device attached to an environment reaches *every* plant in it — so one shared climate
sensor can serve many plants without being wired to each.

**The config is a contract.** When you add a sensor in Setup, the app writes a small
description into the device's *config*. The board fetches that same config and obeys it.
"Adding a sensor" is really "adding an entry to the config"; the board just follows.

**The catalog is the menu.** The sensors you can add come from `catalog.js`. Each entry
describes one kind of sensor. To offer a new sensor, you add an entry there.

**Three agents, six relationships.** Everything in a ritual is a relationship between
the **human**, the **plant**, and the **machine**. Sensing is plant→machine; acting is
machine→plant; saying is machine→human; asking is human→machine; tending is human→plant;
attending is plant→human. The toolkit makes these visible — that's its research purpose.

---

## Part 3 — What's supported out of the box

Sensors (in `CATALOG`):

| Sensor | How it's read (`source`) | Notes |
|---|---|---|
| Soil moisture (capacitive) | `adc` | one analog pin |
| Potentiometer (dial) | `adc` | one analog pin — a handy human input |
| Air & climate (BME680) | `i2c` | one sensor, four readings (temp/humidity/pressure/gas) |
| Plant bioelectricity (ADS1115) | `ads1115` | differential pair, clipped to a leaf |

Output (in `OUTPUT_CATALOG`): an **RGB LED** (three PWM pins).

---

## Part 4 — Add your own sensor

This is the heart of adapting the toolkit. Easy case first (catalog-only), then the
harder case (new firmware).

### 4.1 The shape of a catalog entry
Open `plant-server/catalog.js`. A simple sensor entry looks like this (the real soil
sensor):

```js
{
  id: "soil_capacitive",              // unique key
  label: "Soil moisture (capacitive)",// shown in the dropdown
  source: "adc",                      // HOW the firmware reads it
  pin_kind: "adc",                    // HOW the app allocates a pin
  default_name: "soil",               // suggested name on add
  unit: "raw",                        // informational
  range: [0, 4095],                   // informational
  interval_ms: 5000,                  // how often to read (ms)
  instructions: "… GPIO {pin} …"      // wiring text; {pin} is filled in
}
```

Two fields do the real work:
- **`source`** tells the *firmware* how to read it: `adc` (analog pin), `i2c` (a chip on
  the I2C bus), `ads1115` (the external ADC).
- **`pin_kind`** tells the *app's allocator* what to assign: `adc` (one ADC pin),
  `ads_channel` (an ADS differential pair), `i2c` (nothing — shares the bus), `rgb`
  (three output pins).

### 4.2 Easy case — another analog sensor (no firmware change)
Say you have a **light sensor (LDR)** giving an analog voltage. That's the same *kind*
of reading as the soil sensor, so it reuses `source: "adc"` — no firmware change at all.
Just add an entry:

```js
{
  id: "ldr_light",
  label: "Light level (LDR)",
  source: "adc",
  pin_kind: "adc",
  default_name: "light",
  unit: "raw",
  range: [0, 4095],
  interval_ms: 3000,
  instructions: "Wire the LDR divider output to GPIO {pin}, plus 3V3 and GND."
}
```

Restart the server, refresh the app, and "Light level (LDR)" appears in Setup —
pin-allocated, wiring-instructed, graphed. **Any analog sensor works this way, catalog
only.**

The app keeps a pool of safe pins and hands out a free one. It uses **ADC1 pins only**
(`32, 33, 34, 35, 36, 39`) because the ESP32's ADC2 pins stop working once WiFi is on.

### 4.3 Multi-reading I2C sensor (like the BME680)
An I2C sensor shares the bus (no pin allocated) and can yield several named readings via
a `channels` array — one "add," many readings:

```js
{
  id: "bme680",
  label: "Air & climate (BME680)",
  source: "i2c",
  pin_kind: "i2c",
  address: "0x77",
  default_name: "air",
  channels: [
    { suffix: "temperature", unit: "C",   range: [0, 50] },
    { suffix: "humidity",    unit: "%",   range: [0, 100] },
    { suffix: "pressure",    unit: "hPa", range: [950, 1050] },
    { suffix: "gas",         unit: "kOhm",range: [0, 500] }
  ],
  interval_ms: 30000,
  instructions: "Connect to the I2C rail (SDA→21, SCL→22, plus 3V3 and GND)."
}
```
Its readings are named `air.temperature`, `air.humidity`, and so on.

### 4.4 Harder case — a sensor that needs new firmware
If your sensor is read a *new way* (a new I2C chip with its own library, say), you add a
new `source` and teach the firmware to handle it. Two steps:

**Step 1 — catalog entry with a new `source`:**
```js
{
  id: "lux_bh1750",
  label: "Light (BH1750 lux)",
  source: "bh1750",               // a NEW source name
  pin_kind: "i2c",                // on the bus, no pin allocated
  address: "0x23",
  default_name: "lux",
  interval_ms: 5000,
  instructions: "Connect to the I2C rail (SDA→21, SCL→22, plus 3V3 and GND)."
}
```

**Step 2 — teach the firmware.** In `hpci_device.ino`, find where it reads each input
by its `source` (branches like "if source is `adc`, `analogRead`…"). Add a branch:
```cpp
else if (source == "bh1750") {
    float lux = bh1750.readLightLevel();   // using the sensor's library
    addReading(name, lux);                 // post under the sensor's name
}
```
Include the library and initialise it in `setup()`, mirroring how the BME680 is set up.

**The rule:** the catalog entry and the firmware `source` handler are two halves of the
same addition. The catalog says "offer this, call it `bh1750`"; the firmware says "when
you see `bh1750`, read it like this." Match the `source` string in both and they connect.

### 4.5 Add an output (actuator)
Outputs live in `OUTPUT_CATALOG`. The RGB LED is `type: "rgb"`, `pin_kind: "rgb"` (three
PWM pins). A new *kind* of output (say a relay) needs a new `type` + a firmware branch
that drives it, same two-halves rule. Output pins come from the pool
`25, 26, 27, 16, 17, 18, 19, 23` (PWM-capable, clear of the I2C pins 21/22).

---

## Part 5 — Make it your own

### Reskin the interface
The whole look lives in design tokens at the top of `plant-server/public/style.css` —
colours (`--ink`, `--paper`, `--moss`, `--clay`, `--bark`…), fonts (`--serif`, `--sans`,
`--mono`), and a spacing scale. Change those few variables and the entire app re-skins.

### Change the wording
All participant-facing text is plain strings in the `public/*.js` files and
`index.html` — the catalog labels, step descriptions, prompts. Edit in place; speak to
your audience.

### Add a ritual step type
Steps are the ritual's building blocks. Adding one touches three places:
1. **`rituals-engine.js`** — a `case` in the engine's `runStep` for how it behaves.
2. **`builder.js`** — the form for configuring it and how it compiles.
3. **`rituals.js`** — its relationship encoding (so the transcript, diagram, and
   swimlane show it correctly).

Use a simple existing step (`say`) as your template — it shows the full path from
builder form to engine behaviour to display.

### Change the board
The pin pools in `plant-server/public/setup.js` (`ADC_POOL`, `ADS_POOL`, `OUTPUT_POOL`)
describe the ESP32's usable pins. To adapt to a different board, change these **and** the
firmware to match — they must agree on which pins do what.

---

## Part 6 — Run the server on a Raspberry Pi


1. Make the Pi a WiFi access point (e.g. `nmcli device wifi hotspot`); it sits at a
   fixed address like `192.168.4.1`.
2. Run the server on the Pi, ideally on **port 80** so phones type an address with no
   `:3000`.
3. Auto-start it on boot (systemd or pm2) so it survives a reboot.
4. Point the firmware's server address at the Pi.
5. Confirm phones load the app, a board posts readings, a light responds 

---

## Part 7 — Troubleshooting

- **Board connects but no data.** Check the device id in the firmware matches the one you
  subscribed to, and that you *added a sensor in Setup* — a board with no config reads
  nothing. Watch the Serial Monitor (115200 baud).
- **A sensor I added isn't in the dropdown.** Restart the server after editing
  `catalog.js` (Node reads it once at start), then hard-refresh the browser.
- **A new-`source` sensor shows but never reports.** The catalog entry exists but the
  firmware has no handler for that `source` — add the firmware branch (Part 4.4).
- **The light won't respond.** Only the holder of the device's control lock can drive it
  — tap "Take control" first. Check the RGB wiring matches the pins shown.
- **A ritual won't save.** The builder validates before saving — it will list problems
  (a step pointing nowhere, a sense/act with no plant, etc.). Fix those and save again.
- **Changed the database schema and got a "no such column" error.** SQLite's
  `CREATE TABLE IF NOT EXISTS` won't alter an existing table — delete `plants.db` to
  rebuild fresh, or run an `ALTER TABLE` migration (wrap the SQL in `node -e "..."`).
- **"File is right but the browser is wrong."** Hard-refresh (Ctrl+Shift+R). If it
  persists, the browser cached old JS, or two files define the same function — grep every
  file for the function name.

---

## A note on the spirit of it

This toolkit is deliberately simple and hackable — no build step, no framework, plain
files you can read and change. So fork it, add the sensors *your*
plants and questions need, change the words and the colours, and compose rituals that
mean something in your context. The interesting work isn't the code — it's the kinds of
attention and care the toolkit lets people practise, and the relationships it makes
visible. Make it your own.