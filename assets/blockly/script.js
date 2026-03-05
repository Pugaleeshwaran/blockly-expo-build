let workspace = null;

async function waitForBlockly(timeoutMs = 5000) {
  const t0 = Date.now();
  while (!(window.__blocklyLoaded && window.Blockly && Blockly.Python)) {
    await new Promise(r => setTimeout(r, 50));
    if (Date.now() - t0 > timeoutMs) break;
  }
  return !!(window.__blocklyLoaded && window.Blockly && Blockly.Python);
}

// =====================================================================
// BLUETOOTH LOGIC
// Dual-platform: Web Bluetooth for browser, ReactNativeWebView for mobile
// =====================================================================
const BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const BLE_CONTROL_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const BLE_DATA_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// Storage for discovered Web Bluetooth device objects (keyed by device.id)
let _foundBLEDevices = {};

// Web Bluetooth state (browser only)
let bleDevice = null;
let bleGattServer = null;
let bleControlChar = null;

/** True when running inside React Native WebView */
function isMobileApp() {
  return typeof window !== 'undefined' && !!window.ReactNativeWebView;
}

/** True when a BLE link is live (browser or mobile) */
function bleConnected() {
  if (isMobileApp()) {
    // Mobile connection state is managed by App.js; we trust the flag it sets
    return window._mobileBLEConnected === true;
  }
  return !!(bleDevice && bleDevice.gatt && bleDevice.gatt.connected);
}

// --- Modal helpers ---
function openBT() {
  document.getElementById('btModal').classList.add('open');
  document.getElementById('btModal').style.display = 'flex';
}
function closeBT() {
  document.getElementById('btModal').classList.remove('open');
  document.getElementById('btModal').style.display = 'none';
}

/** Called by App.js (mobile) or by browser connect flow to finalise UI */
function finalizeConnection(deviceName) {
  closeBT();
  window._mobileBLEConnected = true;
  handleBoardMessage("Connected ✅ " + deviceName);
  const pill = document.getElementById('bt-text');
  if (pill) pill.innerText = deviceName || "Connected";
}

// --- Scanning ---
async function startScan() {
  const deviceList = document.getElementById('deviceList');
  deviceList.innerHTML = '<div style="color:#00f5ff;text-align:center;padding:20px;">Scanning…</div>';

  if (isMobileApp()) {
    // Tell native App.js to start scanning; results come back via addDeviceToUI()
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "CONNECT_BLE" }));
    return;
  }

  // ── BROWSER: Web Bluetooth API (original working logic) ──
  if (!navigator.bluetooth) {
    deviceList.innerHTML = '<div style="color:red;text-align:center;">Web Bluetooth not supported in this browser.</div>';
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID]
    });
    deviceList.innerHTML = '';
    _foundBLEDevices[device.id] = device;
    addDeviceToUI(device.name || 'STM32', device.id, 'Link');
    // Auto-connect to the selected device
    await _connectBrowserBLE(device.id);
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      deviceList.innerHTML = '<div style="color:red;text-align:center;">Scan cancelled or failed.</div>';
    }
  }
}

/** Inject a device card into the BT modal list (called by mobile via injectJS too) */
function addDeviceToUI(name, id, rssi) {
  const list = document.getElementById('deviceList');
  // Clear placeholder text on first real result
  if (list.querySelector('div[style*="text-align:center"]')) {
    list.innerHTML = '';
  }

  // Prevent duplicates: update RSSI if we already have it
  const safeId = id.replace(/:/g, '-');
  let existingCard = document.getElementById('bt-card-' + safeId);
  if (existingCard) {
    existingCard.querySelector('.bt-rssi').innerText = rssi + ' dBm';
    return;
  }

  const card = document.createElement('div');
  card.id = 'bt-card-' + safeId;
  card.className = 'bt-card';
  card.innerHTML = `
        <div>
          <div class="bt-name">${name}</div>
          <div class="bt-mac">${id}</div>
        </div>
        <div class="bt-rssi">${rssi} dBm</div>`;
  card.onclick = () => connectToDevice(id);
  list.prepend(card);
}

/** Unified connect – routes to browser or mobile path */
async function connectToDevice(deviceId) {
  if (isMobileApp()) {
    handleBoardMessage("Connecting…");
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "SELECT_DEVICE",
      deviceId: deviceId
    }));
    return;
  }
  await _connectBrowserBLE(deviceId);
}

/** Browser-only Web Bluetooth GATT connect */
async function _connectBrowserBLE(deviceId) {
  try {
    handleBoardMessage("Connecting…");
    const device = _foundBLEDevices[deviceId];
    if (!device) throw new Error("Device object not in cache");

    // KEY FIX: If we already have an active GATT session (even to this same
    // device), disconnect it cleanly first. This prevents the old session
    // from delivering stale writes that make MicroPython print help().
    if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
      try {
        bleDevice.removeEventListener('gattserverdisconnected', _onBLEDisconnect);
        bleDevice.gatt.disconnect(); // synchronous – fires gattserverdisconnected
      } catch (_) { }
      // Small pause to let the disconnect event clear
      await new Promise(r => setTimeout(r, 200));
    }

    bleDevice = device;
    bleGattServer = null;
    bleControlChar = null;

    // Remove before adding to avoid duplicate listener accumulation across reconnects
    bleDevice.removeEventListener('gattserverdisconnected', _onBLEDisconnect);
    bleDevice.addEventListener('gattserverdisconnected', _onBLEDisconnect);

    bleGattServer = await bleDevice.gatt.connect();
    const service = await bleGattServer.getPrimaryService(BLE_SERVICE_UUID);
    bleControlChar = await service.getCharacteristic(BLE_CONTROL_UUID);

    finalizeConnection(bleDevice.name || 'STM32');
  } catch (e) {
    console.error("BLE connect error:", e);
    handleBoardMessage("Connection Failed ❌ " + e.message);
  }
}

function _onBLEDisconnect() {
  bleGattServer = null;
  bleControlChar = null;
  handleBoardMessage("BLE disconnected");
  const pill = document.getElementById('bt-text');
  if (pill) pill.innerText = "Bluetooth";
}

// --- Data transmission ---
/**
 * Send Python code via BLE.
 * Browser path: chunked 20-byte writes with 15 ms delay (original logic).
 * Mobile path:  delegate to App.js via postMessage.
 */
async function sendCodeToBLEBoot(code) {
  if (!code) return;

  if (isMobileApp()) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "SEND_DATA",
      data: code
    }));
    handleBoardMessage("Uploading via Bluetooth…");
    return;
  }

  // ── BROWSER: original chunked write logic ──
  if (!bleControlChar) {
    handleBoardMessage("BLE not connected");
    return;
  }

  const encoder = new TextEncoder();
  const payload = encoder.encode(code);

  try {
    // Send START marker
    await bleControlChar.writeValue(encoder.encode("@@START\n"));

    // Send code in safe 500-byte chunks with 15 ms gap to prevent buffer overflow
    for (let i = 0; i < payload.length; i += 500) {
      await bleControlChar.writeValue(payload.slice(i, i + 500));
      await new Promise(r => setTimeout(r, 15));
    }

    // Send END marker
    await bleControlChar.writeValue(encoder.encode("\n@@END"));
    handleBoardMessage("Upload Done! ✅");
  } catch (e) {
    console.error("BLE upload error:", e);
    handleBoardMessage("Upload Error ❌");
  }
}

// =====================================================================
// USB / Web Serial (Desktop only)
// =====================================================================
let stm32Port = null;
let stm32Writer = null;
let stm32Reader = null;
let stopUsbReader = false;
const stm32Encoder = new TextEncoder();

async function connectStm32() {
  if (!("serial" in navigator)) {
    alert("Web Serial not supported. Use Chrome/Edge desktop.");
    return;
  }
  try {
    stm32Port = await navigator.serial.requestPort();
    await stm32Port.open({ baudRate: 115200 });
    if (stm32Port.writable.locked && stm32Writer) {
      try { stm32Writer.releaseLock(); } catch (e) { console.log(e); }
    }
    stm32Writer = stm32Port.writable.getWriter();
    listenForData();
    handleBoardMessage("USB Connected ✅");
    setTimeout(() => handleBoardMessage("-"), 5000);
  } catch (e) {
    console.error("Failed to open port", e);
    alert("USB Connection failed: " + e.message);
  }
}

