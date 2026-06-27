// ============================================================================
//  devices.js — the device list: showing the user's subscribed devices and
//  subscribing to new ones by id + nickname.
// ============================================================================

// list the devices this user follows; tapping one opens it (device.js).
async function loadDevices() {
  const devices = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  const list = document.getElementById('deviceList');
  list.innerHTML = devices.length === 0
    ? '<p class="muted">No devices yet — add one below.</p>'
    // NOTE: id/name are interpolated into an onclick string. Fine for the
    // device ids and nicknames used here; if a nickname could contain a quote
    // it would break this — not a concern for the workshop's simple names.
    : devices.map(d =>
        `<div class="device" onclick="openDevice('${d.id}','${d.name}')">
           <strong>${d.name}</strong><br><span class="muted">${d.id}</span>
         </div>`).join('');
}

// subscribe to a device by id, under a personal nickname (defaults to the id).
async function subscribe() {
  const id       = document.getElementById('newDeviceId').value.trim();
  const nickname = document.getElementById('newDeviceName').value.trim() || id;
  if (!id) return;

  await fetch('/devices/' + id + '/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id, nickname })
  });

  document.getElementById('newDeviceId').value = '';
  document.getElementById('newDeviceName').value = '';
  loadDevices();                              // refresh the list to show the new one
}