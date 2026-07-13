// the "you" page — the human's equivalent of a plant page:
// devices attached to you, and the data they sense about you.
let meSensor = null;

async function openMe() {
  showView('meView');
  document.getElementById('meTitle').textContent = '🧑 ' + currentUser.name;
  renderMeDevices();
  renderMeAttachChoices();
  loadMeSensors();
}

async function renderMeDevices() {
  const devices = await (await fetch('/users/' + currentUser.id + '/attached-devices')).json();
  const box = document.getElementById('meDevices');
  box.innerHTML = devices.length === 0
    ? '<p class="muted">No devices attached to you yet.</p>'
    : devices.map(d => `
        <div class="list-card">
          <span class="label clickable" onclick="openDevice('${d.device_id}','${d.device_id}','meView')">
            <strong>${d.device_id}</strong>
          </span>
          <button class="icon-btn" onclick="detachFromMe('${d.device_id}', event)">✕</button>
        </div>`).join('');
}

async function renderMeAttachChoices() {
  const devices = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  document.getElementById('meAttachPicker').innerHTML =
    devices.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('');
}

async function attachToMe() {
  const device_id = document.getElementById('meAttachPicker').value;
  if (!device_id) return;
  await fetch('/devices/' + device_id + '/attach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_type: 'human', target_id: currentUser.id })
  });
  renderMeDevices();
  loadMeSensors();
}

async function detachFromMe(deviceId, event) {
  event.stopPropagation();
  await fetch('/devices/' + deviceId + '/detach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  renderMeDevices();
  loadMeSensors();
}

async function loadMeSensors() {
  const sensors = await (await fetch('/users/' + currentUser.id + '/sensors')).json();
  const picker = document.getElementById('meSensorPicker');
  if (sensors.length === 0) {
    picker.innerHTML = '';
    document.getElementById('meData').innerHTML = '<p class="muted">No data yet — attach a device with sensors.</p>';
    meSensor = null;
    return;
  }
  picker.innerHTML = sensors.map(s => `<option>${s}</option>`).join('');
  meSensor = sensors[0];
  refreshMeData();
}

function onMeSensorChange() {
  meSensor = document.getElementById('meSensorPicker').value;
  refreshMeData();
}

async function refreshMeData() {
  if (!meSensor) return;
  const rows = await (await fetch('/users/' + currentUser.id + '/readings?sensor=' + encodeURIComponent(meSensor))).json();
  const vals = rows.map(r => r.value).slice(-100);
  const box = document.getElementById('meData');
  if (vals.length === 0) { box.innerHTML = '<p class="muted">No readings yet.</p>'; return; }
  box.innerHTML = `<p class="bigval">${vals[vals.length-1].toFixed(1)}</p>${sparkline(vals)}`;
}

// keep the "you" page live while open
setInterval(() => {
  if (document.getElementById('meView').classList.contains('active')) refreshMeData();
}, 2000);