async function writeUserPyToBoard(code) {
  if (!stm32Port || !stm32Writer) { alert("Board not connected"); return; }
  const payload = `@@START\n${code}\n@@END`;
  try {
    await stm32Writer.write(stm32Encoder.encode(payload));
    handleBoardMessage("user.py sent via USB ✅");
  } catch (e) {
    console.error("USB write error:", e);
    alert("USB write failed: " + e.message);
  }
}

async function listenForData() {
  if (!stm32Port) return;
  const decoder = new TextDecoder();
  stm32Reader = stm32Port.readable.getReader();
  stopUsbReader = false;
  let buffer = "";
  try {
    while (!stopUsbReader) {
      const { value, done } = await stm32Reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lines = buffer.split("\n");
      buffer = lines.pop();
      for (let line of lines) {
        line = line.trim();
        if (line) handleBoardMessage(line);
      }
    }
  } catch (e) {
    if (!stopUsbReader) console.error("USB read error:", e);
  } finally {
    try { stm32Reader.releaseLock(); } catch { }
    stm32Reader = null;
  }
}

// =====================================================================
// Unified command sender (tries USB then BLE)
// =====================================================================
async function sendUnifiedCommand(commandName) {
  const encoder = new TextEncoder();

  if (stm32Port && stm32Writer) {
    try {
      await stm32Writer.write(encoder.encode(commandName + "\n"));
      handleBoardMessage(commandName + " sent via USB");
      return true;
    } catch (e) { console.error("USB send failed:", e); }
  }

  if (bleConnected() && bleControlChar) {
    try {
      await bleControlChar.writeValue(encoder.encode(commandName + "\n"));
      handleBoardMessage(commandName + " sent via BLE");
      return true;
    } catch (e) { console.error("BLE send failed:", e); }
  }

  if (isMobileApp()) {
    // Mobile: send command via bridge
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "COMMAND",
      command: commandName
    }));
    return true;
  }

  alert("No board connected! Please connect via USB or Bluetooth.");
  return false;
}

// =====================================================================
// Status display
// =====================================================================
function handleBoardMessage(msg) {
  console.log("Board:", msg);
  const el = document.getElementById("responseDisplay");
  if (el) el.innerText = msg;
}

// =====================================================================
// WiFi (MQTT)
// =====================================================================
function openWifiModal() { document.getElementById('wifiSettingsModal').style.display = 'block'; }
function closeWifiModal() { document.getElementById('wifiSettingsModal').style.display = 'none'; }

async function saveWifiSettings() {
  const ssid = document.getElementById('wifiSSID').value;
  const pass = document.getElementById('wifiPass').value;
  if (!ssid) { alert("Please enter an SSID"); return; }
  closeWifiModal();
  await sendWifiConfigOverBLE(ssid, pass);
}

async function sendWifiConfigOverBLE(ssid, password) {
  if (!navigator.bluetooth) { alert("Web Bluetooth not supported."); return; }
  const payload = `${ssid},${password}`;
  const encoder = new TextEncoder();
  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const char = await service.getCharacteristic(BLE_CONTROL_UUID);
    await char.writeValue(encoder.encode(payload));
    alert("WiFi Credentials sent ✅");
  } catch (error) {
    console.error("BLE WiFi Error:", error);
    alert("Failed to send WiFi config: " + error);
  }
}

async function sendCodeToESP32_MQTT(code) {
  const mqttClient = mqtt.connect('wss://3921b8461cb747b593a333f2aced8435.s1.eu.hivemq.cloud:8884/mqtt', {
    clientId: 'mqttjs_' + Math.random().toString(16).substr(2, 8),
    clean: true, connectTimeout: 10000, reconnectPeriod: 1000,
    protocolVersion: 5, username: 'ESP32', password: 'Esp@12345',
  });
  mqttClient.on('connect', function () {
    mqttClient.publish('esp32/boot', `@@START \n${code} \n @@END`);
    mqttClient.subscribe(['esp32/fire', 'esp32/ultrasonic', 'esp32/servo', 'esp32/led', 'esp32/motor', 'esp32/message']);
    handleBoardMessage("WiFi code sent ✅");
    setTimeout(() => handleBoardMessage("-"), 5000);
  });
  mqttClient.on('error', function (err) { console.error('MQTT error:', err); });
  mqttClient.on('message', function (topic, message) {
    const data = message.toString();
    console.log(`📩 ${topic}:`, data);
  });
}

// =====================================================================
// PORT / MOTOR / SERVO / LED MODALS
// =====================================================================
let currentPortBlock = null;
const ALL_PORT_NUMBERS = ["D3", "D4", "D5", "D6", "E3", "G4", "G5", "G6", "D7", "E0", "E1", "G3", "G0", "G1", "G2"];

function openPortSelectionModal(block) {
  currentPortBlock = block;
  const txt = block.getFieldValue('PORTS') || '';
  const selectedSet = new Set(txt.split(',').map(s => s.trim()).filter(Boolean));
  ALL_PORT_NUMBERS.forEach(p => {
    const cb = document.getElementById('port' + p);
    if (cb) cb.checked = selectedSet.has(String(p));
  });
  document.getElementById('portSelectionModal').style.display = 'block';
}
function closePortModal() { document.getElementById('portSelectionModal').style.display = 'none'; currentPortBlock = null; }
function savePortSelection() {
  if (!currentPortBlock) { closePortModal(); return; }
  const sel = [];
  ALL_PORT_NUMBERS.forEach(p => { const cb = document.getElementById('port' + p); if (cb && cb.checked) sel.push(String(p)); });
  currentPortBlock.setFieldValue(sel.length ? sel.join(',') : '—', 'PORTS');
  closePortModal();
}

let currentMotorBlock = null;
function openMotorSelectionModal(block) {
  currentMotorBlock = block;
  const selectedMotors = new Set((block.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()));
  ['E12', 'E11', 'C8', 'C9', 'B15', 'E13', 'E14', 'D15'].forEach(m => {
    const cb = document.getElementById('motor' + m);
    if (cb) cb.checked = selectedMotors.has(m);
  });
  document.getElementById('motorSelectionModal').style.display = 'block';
}
function closeModal() { document.getElementById('motorSelectionModal').style.display = 'none'; }
function saveMotorSelection() {
  if (!currentMotorBlock) { closeModal(); return; }
  const selected = [];
  ['E12', 'E11', 'C8', 'C9', 'B15', 'E13', 'E14', 'D15'].forEach(m => { const cb = document.getElementById('motor' + m); if (cb && cb.checked) selected.push(m); });
  currentMotorBlock.setFieldValue(selected.length ? selected.join(',') : '—', 'MOTORS');
  closeModal();
}

let currentLedBlock = null;
const LED_PIN_NAMES = ['C0', 'C1', 'C2', 'F9', 'A3', 'F3', 'F4', 'F5', 'C4', 'C5', 'A1', 'A2', 'A4', 'F8', 'A6'];
function openLedPinSelectionModal(block) {
  currentLedBlock = block;
  const txt = block.getFieldValue('PORTS') || '';
  const selected = new Set(txt.split(',').map(s => s.trim()).filter(Boolean));
  LED_PIN_NAMES.forEach(pin => { const cb = document.getElementById('ledPin' + pin); if (cb) cb.checked = selected.has(pin); });
  document.getElementById('ledPinSelectionModal').style.display = 'block';
}
function closeLedPinModal() { document.getElementById('ledPinSelectionModal').style.display = 'none'; currentLedBlock = null; }
function saveLedPinSelection() {
  if (!currentLedBlock) { closeLedPinModal(); return; }
  const sel = [];
  LED_PIN_NAMES.forEach(pin => { const cb = document.getElementById('ledPin' + pin); if (cb && cb.checked) sel.push(pin); });
  currentLedBlock.setFieldValue(sel.length ? sel.join(',') : '—', 'PORTS');
  closeLedPinModal();
}

