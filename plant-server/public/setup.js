// ============================================================================
//  setup.js — the no-code device setup screen. Drives a catalog of available
//  sensors/outputs, ALLOCATES hardware pins automatically, and saves the whole
//  config back to the server (which the ESP then fetches to configure itself).
//
//  The pin pools below encode real ESP32 hardware constraints — they are not
//  arbitrary. Changing them risks assigning a pin that can't do the job.
// ============================================================================

// ---- allocation pools, by pin kind ----
// ADC1 pins only: ADC2 pins stop working once WiFi is on, so we never use them.
const ADC_POOL    = [32, 33, 34, 35, 36, 39];
// the ADS1115's differential channel pairs (external ADC over I2C)
const ADS_POOL    = ["0-1", "2-3"];
// PWM-capable output pins that don't clash with I2C (21/22) or the ADC pins above
const OUTPUT_POOL = [25, 26, 27, 16, 17, 18, 19, 23];

// ---- module state (loaded once, then reused) ----
let catalog = [];          // the menu of available sensors
let outputCatalog = [];    // the menu of available outputs
let config = null;         // the current device's config we're editing

// ============================================================================
//  OPENING THE SCREEN
// ============================================================================

// open setup for the current device. Loads the catalogs (once) and this
// device's existing config, fills the dropdowns, and renders what's connected.
async function openSetup() {
  document.getElementById('setupTitle').textContent = document.getElementById('deviceTitle').textContent;
  showView('setupView');

  // LOAD DATA FIRST — everything below reads these
  if (catalog.length === 0)       catalog       = await (await fetch('/catalog')).json();
  if (outputCatalog.length === 0) outputCatalog = await (await fetch('/output-catalog')).json();
  config = await (await fetch('/devices/' + currentDevice + '/config')).json();
  if (!config.outputs) config.outputs = [];          // older configs may predate outputs

  document.getElementById('catalogPicker').innerHTML =
    catalog.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  document.getElementById('outputPicker').innerHTML =
    outputCatalog.map(o => `<option value="${o.id}">${o.label}</option>`).join('');

  renderConfig();
  renderOutputs();
  document.getElementById('setupMessage').textContent = '';
}

// back to the device — re-runs openDevice so the device view re-evaluates its
// config (e.g. the "not set up yet" prompt disappears once you've added a sensor).
function goBackToDevice() {
  openDevice(currentDevice, document.getElementById('deviceTitle').textContent);
}

// ============================================================================
//  THE ALLOCATOR — find a free hardware slot for what's being added.
//  "free = pool minus already-used" — recomputed each time from the current
//  config, so removing something immediately frees its slot again.
// ============================================================================
function allocate(entry) {
  if (entry.pin_kind === 'i2c') return { slot: null };           // shares the bus — nothing to assign

  if (entry.pin_kind === 'adc') {
    const used = config.inputs.filter(i => i.source === 'adc').map(i => i.pin);
    const free = ADC_POOL.find(p => !used.includes(p));
    return free === undefined ? { error: 'No free ADC pins left' } : { slot: free };
  }
  if (entry.pin_kind === 'ads_channel') {
    const used = config.inputs.filter(i => i.source === 'ads1115').map(i => i.channel);
    const free = ADS_POOL.find(c => !used.includes(c));
    return free === undefined ? { error: 'No free ADS channels left' } : { slot: free };
  }
  if (entry.pin_kind === 'rgb') {                                // an RGB LED needs THREE pins
    const used = (config.outputs || []).flatMap(o => Object.values(o.pins || {}));
    const free = OUTPUT_POOL.filter(p => !used.includes(p)).slice(0, 3);
    return free.length < 3 ? { error: 'Not enough free output pins' } : { slot: free };
  }
}

// ============================================================================
//  ADDING / REMOVING SENSORS
// ============================================================================

