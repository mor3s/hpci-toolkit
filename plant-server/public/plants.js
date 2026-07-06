
let currentPlant = null;   // declared once, at the top
// --- plant live data ---
let plantSensor = null;
let plantHistory = [];
console.log('plants.js loaded — version with plantView');


async function openPlants() {
  showView('plantsView');
  loadPlants();
}
async function openPlant(id, name) {
  currentPlant = { id, name };
  showView('plantView');
  document.getElementById('plantTitle').textContent = '🌱 ' + name;
  renderPlantDevices();
  renderAttachChoices();
  renderEnvPicker();
  loadPlantSensors();
}

async function detachDevice(deviceId, event) {
  event.stopPropagation();
  await fetch('/devices/' + deviceId + '/detach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  renderPlantDevices();
  loadPlantSensors();     // its data no longer belongs to this plant
}
async function renderEnvPicker() {
  const envs = await (await fetch('/environments?user_id=' + currentUser.id)).json();
  const plant = (await (await fetch('/plants?user_id=' + currentUser.id)).json()).find(p => p.id === currentPlant.id);
  const sel = document.getElementById('plantEnvPicker');
  sel.innerHTML = '<option value="">— none —</option>' +
    envs.map(e => `<option value="${e.id}" ${plant && Number(plant.environment_id) === e.id ? 'selected' : ''}>${e.name}</option>`).join('');
}

async function setPlantEnvironment() {
  const environment_id = document.getElementById('plantEnvPicker').value || null;
  await fetch('/plants/' + currentPlant.id + '/environment', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environment_id })
  });
  renderPlantDevices();       // its device list may change (env devices now count)
}
async function loadPlants() {
  const plants = await (await fetch('/plants?user_id=' + currentUser.id)).json();
  const envs   = await (await fetch('/environments?user_id=' + currentUser.id)).json();
  const list  = document.getElementById('plantList');
  const intro = document.getElementById('plantsIntro');

  if (plants.length === 0) {
    intro.innerHTML = 'Name the plants you\'re working with, then attach devices to them to sense and care for them.';
    list.innerHTML = '';
    return;
  }
  intro.innerHTML = '';

  const plantCard = (p) =>
    `<div class="device" onclick="openPlant(${p.id}, '${p.name}')"><strong>🌱 ${p.name}</strong></div>`;

  let html = '';

  // one box per environment, with its plants inside — but only if it HAS plants
  for (const env of envs) {
    const members = plants.filter(p => Number(p.environment_id) === env.id);
    if (members.length === 0) continue;        // skip empty environments on the home
    html += `<div class="env-group">
      <div class="env-group-title" onclick="openEnvironment(${env.id}, '${env.name}')">🪴 ${env.name}</div>
      ${members.map(plantCard).join('')}
    </div>`;
  }

  // plants not in any environment
  const loose = plants.filter(p => !p.environment_id);
  if (loose.length) {
    html += `<div class="section-title" style="margin-top:16px">Not in an environment</div>` +
            loose.map(plantCard).join('');
  }

  list.innerHTML = html;
}


async function renderPlantDevices() {
  const devices = await (await fetch('/plants/' + currentPlant.id + '/devices')).json();
  const box = document.getElementById('plantDevices');

  if (devices.length > 0) {
    box.innerHTML = devices.map(d => `
      <div class="list-card">
        <span class="label clickable" onclick="openDevice('${d.device_id}','${d.nickname || d.device_id}','plantView')">
          <strong>${d.nickname || d.device_id}</strong>
          <span class="muted">${d.device_id}${d.target_type === 'environment' ? ' · via environment' : ''}</span>
        </span>
        ${d.target_type === 'environment'
          ? '<span class="muted" style="font-size:12px">shared</span>'
          : `<button class="icon-btn" onclick="detachDevice('${d.device_id}', event)">✕</button>`}
      </div>`).join('');
    return;
  }

  // no devices attached — is that because the user has none at all?
  const mine = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  box.innerHTML = mine.length === 0
    ? `<p class="muted">No devices yet. You'll need to register one first.</p>
       <button onclick="showView('devicesView'); loadDevices()">+ Register a device</button>`
    : `<p class="muted">No devices attached to this plant yet — pick one below.</p>`;
}

// offer the user's subscribed devices to attach to this plant
async function renderAttachChoices() {
  const devices = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  const sel = document.getElementById('attachPicker');
  sel.innerHTML = devices.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('');
}

async function attachDevice() {
  const device_id = document.getElementById('attachPicker').value;
  if (!device_id) return;
  await fetch('/devices/' + device_id + '/attach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_type: 'plant', target_id: currentPlant.id })
  });
  renderPlantDevices();
}

async function addPlant() {
  const name = document.getElementById('newPlantName').value.trim();
  if (!name) return;
  await fetch('/plants', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id, name })
  });
  document.getElementById('newPlantName').value = '';
  loadPlants();
}

async function loadPlantSensors() {
  const sensors = await (await fetch('/plants/' + currentPlant.id + '/sensors')).json();
  const picker = document.getElementById('plantSensorPicker');
  if (sensors.length === 0) {
    picker.innerHTML = '';
    document.getElementById('plantData').innerHTML = '<p class="muted">No data yet — attach a device with sensors, and wait for readings.</p>';
    plantSensor = null;
    return;
  }
  picker.innerHTML = sensors.map(s => `<option>${s}</option>`).join('');
  plantSensor = sensors[0];
  refreshPlantData();
}

function onPlantSensorChange() {
  plantSensor = document.getElementById('plantSensorPicker').value;
  plantHistory = [];
  refreshPlantData();
}

async function refreshPlantData() {
  if (!currentPlant || !plantSensor) return;
  const rows = await (await fetch('/plants/' + currentPlant.id + '/readings?sensor=' + encodeURIComponent(plantSensor))).json();
  plantHistory = rows.map(r => r.value).slice(-100);
  const box = document.getElementById('plantData');
  if (plantHistory.length === 0) { box.innerHTML = '<p class="muted">No readings yet.</p>'; return; }
  const latest = plantHistory[plantHistory.length - 1];
  box.innerHTML = `<p class="bigval">${latest.toFixed(1)}</p>${sparkline(plantHistory)}`;
}

// a tiny inline SVG sparkline — no p5, no canvas conflict
function sparkline(values) {
  const w = 440, h = 120, pad = 10;
  const lo = Math.min(...values), hi = Math.max(...values), span = (hi - lo) || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1 || 1)) * (w - 2 * pad);
    const y = h - pad - ((v - lo) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" style="max-width:100%">
    <polyline points="${pts}" fill="none" stroke="var(--moss)" stroke-width="2"/>
  </svg>`;
}

setInterval(() => {
  if (document.getElementById('plantView').classList.contains('active')) refreshPlantData();
}, 2000);