// ── Speedometer ──
let speedStep = 0, speedPercent = 0, angle = 0, lastTouchX = null;
function addclass() {
  let ele = document.querySelector(".arrow-wrapper");
  if (!ele) return;
  for (let i = 1; i <= 7; i++) ele.classList.remove("arrow-speed-" + i);
  ele.classList.add("arrow-speed-" + speedStep);
}
function fast() { const f = document.getElementById("speed-val"); if (f) f.innerText = speedPercent; }
function updateGaugeUI() {
  const arrow = document.querySelector(".arrow-wrapper");
  if (arrow) arrow.style.transform = `rotate(${angle}deg)`;
  for (let i = 1; i <= 7; i++) {
    const scale = document.querySelector(".speed-scale-" + i);
    if (scale) { if (speedStep >= i - 1) scale.classList.add("active"); else scale.classList.remove("active"); }
  }
}
function inspeed() {
  if (speedStep < 6) {
    speedStep++; speedPercent = Math.min(100, Math.round(speedStep * 16.6));
    angle = speedStep * 30; addclass(); fast(); updateGaugeUI();
  }
}
function despeed() {
  if (speedStep > 0) {
    speedStep--; speedPercent = Math.round(speedStep * 16.6);
    angle = speedStep * 30; addclass(); fast(); updateGaugeUI();
  }
}
function setSpeedByStep(t) { t = Math.max(0, Math.min(6, t)); while (speedStep < t) inspeed(); while (speedStep > t) despeed(); }
function bindSpeedControls() {
  const inc = document.getElementById("btnIncrease");
  const dec = document.getElementById("btnDecrease");
  if (inc) inc.onclick = (e) => { e.stopPropagation(); inspeed(); };
  if (dec) dec.onclick = (e) => { e.stopPropagation(); despeed(); };
}
function bindSpeedoTouch() {
  const gauge = document.getElementById("speedoGauge");
  if (!gauge) return;
  gauge.style.touchAction = "none";
  gauge.onpointerdown = (e) => {
    if (e.target.closest("button")) return;
    const rect = gauge.getBoundingClientRect();
    let t = Math.round((e.clientX - rect.left) / rect.width * 6);
    setSpeedByStep(t); lastTouchX = e.clientX;
  };
  gauge.onpointermove = (e) => {
    if (lastTouchX === null) return;
    const diff = e.clientX - lastTouchX;
    if (diff > 25) { inspeed(); lastTouchX = e.clientX; }
    else if (diff < -25) { despeed(); lastTouchX = e.clientX; }
  };
  gauge.onpointerup = () => { lastTouchX = null; };
  gauge.onpointerleave = () => { lastTouchX = null; };
}
window.addEventListener("DOMContentLoaded", () => { bindSpeedControls(); bindSpeedoTouch(); });

// ── Unified Motor Modal ──
let currentUnifiedBlock = null;
function openUnifiedModal(block) {
  currentUnifiedBlock = block;
  const currentMotors = (block.getFieldValue('MOTORS') || '').split(',').map(s => s.trim());
  ['E12', 'E11', 'C8', 'C9', 'B15', 'E13', 'E14', 'D15'].forEach(m => {
    const cb = document.getElementById('uni_motor' + m);
    if (cb) cb.checked = currentMotors.includes(m);
  });
  let val = parseInt(block.getFieldValue('SPEED')) || 0;
  speedPercent = val; speedStep = Math.min(6, Math.round(val / 16.6)); angle = speedStep * 30;
  fast(); addclass(); updateGaugeUI();
  document.getElementById('unifiedMotorModal').style.display = 'flex';
  bindSpeedControls(); bindSpeedoTouch();
}
function closeUnifiedModal() { document.getElementById('unifiedMotorModal').style.display = 'none'; currentUnifiedBlock = null; }
function saveUnifiedSelection() {
  if (!currentUnifiedBlock) { closeUnifiedModal(); return; }
  const selected = [];
  ['E12', 'E11', 'C8', 'C9', 'B15', 'E13', 'E14', 'D15'].forEach(m => { const cb = document.getElementById('uni_motor' + m); if (cb && cb.checked) selected.push(m); });
  currentUnifiedBlock.setFieldValue(selected.length ? selected.join(',') : '', 'MOTORS');
  currentUnifiedBlock.setFieldValue(speedPercent, 'SPEED');
  closeUnifiedModal();
}

// ── Servo Modal ──
let currentServoBlock = null, currentServoAngle = 0, isDragging = false;
const MAX_ANGLE_LIMIT = 360;
function openServoSelectionModal(block) {
  currentServoBlock = block;
  const savedPorts = (block.getFieldValue('SERVO_PORT') || '').split(',').map(s => s.trim());
  document.querySelectorAll('#servoSelectionModal input[name="servoPort"]').forEach(cb => { cb.checked = savedPorts.includes(cb.value); });
  currentServoAngle = parseInt(block.getFieldValue('ANG')) || 0;
  updateServoUI();
  document.getElementById('servoSelectionModal').style.display = 'flex';
  initServoTouchControls();
}
function initServoTouchControls() {
  const meter = document.querySelector('.servo-meter');
  if (!meter) return;
  meter.onpointerdown = (e) => { isDragging = true; calculateAngleFromEvent(e, meter); meter.setPointerCapture(e.pointerId); };
  meter.onpointermove = (e) => { if (!isDragging) return; calculateAngleFromEvent(e, meter); };
  meter.onpointerup = () => { isDragging = false; };
  meter.onpointercancel = () => { isDragging = false; };
}
function calculateAngleFromEvent(e, element) {
  const rect = element.getBoundingClientRect();
  const x = e.clientX - (rect.left + rect.width / 2);
  const y = e.clientY - (rect.top + rect.height / 2);
  let a = Math.atan2(y, x) * (180 / Math.PI) + 90;
  if (a < 0) a += 360;
  currentServoAngle = Math.round(a);
  updateServoUI();
}
function changeServoAngle(amount) {
  currentServoAngle = Math.max(0, Math.min(MAX_ANGLE_LIMIT, currentServoAngle + amount));
  updateServoUI();
}
function updateServoUI() {
  const at = document.getElementById("angle-text");
  if (at) at.innerText = currentServoAngle + "°";
  const fill = document.getElementById("servoFill");
  if (fill) fill.style.setProperty('--angle', currentServoAngle + 'deg');
  const needle = document.getElementById("servoNeedle");
  if (needle) needle.style.transform = `rotate(${currentServoAngle}deg)`;
}
function saveServoSelection() {
  if (!currentServoBlock) return;
  const selected = [];
  document.querySelectorAll('#servoSelectionModal input[name="servoPort"]').forEach(cb => { if (cb.checked) selected.push(cb.value); });
  currentServoBlock.setFieldValue(selected.join(','), 'SERVO_PORT');
  currentServoBlock.setFieldValue(currentServoAngle.toString(), 'ANG');
  closeServoModal();
}
function closeServoModal() { document.getElementById('servoSelectionModal').style.display = 'none'; currentServoBlock = null; }