// add a sensor: look it up in the catalog -> allocate its slot -> name it ->
// append to config -> save. The whole config is saved as one lump each time.
async function addSensor() {
  const msg = document.getElementById('setupMessage');
  msg.textContent = '';

  const entry = catalog.find(c => c.id === document.getElementById('catalogPicker').value);

  const result = allocate(entry);
  if (result.error) { msg.textContent = '⚠ ' + result.error + ' — remove a sensor to free one up.'; return; }

  const name = prompt('Name this sensor:', entry.default_name);
  if (!name) return;

  const input = { catalog_id: entry.id, name, source: entry.source, interval_ms: entry.interval_ms || 5000 };
  if (entry.pin_kind === 'adc')         input.pin = result.slot;
  if (entry.pin_kind === 'ads_channel') { input.channel = result.slot; input.address = entry.address; input.mode = entry.mode; }
  if (entry.pin_kind === 'i2c')         input.address = entry.address;

  // bake the chosen pin into the human wiring instruction (e.g. "connect to pin 32")
  input.instruction = entry.instructions.replace('{pin}', result.slot === null ? '' : result.slot);

  config.inputs.push(input);
  await saveConfig();
  renderConfig();
}

async function removeSensor(index) {
  config.inputs.splice(index, 1);
  await saveConfig();
  renderConfig();
}

// ============================================================================
//  ADDING / REMOVING OUTPUTS (RGB LED — allocates three pins at once)
// ============================================================================
async function addOutput() {
  const msg = document.getElementById('setupMessage');
  msg.textContent = '';

  const entry = outputCatalog.find(o => o.id === document.getElementById('outputPicker').value);

  const result = allocate(entry);
  if (result.error) { msg.textContent = '⚠ ' + result.error; return; }

  const name = prompt('Name this output:', entry.default_name);
  if (!name) return;

  const [r, g, b] = result.slot;                                // the three allocated pins
  const output = { catalog_id: entry.id, name, type: entry.type, pins: { r, g, b } };
  output.instruction = entry.instructions.replace('{r}', r).replace('{g}', g).replace('{b}', b);

  config.outputs.push(output);
  await saveConfig();
  renderOutputs();
}

async function removeOutput(index) {
  config.outputs.splice(index, 1);
  await saveConfig();
  renderOutputs();
}

// ============================================================================
//  SAVING + RENDERING
// ============================================================================

// save the whole config object at once (the server upserts it)
async function saveConfig() {
  await fetch('/devices/' + currentDevice + '/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
}

// list the connected sensors, each with where it's wired + its instruction
function renderConfig() {
  const list = document.getElementById('configList');
  if (!config.inputs || config.inputs.length === 0) {
    list.innerHTML = '<p class="muted">Nothing connected yet.</p>';
    return;
  }
  list.innerHTML = config.inputs.map((i, idx) => {
    const where = i.pin !== undefined     ? 'pin ' + i.pin
                : i.channel !== undefined ? 'ADS ' + i.channel
                :                           'I²C bus';
    return `<div class="device">
       <strong>${i.name}</strong> <span class="muted">(${i.catalog_id} · ${where})</span>
       <button class="back" onclick="removeSensor(${idx})">remove</button>
       <p class="muted" style="margin-top:8px">${i.instruction || ''}</p>
     </div>`;
  }).join('');
}

// list the configured outputs, each with its three pins + its instruction
function renderOutputs() {
  const list = document.getElementById('outputList');
  if (!config.outputs || config.outputs.length === 0) {
    list.innerHTML = '<p class="muted">No outputs yet.</p>';
    return;
  }
  list.innerHTML = config.outputs.map((o, idx) =>
    `<div class="device">
       <strong>${o.name}</strong> <span class="muted">(${o.type} · R${o.pins.r} G${o.pins.g} B${o.pins.b})</span>
       <button class="back" onclick="removeOutput(${idx})">remove</button>
       <p class="muted" style="margin-top:8px">${o.instruction || ''}</p>
     </div>`).join('');
}