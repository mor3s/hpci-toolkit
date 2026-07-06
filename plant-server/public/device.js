// ============================================================================
//  device.js — the single-device view: live sensor graph + output (light)
//  control with the claim/release write-lock. Plus hexToRgb, shared with
//  builder.js (all files share one global scope — see app.js).
// ============================================================================

let deviceReturnTo = 'devicesView'; 

// open a device: decide whether it's set up yet, then show the right thing.
// A fresh (unconfigured) device shows only the Setup prompt; a configured one
// shows the live sensor graph + output controls.
async function openDevice(id, name, returnTo) {
  console.log('openDevice called with returnTo =', returnTo);
  currentDevice = id;
  deviceReturnTo = returnTo || 'devicesView';   // remember where we came from
  document.getElementById('deviceTitle').textContent = name;
  showView('deviceView');

  const config = await (await fetch('/devices/' + id + '/config')).json();
  const hasSetup = (config.inputs && config.inputs.length) || (config.outputs && config.outputs.length);

  const liveBits    = document.getElementById('deviceLiveBits');
  const setupPrompt = document.getElementById('deviceSetupPrompt');

  if (!hasSetup) {
    liveBits.style.display = 'none';
    setupPrompt.style.display = 'block';
    return;
  }
  liveBits.style.display = 'block';
  setupPrompt.style.display = 'none';

  const sensors = await (await fetch('/devices/' + id + '/sensors')).json();
  document.getElementById('sensorPicker').innerHTML = sensors.map(s => `<option>${s}</option>`).join('');
  currentSensor = sensors[0] || null;
  history = [];
  loadOutputControl();
}

// ============================================================================
//  OUTPUT CONTROL + THE WRITE-LOCK
//  Only the lock-holder may change an output. The UI reflects who holds it.
// ============================================================================
async function loadOutputControl() {
  const config = await (await fetch('/devices/' + currentDevice + '/config')).json();
  const owner  = await (await fetch('/devices/' + currentDevice + '/owner')).json();
  const holder = owner.owner_id;
  const isMine = holder === currentUser.id;
  const box = document.getElementById('outputControl');

  const outputs = config.outputs || [];
  if (outputs.length === 0) { box.innerHTML = '<p class="muted">No outputs on this device.</p>'; return; }

  // header: the lock state + the claim/release action appropriate to it
  let html = '';
  if (holder === null) {
    html += `<p class="muted">No one is controlling this.
              <button onclick="claim()">Take control</button></p>`;
  } else if (isMine) {
    html += `<p class="muted">You're in control.
              <button class="back" onclick="release()">Release</button></p>`;
  } else {
    html += `<p class="muted">🔒 Controlled by someone else — you can watch but not change it.</p>`;
  }

  // one colour picker per output — disabled unless the lock is yours
  for (const o of outputs) {
    html += `<div class="device">
      <strong>${o.name}</strong><br>
      <input type="color" ${isMine ? '' : 'disabled'} onchange="setColor('${o.name}', this.value)">
      <span class="muted" id="status_${o.name}"></span>
    </div>`;
  }
  box.innerHTML = html;
}

async function claim() {
  const res = await fetch('/devices/' + currentDevice + '/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id })
  });
  if (!res.ok) { const info = await res.json(); alert('Could not take control — held by ' + info.held_by); }
  loadOutputControl();
}

async function release() {
  await fetch('/devices/' + currentDevice + '/release', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id })
  });
  loadOutputControl();
}

// set an output's colour (desired), then check shortly after whether the ESP
// has confirmed it (the desired-vs-reported round trip).
async function setColor(name, hex) {
  const color = hexToRgb(hex);
  const res = await fetch('/devices/' + currentDevice + '/outputs/' + name + '/desired', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id, color })
  });

  const status = document.getElementById('status_' + name);
  if (!res.ok) { status.textContent = 'failed'; return; }
  status.textContent = 'sent — waiting for the light…';
  setTimeout(() => confirmColor(name, color), 1500);     // give the ESP a moment to apply + report
}

async function confirmColor(name, wanted) {
  const states = await (await fetch('/devices/' + currentDevice + '/outputs/state')).json();
  const st = states.find(s => s.output_name === name);
  const r = st && st.reported;
  const matches = r && r.r === wanted.r && r.g === wanted.g && r.b === wanted.b;
  document.getElementById('status_' + name).textContent =
    matches ? '✓ the light is on' : '⚠ no confirmation from the light';
}

// "#ff0080" -> {r:255, g:0, b:128}. Shared: builder.js uses this too (act steps).
function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

// ============================================================================
//  NAVIGATION + SENSOR PICK
// ============================================================================
function onSensorChange() {
  currentSensor = document.getElementById('sensorPicker').value;
  history = [];                               // new sensor → fresh graph
}

function goBack() {
  console.log('goBack, returnTo =', deviceReturnTo);
  currentDevice = null; currentSensor = null;
  if (deviceReturnTo === 'plantView' && currentPlant) {
    openPlant(currentPlant.id, currentPlant.name);   // return to the plant we came from
  } else {
    showView('devicesView');
    loadDevices();
  }
}
// ============================================================================
//  LIVE DATA LOOP + GRAPH
//  refresh() polls the selected sensor's readings every 2s; p5's draw() renders
//  the rolling history. Both no-op unless a device + sensor are selected.
// ============================================================================
let history = [];

async function refresh() {
  if (!currentDevice || !currentSensor) return;
  const rows = await (await fetch('/readings/' + currentDevice)).json();
  history = rows.filter(r => r.sensor_name === currentSensor)
                .map(r => r.value)
                .slice(-100);                 // keep only the last 100 points
  if (history.length)
    document.getElementById('currentValue').textContent = history[history.length - 1].toFixed(1);
}
setInterval(refresh, 2000);

// ---- p5: draw the rolling line graph ----
// NOTE: p5 claims many short global names (line, text, color, map, random,
// width, height…). Don't name your own helpers those — it caused real bugs.
function setup() {
  const c = createCanvas(440, 240);
  c.parent('canvasHolder');
}
function draw() {
  background(244, 240, 230);                  // --paper, to match the notebook skin
  if (history.length < 2) return;
  const lo = Math.min(...history), hi = Math.max(...history);
  stroke(90, 122, 82); strokeWeight(2); noFill();   // --moss
  beginShape();
  for (let i = 0; i < history.length; i++)
    vertex(map(i, 0, history.length - 1, 0, width), map(history[i], lo, hi, height - 20, 20));
  endShape();
}