// =====================================================================
// GRADIENTS & SHADOWS
// =====================================================================
function addGradientDefs() {
  const svg = document.querySelector('svg.blocklySvg');
  if (!svg) { setTimeout(addGradientDefs, 50); return; }
  let defs = svg.querySelector('defs');
  if (!defs) { defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); svg.prepend(defs); }
  function mkGrad(id, stops) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    g.setAttribute('id', id); g.setAttribute('x1', '0%'); g.setAttribute('y1', '0%');
    g.setAttribute('x2', '0%'); g.setAttribute('y2', '100%');
    stops.forEach(s => {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute('offset', s.offset); stop.setAttribute('stop-color', s.color);
      if (s.opacity !== undefined) stop.setAttribute('stop-opacity', s.opacity);
      g.appendChild(stop);
    });
    defs.appendChild(g);
  }
  mkGrad('gradDefault', [{ offset: '0%', color: '#BBE8F2' }, { offset: '50%', color: '#2685BF' }, { offset: '100%', color: '#BBE8F2' }]);
  mkGrad('gradled', [{ offset: '0%', color: '#BF0413' }, { offset: '50%', color: '#BF0B2C' }, { offset: '100%', color: '#8C041D' }]);
  mkGrad('dummy_style', [{ offset: '0%', color: '#B2F252' }, { offset: '50%', color: '#79A637' }, { offset: '100%', color: '#EFF299' }]);
  mkGrad('graddc', [{ offset: '0%', color: '#F2A922' }, { offset: '50%', color: '#D97A07' }, { offset: '100%', color: '#F2921D' }]);
  mkGrad('temp_style', [{ offset: '0%', color: '#9F2CBF' }, { offset: '50%', color: '#73168C' }, { offset: '100%', color: '#9F2CBF' }]);
  mkGrad('gradServo', [{ offset: '0%', color: '#F2ACC6' }, { offset: '50%', color: '#F266C1' }, { offset: '100%', color: '#F2ACC6' }]);
  mkGrad('ultra_style', [{ offset: '0%', color: '#8C5946' }, { offset: '50%', color: '#593A28' }, { offset: '100%', color: '#D9B29C' }]);
  function mkShadow(id, dx, dy, std, color) {
    const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    f.setAttribute('id', id); f.setAttribute('x', '-50%'); f.setAttribute('y', '-50%');
    f.setAttribute('width', '200%'); f.setAttribute('height', '200%');
    const ds = document.createElementNS("http://www.w3.org/2000/svg", "feDropShadow");
    ds.setAttribute('dx', dx); ds.setAttribute('dy', dy); ds.setAttribute('stdDeviation', std);
    ds.setAttribute('flood-color', color); f.appendChild(ds); defs.appendChild(f);
  }
  mkShadow('blueShadow', 2, 2, 5, '#2685BF'); mkShadow('dcshodow', 2, 2, 5, '#D97A07');
  mkShadow('ledshodow', 2, 5, 5, '#D99CA7'); mkShadow('servoshodow', 2, 2, 5, '#F279BC');
  mkShadow('dummyshadow', 2, 3, 5, '#79A637'); mkShadow('tempshadow', 2, 3, 5, '#593A28');
  mkShadow('ultrashowdow', 2, 2, 5, '#8B22A8');
}
function applyGradientAndShadowToBlock(block) {
  const blockPath = block.svgGroup_?.querySelector('.blocklyPath');
  if (!blockPath) return;
  blockPath.setAttribute('fill', 'url(#gradDefault)');
  const shadows = {
    start: 'blueShadow', port_on: 'ledshodow', port_off: 'ledshodow',
    sen_ultrasonic: 'ledshodow', sen_temp: 'ledshodow',
    do_onoff: 'servoshodow', do_dc_motor: 'servoshodow', do_servo: 'servoshodow',
    bt_send: 'servoshodow', do_led: 'servoshodow', ctl_delay: 'dummyshadow',
    do_led_param: 'dummyshadow', lp_while: 'dcshodow', lp_break: 'dcshodow',
    lp_repeat_count: 'dcshodow', lp_label: 'dcshodow', sensor: 'tempshadow',
    tem_sensor: 'tempshadow', xray_sensor: 'tempshadow', rc_sensor: 'tempshadow',
    mini_motor: 'ultrashowdow', remote_motor: 'ultrashowdow', water_motor: 'ultrashowdow',
    din_if_else: 'ultrashowdow', din_sound: 'ultrashowdow', tank_motor: 'ultrashowdow'
  };
  if (shadows[block.type]) blockPath.setAttribute('filter', 'url(#' + shadows[block.type] + ')');
}
function applyToAllBlocks() {
  Blockly.getMainWorkspace().getAllBlocks().forEach(b => applyGradientAndShadowToBlock(b));
}
function setupGradientAndShadowOnBlocks() {
  Blockly.getMainWorkspace().addChangeListener((e) => {
    if (e.type === Blockly.Events.BLOCK_CREATE || e.type === Blockly.Events.BLOCK_CHANGE) applyToAllBlocks();
  });
}
function killBlueSelection() {
  const style = document.createElement('style');
  style.textContent = `
        svg.blocklySvg .blocklySelected { filter: none !important; }
        svg.blocklySvg .blocklySelected > .blocklyPath { stroke: none !important; stroke-width: 0 !important; }
        svg.blocklySvg .blocklySelected > .blocklyPathLight { display: none !important; }
      `;
  document.head.appendChild(style);
}

