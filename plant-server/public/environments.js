async function openEnvironments() {
  showView('environmentsView');
  loadEnvironments();
}

async function loadEnvironments() {
  const envs = await (await fetch('/environments?user_id=' + currentUser.id)).json();
  const list = document.getElementById('environmentList');
  list.innerHTML = envs.length === 0
    ? '<p class="muted">No environments yet.</p>'
    : envs.map(e => `<div class="device" onclick="openEnvironment(${e.id}, '${e.name}')">
        <strong>🪴 ${e.name}</strong></div>`).join('');
}

async function addEnvironment() {
  const name = document.getElementById('newEnvName').value.trim();
  if (!name) return;
  await fetch('/environments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id, name })
  });
  document.getElementById('newEnvName').value = '';
  loadEnvironments();
}

// an environment's page: attach shared devices to it (they'll reach all its plants)
let currentEnv = null;
async function openEnvironment(id, name) {
  currentEnv = { id, name };
  showView('environmentView');
  document.getElementById('envTitle').textContent = '🪴 ' + name;
  renderEnvDevices();
  renderEnvPlants();
  const devices = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  const picker = document.getElementById('envAttachPicker');
  const attachRow = document.getElementById('envAttachRow');
  if (devices.length === 0) {
    attachRow.innerHTML = `<p class="muted">No devices yet.
      <button class="small-btn" onclick="showView('devicesView'); loadDevices()">Register a device →</button></p>`;
  } else {
    attachRow.innerHTML =
      `<select id="envAttachPicker">${devices.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('')}</select>
       <button onclick="attachToEnv()">Attach to environment</button>`;
  }
}
async function renderEnvDevices() {
  const rows = await (await fetch('/environments/' + currentEnv.id + '/devices')).json();
  const box = document.getElementById('envDevices');
  box.innerHTML = rows.length === 0
    ? '<p class="muted">No shared devices attached yet.</p>'
    : rows.map(d => `<div class="device"><strong>${d.device_id}</strong></div>`).join('');
}
async function renderEnvPlants() {
  const plants = await (await fetch('/environments/' + currentEnv.id + '/plants')).json();
  const box = document.getElementById('envPlants');
  box.innerHTML = plants.length === 0
    ? '<p class="muted">No plants in this environment yet. Assign plants to it from their pages.</p>'
    : plants.map(p => `<div class="device" onclick="openPlant(${p.id}, '${p.name}')">
        <strong>🌱 ${p.name}</strong></div>`).join('');
}

async function attachToEnv() {
  const device_id = document.getElementById('envAttachPicker').value;
  if (!device_id) return;
  await fetch('/devices/' + device_id + '/attach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_type: 'environment', target_id: currentEnv.id })
  });
  renderEnvDevices();
}


