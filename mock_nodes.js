/**
 * Silo Monitor — Mock Node Simulator
 * Sends fake sensor data to the backend, replacing physical ESP32 nodes.
 *
 * Usage:
 *   node mock_nodes.js --count 3 --interval 15 --url https://silofinal.onrender.com
 */

const https = require('https');
const http  = require('http');

// --- Settings (from command line args, with defaults) ---
const args     = process.argv.slice(2);
const get      = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i+1] : def; };
const COUNT    = parseInt(get('count', '3'));
const INTERVAL = parseInt(get('interval', '15'));
const SERVER_URL = get('url', 'https://silofinal.onrender.com');
const API_KEY  = 'demo123';

// --- Node states ---
// Each node has a base temperature/humidity and a "mode" (normal, warning, critical)
const nodes = Array.from({ length: COUNT }, (_, i) => ({
  id:   `mock-node-${String(i + 1).padStart(3, '0')}`,
  base: { temp: 5 + Math.random() * 5, hum: 89 + Math.random() * 6, mq: 100 + Math.random() * 80 },
  mode: Math.random() < 0.25 ? 'warning' : Math.random() < 0.1 ? 'critical' : 'normal',
  tick: 0,
}));

// --- Sensor math ---
function calcDewPoint(t, h) {
  const a = (17.27 * t) / (237.7 + t) + Math.log(h / 100);
  return (237.7 * a) / (17.27 - a);
}

function calcRisk(temp, hum, dew) {
  let risk = 0;
  if (temp > 8)  risk += (temp - 8) * 2;
  if (temp < 4)  risk += (4 - temp) * 3;
  if (hum > 95)  risk += (hum - 95) * 2;
  if (hum < 85)  risk += (85 - hum) * 2;
  if (temp - dew < 2) risk += 30;  // condensation
  return Math.min(100, Math.max(0, risk));
}

function jitter(range) { return (Math.random() - 0.5) * 2 * range; }

// --- Simulate one reading for a node ---
function simulate(node) {
  node.tick++;

  // Extra offset based on mode
  const extraTemp = node.mode === 'warning' ? 4 : node.mode === 'critical' ? 9 : 0;
  const extraMQ   = node.mode === 'warning' ? 80 : node.mode === 'critical' ? 250 : 0;

  const temp = node.base.temp + extraTemp + jitter(0.5);
  const hum  = node.base.hum + jitter(1.5);
  const mq   = node.base.mq  + extraMQ  + jitter(15);
  const dew  = calcDewPoint(temp, Math.min(100, Math.max(0, hum)));
  const risk = calcRisk(temp, hum, dew);

  return {
    deviceId:     node.id,
    temperature:  parseFloat(temp.toFixed(1)),
    humidity:     parseFloat(hum.toFixed(1)),
    mq_value:     parseFloat(mq.toFixed(0)),
    spoilageRisk: parseFloat(risk.toFixed(1)),
    dewPoint:     parseFloat(dew.toFixed(1)),
    grainHealth:  risk > 70 ? 'CRITICAL' : risk > 40 ? 'WARNING' : 'GOOD',
    rssi:         Math.floor(-70 + jitter(10)),
    ip:           `192.168.1.${10 + parseInt(node.id.slice(-1))}`,
  };
}

// --- HTTP POST ---
function post(payload) {
  const body = JSON.stringify(payload);
  const parsed = new URL(`${SERVER_URL}/api/data`);
  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => resolve(res.statusCode)
    );
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// --- Main loop ---
async function sendAll() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Sending data...`);
  for (const node of nodes) {
    const data   = simulate(node);
    const status = await post(data);
    const icon   = status === 200 ? '✅' : '❌';
    const mode   = node.mode === 'critical' ? '🚨' : node.mode === 'warning' ? '⚠️ ' : '✅';
    console.log(`  ${mode} ${node.id}  T:${data.temperature}°  H:${data.humidity}%  Risk:${data.spoilageRisk}%  HTTP:${status} ${icon}`);
  }
}

// --- Start ---
console.log('🌾 Silo Mock Nodes');
console.log(`   Server: ${SERVER_URL}`);
console.log(`   Nodes : ${COUNT}  Interval: ${INTERVAL}s\n`);
nodes.forEach(n => console.log(`   ${n.id}  [${n.mode}]  base_temp: ${n.base.temp.toFixed(1)}°C`));

sendAll();
setInterval(sendAll, INTERVAL * 1000);