// =====================================================================
// BLOCK DEFINITIONS
// =====================================================================
function defineBlocks() {
  Blockly.defineBlocksWithJsonArray([
    {
      type: "start",
      message0: "Start %1 return %2",
      args0: [{
        type: "input_statement",
        name: "DO"
      }, {
        type: "input_value"
        , name: "VALUE"
      }],
      nextStatement: null,
      extensions: ["defult_style"]
    },
    {
      type: "port_on",
      args0: [{
        type: "field_image",
        src: "./assets/img/robo.png",
        width: 35,
        height: 35,
        alt: "",
        name: "IMG1",
        class: "hover-animate"
      },
      {
        type: "field_label",
        name: "LABEL",
        text: "Digi ON"
      },
      {
        type: "field_image",
        src: "./assets/img/Chips_Chips_Show.png"
        , width: 15,
        height: 15,
        alt: "",
        name: "IMG",
        class: "hover-animate"
      },
      {
        type: "field_label"
        , name: "PORTS",
        text: ""
      }],
      message0: "%1 %2 %3 %4",
      colour: "#ffb56a",
      previousStatement: null,
      nextStatement: null,
      extensions: ["port_on_img_click", "led_style"]
    },
    {
      type: "port_off",
      message0: "DigitalOut OFF %1 %2",
      args0: [{
        type: "field_image",
        src: "./assets/img/Chips_Chips_Show.png",
        width: 15,
        height: 15,
        alt: "",
        name: "IMG"
      },
      {
        type: "field_label",
        name: "PORTS",
        text: ""
      }
      ],
      colour: "#ffb56a",
      previousStatement: null,
      nextStatement: null,
      extensions: ["port_image_click", "led_style"]
    },
    {
      type: "sen_ultrasonic",
      message0: "ultrasonic distance on port %1",
      args0: [{
        type: "field_number",
        name: "PORT",
        value: 2,
        min: 0,
        max: 99
      }],
      style: "control_blocks",
      previousStatement: null,
      nextStatement: null,
      extensions: ["led_style"]
    },
    { type: "sen_temp", message0: "temperature on port %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", previousStatement: null, nextStatement: null, extensions: ["led_style", "led_pin_image_click"] },
    { type: "do_onoff", message0: "digital write pins %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "do_dc_motor", message0: "DC Motor %1 %2 speed %3 %4 %5", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "Config", name: "IMG", class: "hover-animate" }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_number", name: "SPEED", value: 60, min: 0, max: 100 }, { type: "field_label", text: "%" }, { type: "field_dropdown", name: "STATE", options: [["forward", "forward"], ["backward", "backward"], ["stop", "stop"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["motor_image_click", "servo_color"] },
    { type: "do_dc_motor2", message0: "DC Motor %1 %2 %3", args0: [{ type: "field_image", name: "IMG", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15 }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["forward", "forward"], ["backward", "backward"], ["stop", "stop"], ["turn left", "turn left"], ["turn right", "turn right"]] }], colour: "#FF69B4", previousStatement: null, nextStatement: null, extensions: ["motor_image_click2", "servo_color"] },
    { type: "do_servo", message0: "servo on %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "SERVO_PORT", text: "" }, { type: "field_number", name: "ANG", value: 45, min: 0, max: 360, precision: 1 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["servo_image_click", "servo_color"] },
    { type: "bt_send", message0: "Bluetooth send %1", args0: [{ type: "input_value", name: "TEXT" }], previousStatement: null, nextStatement: null, style: "control_blocks", extensions: ["servo_color"] },
    { type: "do_led", message0: "LED %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "ctl_delay", message0: "Sleep%1 ms", args0: [{ type: "field_number", name: "MS", value: 500, min: 0, max: 600000 }], style: "led_blocks", previousStatement: null, nextStatement: null, extensions: ["dummy_style"] },
    { type: "lp_while", message0: "while %1", args0: [{ type: "input_value", name: "COND", check: "Boolean" }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, extensions: ["dc_color"] },
    { type: "lp_break", message0: "break", previousStatement: null, nextStatement: null, extensions: ["dc_color"] },
    { type: "lp_start", message0: "@@start", previousStatement: null, nextStatement: null, extensions: ["dc_color"] },
    { type: "lp_repeat_count", message0: "repeat %1 %2 times", args0: [{ type: "field_number", name: "PIN" }, { type: "field_number", name: "COUNT", value: 4, min: 0, max: 100000 }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, extensions: ["dc_color"] },
    { type: "lp_label", message0: "Print %1", args0: [{ type: "input_value", name: "NAME" }], previousStatement: null, nextStatement: null, extensions: ["dc_color"] },
    { type: "din_if_else", message0: "if %1", args0: [{ type: "input_value", name: "COND", check: "Boolean" }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], message2: "else %1", args2: [{ type: "input_statement", name: "ELSE" }], style: "control_blocks", previousStatement: null, nextStatement: null, extensions: ["temp_style"] },
    { type: "din_sound", message0: "SOUND CELL %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_tilt", message0: "TILT %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_door", message0: "MAGNETIC SWITCH %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_button", message0: "BUTTON %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_motion", message0: "MOTION SENSOR %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "light_freq", message0: "LIGHT Frequency %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_proximity", message0: "PROXIMITY %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_ir", message0: "IR %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "din_flame", message0: "FLAME %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "load_cell", message0: "Load Cell %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "do_led_param", message0: "LED write %1 %2 value %3 time %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "VAL" }, { type: "field_number", name: "VAL2" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["led_pin_image_click", "dummy_style"] },
    { type: "mini_motor", message0: "Mini Motor %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_number", name: "SPEED", value: 60, min: -100, max: 100, precision: 1 }, { type: "field_label", text: "%" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["motor_image_click", "temp_style"] },
    { type: "remote_motor", message0: "remote Motor %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_number", name: "SPEED", value: 10, min: -100, max: 100, precision: 1 }, { type: "field_label", text: "%" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["motor_image_click", "temp_style"] },
    { type: "water_motor", message0: "water Motor %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_number", name: "SPEED", value: 40, min: -100, max: 100, precision: 1 }, { type: "field_label", text: "%" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["motor_image_click", "temp_style"] },
    { type: "tank_motor", message0: "tank Motor %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "MOTORS", text: "" }, { type: "field_number", name: "SPEED", value: 40, min: -100, max: 100, precision: 1 }, { type: "field_label", text: "%" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["motor_image_click", "temp_style"] },
    { type: "sensor", message0: "ultra sonic %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "ultra_style"] },
    { type: "tem_sensor", message0: "tem sonic %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "ultra_style"] },
    { type: "xray_sensor", message0: "xray sonic %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "ultra_style"] },
    { type: "rc_sensor", message0: "rc sensor %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["ON", "1"], ["OFF", "0"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "ultra_style"] },
    { type: "logical_comparison", message0: "%1 %2 %3", args0: [{ type: "input_value", name: "VALUE1" }, { type: "field_dropdown", name: "OPERATOR", options: [["<", "<"], [">", ">"], [" == ", "=="], [" >= ", ">="], [" <= ", "<="], [" != ", "!="]] }, { type: "input_value", name: "VALUE2" }], colour: "#4C97FF", output: "Boolean", inputsInline: true },
    { type: "red_led", message0: "Red LED %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "VAL1", value: 1, min: 0, max: 100, precision: 1 }, { type: "field_number", name: "VAL2", value: 1, min: 0, max: 100, precision: 1 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["led_pin_image_click", "dummy_style"] },
    { type: "yellow_led", message0: "YELLOW LED %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "VAL1", value: 1, min: 0, max: 100, precision: 1 }, { type: "field_number", name: "VAL2", value: 1, min: 0, max: 100, precision: 1 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["led_pin_image_click", "dummy_style"] },
    { type: "green_led", message0: "GREEN LED %1 %2 %3 %4", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "VAL1", value: 1, min: 0, max: 100, precision: 1 }, { type: "field_number", name: "VAL2", value: 1, min: 0, max: 100, precision: 1 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["led_pin_image_click", "dummy_style"] },
    { type: "water-turbidity-sensor", message0: "turbidity %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "servo_color"] },
    { type: "steper", message0: "stepper Motor %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "SPEED", value: 60, min: 0, max: 100 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "waterpump", message0: "Water Pump %1 %2 Angle %3 °", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "ANGLE", value: 60, min: 0 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "solinoid", message0: "Solinoid Valve %1 %2 Value %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["0", "0"], ["1", "1"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "animo", message0: "Anemo Meter %1 %2 Value %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["0", "0"], ["1", "1"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "relay", message0: "Relay %1 %2 Value %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["0", "0"], ["1", "1"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "loop_end", message0: "End the Loop %1", args0: [{ type: "field_input", name: "NAME", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "buzzer", message0: "buzzer %1 %2 %3 %4 %5", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "VAL1" }, { type: "field_number", name: "VAL2" }, { type: "field_number", name: "VAL3" }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "minifan", message0: "Mini fan %1 %2 %3", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_dropdown", name: "STATE", options: [["forward", "forward"], ["backward", "backward"], ["stop", "stop"]] }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "rgb_component", message0: "rgb_component %1 %2 %3 %4 %5", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "freq", value: 0 }, { type: "field_number", name: "Delay1", value: 255 }, { type: "field_number", name: "DELAY2", value: 0 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "shock_sensor", message0: "Shock Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "flex-sensor", message0: "flex %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "servo_color"] },
    { type: "humidity", message0: "Huminity %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "servo_color"] },
    { type: "buzzer_component", message0: "buzzer_component %1 %2 %3 %4 %5", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }, { type: "field_number", name: "freq", value: 1 }, { type: "field_number", name: "Delay1", value: 1000 }, { type: "field_number", name: "DELAY2", value: 1000 }], colour: "#81d4ed", previousStatement: null, nextStatement: null, extensions: ["port_image_click", "servo_color"] },
    { type: "joystick_move", args0: [{ type: "field_label", name: "LABEL", text: "joystick" }, { type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG", class: "hover-animate" }, { type: "field_label", name: "PORTS", text: "" }], message0: "%1 %2 %3", colour: "#ffb56a", output: "Boolean", extensions: ["port_image_click", "servo_color"] },
    { type: "Air_quality_sensor", message0: "Air-quality-sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "flexi_force_sensor", message0: "Flexi Force Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "TDS_Water_sensor", message0: "TDS Water Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "LCD_print", message0: "LCD %1", args0: [{ type: "input_value", name: "TEXT" }], previousStatement: null, nextStatement: null, extensions: ["servo_color"] },
    { type: "din_temp", message0: "temperature sensor pin %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "water_sensor", message0: "Water Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["servo_color", "led_pin_image_click"] },
    { type: "any_input_block", message0: "%1", args0: [{ type: "field_input", name: "ANY", text: "1" }], output: null, colour: 230 },
    { type: "custom_if_then", message0: "if %1 then %2", args0: [{ type: "input_value", name: "CONDITION", check: "Boolean" }, { type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, colour: 69, extensions: ["led_style"] },
    { type: "tep_ana", message0: "Temputure ana Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "heart_beat", message0: "heart beat %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "ldr", message0: "LDR %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "soil_moisture", message0: "Soil Moisture %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "dust", message0: "dust %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "vibration-switch-sensor", message0: "vibration %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "Current-sensor", message0: "Current %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "IR-Temp", message0: "IR Temp %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "temp2-sensor", message0: "temp01 %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "ecg", message0: "EGC %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "ana_temp", message0: "Analog Temputure %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "led_pin_image_click"] },
    { type: "magnetic_sensor", message0: "Magnetic sensor pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "colour_sen", message0: "Colour", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "system_status", message0: "System Status Running", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "accelerometer_sensor", message0: "Accelerometer sensor pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "rtc_sensor", message0: "Rtc sensor pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "LCD", message0: "LCD pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "pressure", message0: "Pressure pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "compass", message0: "compass", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "ceprom", message0: "ceprom", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "gusture", message0: "Gusture", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "ir_temp", message0: "IR temp", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "motor_driver", message0: "Motor Driver", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "nfc_reader", message0: "NFC Reader", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "mag_encoder", message0: "Mag Encoder", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "text_speech", message0: "Text Speech", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "rfc", message0: "RFC", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "touch_sensor", message0: "Touch Sensor", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "uv_sensor", message0: "UV Sensor", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "temp_sensor", message0: "Temp Sensor", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "accelerometer", message0: "Accelerometer", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "ir_sen", message0: "IR Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["temp_style", "port_image_click"] },
    { type: "ambient-sen", message0: "Ambient sensor pin", style: "control_blocks", output: "Boolean", extensions: ["temp_style"] },
    { type: "din_ultra", message0: "Ultra Sonic sensor pin %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "voltage_sensor", message0: "Voltage Sensor %1 %2", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_label", name: "PORTS", text: "" }], style: "control_blocks", output: "Boolean", extensions: ["led_pin_image_click", "temp_style"] },
    { type: "rgb_display", message0: "display %1 %2 %3 %4 %5", args0: [{ type: "field_colour", name: "RED", colour: "#FF0000" }, { type: "field_colour", name: "ORANGE", colour: "#FFA500" }, { type: "field_colour", name: "YELLOW", colour: "#FFFF00" }, { type: "field_colour", name: "GREEN", colour: "#008000" }, { type: "field_colour", name: "CYAN", colour: "#00FFFF" }], colour: 160, previousStatement: null, nextStatement: null, extensions: ["servo_color"] },
    { type: "rgb_led_display", message0: "%1 LED %2 displays %3 for %4 secs", args0: [{ type: "field_image", src: "./assets/img/Chips_Chips_Show.png", width: 15, height: 15, alt: "", name: "IMG" }, { type: "field_dropdown", name: "LED", options: [["all", "ALL"], ["1", "1"], ["2", "2"], ["3", "3"]] }, { type: "field_colour_hsv_sliders", name: "COLOR", colour: "#ff0000" }, { type: "input_value", name: "TIME", check: "Number" }], previousStatement: null, nextStatement: null, colour: "#9F2CBF", extensions: ["temp_style"] },
  ]);

  // Extensions
  Blockly.Extensions.register('port_on_img_click', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openPortSelectionModal(this));
  });
  Blockly.Extensions.register('port_image_click', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openPortSelectionModal(this));
  });
  Blockly.Extensions.register('motor_image_click', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openUnifiedModal(this));
  });
  Blockly.Extensions.register('motor_image_click2', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openMotorSelectionModal(this));
  });
  Blockly.Extensions.register('servo_image_click', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openServoSelectionModal(this));
  });
  Blockly.Extensions.register('led_pin_image_click', function () {
    const f = this.getField('IMG'); if (!f) return;
    f.setOnClickHandler(() => openLedPinSelectionModal(this));
  });

  // Style extensions
  function mkStyleExt(name, cls) {
    Blockly.Extensions.register(name, function () {
      const block = this;
      block.setOnChange(function () { if (block.svgGroup_) block.svgGroup_.classList.add(cls); });
    });
  }
  mkStyleExt('defult_style', 'defult_style');
  mkStyleExt('servo_color', 'block-servo');
  mkStyleExt('led_style', 'led_style');
  mkStyleExt('dummy_style', 'dummy_block');
  mkStyleExt('temp_style', 'temp_style');
  mkStyleExt('dc_color', 'block_dc');
  mkStyleExt('ultra_style', 'ultra_style');
}

// =====================================================================
// PYTHON GENERATORS
// =====================================================================
function defineGenerators() {
  const py = Blockly.Python;

  function pinCode(block, field, fn) {
    const txt = block.getFieldValue(field) || '';
    const pins = txt.split(',').map(s => s.trim()).filter(Boolean);
    if (!pins.length) return `# ${fn}: no pins selected\n`;
    return pins.map(p => `${fn}(${p})\n`).join('');
  }
  function pinOutput(block, fn) {
    const txt = block.getFieldValue('PORTS') || '';
    const pins = txt.split(',').map(p => p.trim()).filter(Boolean);
    if (!pins.length) return ['# Invalid: no port', py.ORDER_NONE];
    return [`${fn}(${pins.map(p => `"${p}"`).join(',')})`, py.ORDER_FUNCTION_CALL];
  }

  py['do_led'] = b => {
    const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ports.length) return "# do_led: no ports selected\n";
    const fn = b.getFieldValue('STATE') === '1' ? 'robot.led_on' : 'robot.led_off';
    return ports.map(p => `${fn}(${p})\n`).join('');
  };
  py['bt_send'] = b => { const t = py.valueToCode(b, 'TEXT', py.ORDER_NONE) || "''"; return `robot.bt_send(${t})\n`; };
  py['sen_ultrasonic'] = b => `distance = robot.ultrasonic_cm(${b.getFieldValue('PORT') || 0})\n`;
  py['sen_temp'] = b => { const pins = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!pins.length) return "# no pins\n"; return pins.map(p => `temp_port(${p})\n`).join(''); };
  py['do_onoff'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return "# do_onoff: no ports\n"; const fn = b.getFieldValue('STATE') === '1' ? 'robot.port_on' : 'robot.port_off'; return ports.map(p => `${fn}(${p})\n`).join(''); };
  py['port_on'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()); return ports.map(p => `robot.port_on(${p})\n`).join(''); };
  py['port_off'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()); return ports.map(p => `robot.port_off(${p})\n`).join(''); };
  py['do_dc_motor'] = b => { const speed = b.getFieldValue('SPEED') || 0; const ports = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); const state = b.getFieldValue('STATE'); if (!ports.length) return "# No motors\n"; if (ports.length === 1) return `control_motor("${ports[0]}",${speed},${state})\n`; return `control.motor(${ports.map(p => `"${p}"`).join(',')},${speed},${state})\n`; };
  py['start'] = b => { const body = py.statementToCode(b, 'DO') || '    pass\n'; const value = py.valueToCode(b, 'VALUE', py.ORDER_NONE) || ''; return `def start(${value}):\n${body}\n`; };
  py['do_dc_motor2'] = b => { const angle = b.getFieldValue('STATE') || 0; const ports = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# Motor: no port\n'; if (ports.length === 1) return `motor("${ports[0]}","${angle}")\n`; return `motor(${ports.map(p => `"${p}"`).join(',')}, "${angle}")\n`; };
  py['do_servo'] = b => { const ports = (b.getFieldValue('SERVO_PORT') || '').split(',').map(s => s.trim()).filter(Boolean); const angle = b.getFieldValue('ANG') || 0; if (!ports.length) return "# do_servo: no port\n"; if (ports.length === 1) return `servo("${ports[0]}",${angle})\n`; return `servo(${ports.map(p => `"${p}"`).join(',')},${angle})\n`; };
  py['ctl_delay'] = b => `time.sleep(${b.getFieldValue('MS') || 0})\n`;
  py['lp_while'] = b => { const cond = py.valueToCode(b, 'COND', py.ORDER_NONE) || 'False'; const body = py.statementToCode(b, 'DO') || '  pass\n'; return `while ${cond}:\n${body}`; };
  py['lp_break'] = () => 'break\n';
  py['lp_start'] = () => '@@START\n';
  py['lp_repeat_count'] = b => { const n = +b.getFieldValue('COUNT') || 0; const body = py.statementToCode(b, 'DO') || '  pass\n'; return `for _ in range(${n}):\n${body}`; };
  py['lp_label'] = b => { const name = py.valueToCode(b, 'NAME', py.ORDER_NONE); return `print(${name || ''})\n`; };
  py['din_if_else'] = b => { const cond = py.valueToCode(b, 'COND', py.ORDER_NONE) || 'False'; const doS = py.statementToCode(b, 'DO') || '  pass\n'; const elseS = py.statementToCode(b, 'ELSE') || '  pass\n'; return `if ${cond}:\n${doS}else:\n${elseS}\n`; };
  py['do_led_param'] = b => { const pins = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const v1 = b.getFieldValue('VAL') || 0; const v2 = b.getFieldValue('VAL2') || 0; if (!pins.length) return "# do_led_param: no pins\n"; return pins.map(p => `led_blink('${p}',${v1},${v2})\n`).join(''); };
  py['logical_comparison'] = b => { const v1 = py.valueToCode(b, 'VALUE1', py.ORDER_NONE); const op = b.getFieldValue('OPERATOR'); const v2 = py.valueToCode(b, 'VALUE2', py.ORDER_NONE); return [`${v1} ${op} ${v2}`, py.ORDER_RELATIONAL]; };
  py['red_led'] = b => { const pins = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const v1 = b.getFieldValue('VAL1') || 1; const v2 = b.getFieldValue('VAL2') || 1; if (!pins.length) return "# red_blink: no pins\n"; return pins.map(p => `red_blink("${p}",${v1},${v2})\n`).join(''); };
  py['yellow_led'] = b => { const pins = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const v1 = b.getFieldValue('VAL1') || 1; const v2 = b.getFieldValue('VAL2') || 1; if (!pins.length) return "# yellow_blink: no pins\n"; return pins.map(p => `yellow_blink("${p}",${v1},${v2})\n`).join(''); };
  py['green_led'] = b => { const pins = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const v1 = b.getFieldValue('VAL1') || 1; const v2 = b.getFieldValue('VAL2') || 1; if (!pins.length) return "# green_blink: no pins\n"; return pins.map(p => `green_blink("${p}",${v1},${v2})\n`).join(''); };

  // Sensor output blocks
  const sensorOutputMap = { din_sound: 'sound', din_tilt: 'tilt', din_door: 'get_door', din_button: 'button', din_motion: 'motion', light_freq: 'light_freq', din_proximity: 'get_proximity', din_ir: 'get_ir', din_flame: 'get_flame', load_cell: 'load_cell', tep_ana: 'temp_ana_sensor', heart_beat: 'heart_beat', ldr: 'LDR', soil_moisture: 'soil_moisture', dust: 'dust', 'vibration-switch-sensor': 'vibration_sensor', 'Current-sensor': 'current', 'IR-Temp': 'IrTemp', 'temp2-sensor': 'tempanalog', ecg: 'ecg', ana_temp: 'ana_temp', shock_sensor: 'shock_sensor', 'flex-sensor': 'flex', humidity: 'humidity', joystick_move: 'joy_stick', Air_quality_sensor: 'air_quality_sensor', flexi_force_sensor: 'flexi_sensor', TDS_Water_sensor: 'tds_sensor', 'water-turbidity-sensor': 'waterturbidity', ir_sen: 'IR', din_ultra: 'ultrasonic', voltage_sensor: 'voltage', water_sensor: 'water_sen' };
  Object.entries(sensorOutputMap).forEach(([type, fn]) => {
    py[type] = b => {
      const pins = (b.getFieldValue('PORTS') || '').split(',').map(p => p.trim()).filter(Boolean);
      if (!pins.length) return ['# Invalid: no port', py.ORDER_NONE];
      return [`${fn}(${pins.map(p => `"${p}"`).join(',')})`, py.ORDER_FUNCTION_CALL];
    };
  });

  py['sensor'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return "# no ports\n"; const fn = b.getFieldValue('STATE') === '1' ? 'sensor_on' : 'sensor_off'; return ports.map(p => `${fn}(${p})\n`).join(''); };
  py['tem_sensor'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return "# no ports\n"; const fn = b.getFieldValue('STATE') === '1' ? 'tem_sensor_on' : 'tem_sensor_off'; return ports.map(p => `${fn}(${p})\n`).join(''); };
  py['xray_sensor'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return "# no ports\n"; const fn = b.getFieldValue('STATE') === '1' ? 'xray_sensor_on' : 'xray_sensor_off'; return ports.map(p => `${fn}(${p})\n`).join(''); };
  py['rc_sensor'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return "# no ports\n"; const fn = b.getFieldValue('STATE') === '1' ? 'rc_sensor_on' : 'rc_sensor_off'; return ports.map(p => `${fn}(${p})\n`).join(''); };
  py['steper'] = b => { const speed = +b.getFieldValue('SPEED') || 0; const motors = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!motors.length) return '# Stepper: no port\n'; if (motors.length === 1) return `get_stepper("${motors[0]}",${speed})\n`; return `get_stepper(${motors.map(p => `"${p}"`).join(',')},${speed})\n`; };
  py['waterpump'] = b => { const angle = b.getFieldValue('ANGLE') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# Waterpump: no port\n'; if (ports.length === 1) return `get_waterpump("${ports[0]}",${angle})\n`; return `get_waterpump(${ports.map(p => `"${p}"`).join(',')},${angle})\n`; };
  py['solinoid'] = b => { const angle = b.getFieldValue('STATE') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# Solinoid: no port\n'; if (ports.length === 1) return `get_solinoid("${ports[0]}",${angle})\n`; return `get_solinoid(${ports.map(p => `"${p}"`).join(',')},${angle})\n`; };
  py['animo'] = b => { const angle = b.getFieldValue('STATE') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# Animo: no port\n'; if (ports.length === 1) return `get_animo("${ports[0]}",${angle})\n`; return `get_animo(${ports.map(p => `"${p}"`).join(',')},${angle})\n`; };
  py['relay'] = b => { const angle = b.getFieldValue('STATE') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# relay: no port\n'; if (ports.length === 1) return `relay("${ports[0]}",${angle})\n`; return `relay(${ports.map(p => `"${p}"`).join(',')},${angle})\n`; };
  py['buzzer'] = b => { const v1 = b.getFieldValue('VAL1') || 0; const v2 = b.getFieldValue('VAL2') || 0; const v3 = b.getFieldValue('VAL3') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# Buzzer: no port\n'; if (ports.length === 1) return `get_buzzer("${ports[0]}",${v1},${v2},${v3})\n`; return `get_buzzer(${ports.map(p => `"${p}"`).join(',')},${v1},${v2},${v3})\n`; };
  py['minifan'] = b => { const state = b.getFieldValue('STATE') || 0; const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!ports.length) return '# MINI FAN: no port\n'; if (ports.length === 1) return `mini_fan("${ports[0]}","${state}")\n`; return `mini_fan(${ports.map(p => `"${p}"`).join(',')},"${state}")\n`; };
  py['loop_end'] = b => `${b.getFieldValue('NAME') || ''}\n`;
  py['mini_motor'] = b => { const motors = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!motors.length) return "# No motors\n"; return motors.map(() => `red_blink("F4",1,1)\n`).join(''); };
  py['remote_motor'] = b => { const motors = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!motors.length) return "# No motors\n"; return motors.map(() => `yellow_blink("G5",1,1)\n`).join(''); };
  py['water_motor'] = b => { const motors = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!motors.length) return "# No motors\n"; return motors.map(() => `green_blink("B15",1,1)\n`).join(''); };
  py['tank_motor'] = b => { const speed = b.getFieldValue('SPEED') || 0; const motors = (b.getFieldValue('MOTORS') || '').split(',').map(s => s.trim()).filter(Boolean); if (!motors.length) return "# No motors\n"; return motors.map(m => `tank_motor("${m}",${speed})\n`).join(''); };
  py['rgb_display'] = b => `displayRGBColors(${b.getFieldValue('RED')},${b.getFieldValue('ORANGE')},${b.getFieldValue('YELLOW')},${b.getFieldValue('GREEN')},${b.getFieldValue('CYAN')});\n`;
  py['rgb_component'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const freq = b.getFieldValue('freq'); const d1 = b.getFieldValue('Delay1'); const d2 = b.getFieldValue('DELAY2'); if (!ports.length) return "# rgb_component: no ports\n"; return ports.map(p => `rgb("${p}",${freq},${d1},${d2})\n`).join(''); };
  py['buzzer_component'] = b => { const ports = (b.getFieldValue('PORTS') || '').split(',').map(s => s.trim()).filter(Boolean); const freq = b.getFieldValue('freq') || 1; const d1 = b.getFieldValue('Delay1') || 1000; const d2 = b.getFieldValue('DELAY2') || 1000; if (!ports.length) return "# buzzer_component: no ports\n"; return ports.map(p => `buzzer("${p}",${freq},${d1},${d2})\n`).join(''); };
  py['LCD_print'] = b => { const txt = py.valueToCode(b, 'TEXT', py.ORDER_NONE) || ""; return `lcd(${txt})\n`; };
  py['din_flame'] = b => { const port = b.getFieldValue('PORTS'); return [`get_flame("${port}")`, py.ORDER_NONE]; };
  py['din_temp'] = b => { const port = b.getFieldValue('PORTS'); return [`temp("${port}")`, py.ORDER_NONE]; };
  py['magnetic_sensor'] = () => [`magnetic()`, py.ORDER_ATOMIC];
  py['colour_sen'] = () => [`colour()`, py.ORDER_ATOMIC];
  py['system_status'] = () => [`system_status.running`, py.ORDER_ATOMIC];
  py['accelerometer_sensor'] = () => [`accelerometer()`, py.ORDER_ATOMIC];
  py['rtc_sensor'] = () => [`rtc()`, py.ORDER_ATOMIC];
  py['LCD'] = () => [`LCD()`, py.ORDER_ATOMIC];
  py['pressure'] = () => [`pressure()`, py.ORDER_ATOMIC];
  py['compass'] = () => [`compass()`, py.ORDER_ATOMIC];
  py['ceprom'] = () => [`ceprom()`, py.ORDER_ATOMIC];
  py['gusture'] = () => [`gusture()`, py.ORDER_ATOMIC];
  py['ir_temp'] = () => [`ir_temp()`, py.ORDER_ATOMIC];
  py['motor_driver'] = () => [`motor_driver()`, py.ORDER_ATOMIC];
  py['nfc_reader'] = () => [`nfc_reader()`, py.ORDER_ATOMIC];
  py['mag_encoder'] = () => [`mag_encoder()`, py.ORDER_ATOMIC];
  py['rfc'] = () => [`rfc()`, py.ORDER_ATOMIC];
  py['text_speech'] = () => [`text_speech()`, py.ORDER_ATOMIC];
  py['uv_sensor'] = () => [`uv_sensor()`, py.ORDER_ATOMIC];
  py['temp_sensor'] = () => [`temp_sensor()`, py.ORDER_ATOMIC];
  py['accelerometer'] = () => [`accelerometer()`, py.ORDER_ATOMIC];
  py['ambient-sen'] = () => [`ambient()`, py.ORDER_ATOMIC];
  py['any_input_block'] = b => [b.getFieldValue('ANY'), py.ORDER_ATOMIC];
  py['custom_if_then'] = b => { const cond = py.valueToCode(b, 'CONDITION', py.ORDER_NONE) || 'False'; const stmts = py.statementToCode(b, 'DO'); return `if ${cond}:\n${stmts || '    pass\n'}`; };
  py['rgb_led_display'] = b => { const led = b.getFieldValue('LED'); const hex = b.getFieldValue('COLOR') || "#ff0000"; const time = py.valueToCode(b, 'TIME', py.ORDER_ATOMIC) || 1; const r = parseInt(hex.substring(1, 3), 16); const g = parseInt(hex.substring(3, 5), 16); const bv = parseInt(hex.substring(5, 7), 16); return `rgb_led("${led}",${r},${g},${bv},${time})\n`; };
}

// =====================================================================
// APP START
// =====================================================================
async function start() {

  document.getElementById("btnConnect").onclick = () => connectStm32();

  const ok = await waitForBlockly();
  if (!ok) { console.error('Blockly/Python failed to load'); return; }



  const Theme = Blockly.Theme.defineTheme('rndmfg_glass', {
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: '#ffffff',
      toolboxBackgroundColour: 'rgba(15,23,42,0.7)',
      toolboxForegroundColour: '#e5e7eb',
      flyoutBackgroundColour: 'rgba(15,23,42,0.95)',
      flyoutForegroundColour: '#e5e7eb',
      flyoutOpacity: 1,
      insertionMarkerColour: '#38bdf8',
      insertionMarkerOpacity: 0.0,
      scrollbarColour: '#94a3b8',
      selectedGlowColour: 'transparent',
      selectedGlowOpacity: 0,
      selectedGlowSize: 1,
      cursorColour: '#facc15'
    }
  });

  defineBlocks();
  defineGenerators();

  workspace = Blockly.inject('blocklyDiv', {
    toolbox: document.getElementById('toolbox'),
    theme: Theme,
    renderer: 'zelos',
    grid: { spacing: 30, length: 7, colour: '#b7b7b7', snap: true },
    trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 2.0, minScale: 0.4 },
    move: { scrollbars: true, drag: true, wheel: true },
    sound: true
  });

  addGradientDefs();
  killBlueSelection();
  setupGradientAndShadowOnBlocks();


  const styleEl = document.createElement('style');
  styleEl.textContent = `
  .blocklySelected > .blocklyPath {
    pointer-events: none !important;
  }
  .blocklySelected image,
  .blocklySelected .blocklyEditableText,
  .blocklySelected .blocklyText {
    pointer-events: all !important;
  }
`;
  document.head.appendChild(styleEl);

  workspace.addChangeListener(function (event) {
    if (event.type === Blockly.Events.SELECTED || event.type === Blockly.Events.BLOCK_MOVE) {
      setTimeout(function () {
        document.querySelectorAll('.blocklySelected > .blocklyPath')
          .forEach(function (el) { el.style.pointerEvents = 'none'; });
        document.querySelectorAll('.blocklySelected image, .blocklySelected .blocklyEditableText')
          .forEach(function (el) { el.style.pointerEvents = 'all'; });
      }, 0);
    }
  });
  // ===== END ZELOS GLOW FIX =====

  const audio = workspace.getAudioManager();
  audio.SOUNDS_ = {};
  audio.load(["./assets/blockly/sounds/block_merge.mpeg"], "click");
  audio.load(["./assets/blockly/sounds/cancel.mp3"], "delete");
  audio.load(["./assets/blockly/sounds/error.mp3"], "error");

  workspace.addChangeListener((ev) => {
    if (ev.type === Blockly.Events.BLOCK_MOVE && ev.isStart) audio.play("click");
  });
  workspace.addChangeListener((ev) => {
    if (ev.type === Blockly.Events.BLOCK_DELETE) audio.play("delete");
  });
  Blockly.Connection.prototype.highlightForError = function () { audio.play("error"); };

  const pyOut = document.getElementById('pyOut');
  function updateCode() {
    const code = Blockly.Python.workspaceToCode(workspace);
    pyOut.textContent = code || '# (no blocks yet)';
    try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'py_preview', code })); } catch (e) { }
  }
  workspace.addChangeListener(updateCode);
  updateCode();

  // ── Button Handlers ──

  // PLAY
  document.getElementById("playmode").onclick = async () => { await sendUnifiedCommand("PLAY"); };

  // STOP
  document.getElementById("stop").onclick = async () => { await sendUnifiedCommand("STOP"); };

  // SOFT RESET
  document.getElementById("soft_reset").onclick = async () => {
    const ok = await sendUnifiedCommand("SOFT_RESET");
    if (ok) handleBoardMessage("Soft Reset triggered");
  };

  // HARD RESET
  document.getElementById("hard_reset").onclick = async () => {
    const ok = await sendUnifiedCommand("HARD_RESET");
    if (ok) handleBoardMessage("Hardware Rebooting…");
  };

  // BLUETOOTH button – open scan popup
  document.getElementById("btnBluetooth").onclick = () => {
    openBT();
  };

  // UPLOAD button
  document.getElementById("upload").onclick = async () => {
    const code = Blockly.Python.workspaceToCode(workspace);
    if (!code.trim()) { alert("Please drag some blocks first!"); return; }

    if (isMobileApp()) {
      // Mobile: hand off to App.js via bridge
      handleBoardMessage("Uploading via Bluetooth…");
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "SEND_DATA", data: code }));
      return;
    }

    // Desktop: USB first, then BLE
    if (stm32Port && stm32Writer) {
      await writeUserPyToBoard(code);
      return;
    }
    if (bleConnected()) {
      await sendCodeToBLEBoot(`UPLOAD ${code}`);
      return;
    }
    alert("No board connected. Please connect via USB or Bluetooth.");
  };

  // BOOT (save user.py via USB)
  document.getElementById('btnboot').onclick = async () => {
    const code = Blockly.Python.workspaceToCode(workspace);
    if (stm32Port && stm32Writer) {
      await writeUserPyToBoard(code);
      handleBoardMessage("user.py saved on board");
    } else {
      alert("USB not connected.");
    }
  };

  // SAVE (download XML)
  document.getElementById('btnSave').onclick = async () => {
    const code = Blockly.Python.workspaceToCode(workspace);
    if (!code.trim()) { alert("No code to save"); return; }
    const xml = Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(workspace));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([xml], { type: 'text/xml' }));
    a.download = 'program.xml'; a.click();
    URL.revokeObjectURL(a.href);
  };

  // LOAD
  document.getElementById('btnLoad').onclick = async () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xml,text/xml';
    inp.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const t = await file.text();
      loadXml(t);
    };
    inp.click();
  };

  function loadXml(text) {
    if (!text) return;
    workspace.clear();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(text), workspace);
  }

  // CLEAR
  document.getElementById('btnClear').onclick = () => { workspace.clear(); updateCode(); };

  // SHOW/HIDE CODE PANEL
  const showCode = document.getElementById("showCode");
  const codePanel = document.querySelector(".code");
  const mainSection = document.querySelector(".main");
  showCode.addEventListener("click", function () {
    codePanel.classList.toggle("show");
    mainSection.classList.toggle("main1");
    setTimeout(() => { Blockly.svgResize(workspace); workspace.scrollCenter(); }, 50);
  });

  // Default starting block
  const demo = `
      <xml xmlns="https://developers.google.com/blockly/xml">
        <block type="start" x="40" y="40">
          <field name="NAME">when Start Button clicked</field>
        </block>
      </xml>`;
  Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(demo), workspace);
}

window.addEventListener('load', start);
