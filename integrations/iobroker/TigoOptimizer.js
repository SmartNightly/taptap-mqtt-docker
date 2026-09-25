// ============================================================
// Tigo-Optimizer — JSON-State-Parser
// Version: 0.2.0
//
// Die taptap-mqtt-Bridge (Docker auf der NAS) published EINEN JSON-Blob nach
//   mqtt.0.tigo.tigo1.state
// (alle Optimierer + Statistik in einem String — HA-Discovery ist bewusst aus,
// daher entstehen keine Einzel-States über die Bridge selbst).
//
// Dieses Skript abonniert den State, parst das JSON und schreibt pro Optimierer
// einzelne numerische States nach javascript.0.Tigo.*, damit sie in InfluxDB
// geloggt und in Grafana dargestellt werden können.
//
// Nachts (kein PV) liefert die Bridge null/0 -> diese werden 1:1 übernommen.
//
// v0.2.0: setState-Rate-Limit-Schutz. Bei 31 Modulen × 11 Feldern × 4 Msg/min
// (UPDATE=15s) wurden ~1432 setState/min erreicht -> javascript.0 stoppt das
// Skript bei >1000/min. Gegenmassnahmen: (a) nur bei Wertänderung schreiben
// (setIfChanged), (b) Throttle MIN_APPLY_MS, (c) frisch angelegte Nodes erst im
// Folgezyklus beschreiben (kein createState/setState-Race). Zusätzlich Bridge
// UPDATE auf 30s.
// ============================================================

const SRC = 'mqtt.0.tigo.tigo1.state';
// Nur Cold-Start-Fallback (falls SRC beim Start leer). Im Normalbetrieb wird die
// Knotenliste aus dem JSON abgeleitet und neue Nodes werden dynamisch angelegt.
// Reale Anlage: String A = 16 Module (A01–A16), String B = 15 Module (B01–B15).
const NODES_FALLBACK = [
  ...Array.from({ length: 16 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 15 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`),
];

const NODE_METRICS = {
  voltage_in:  { unit: 'V',  role: 'value.voltage' },
  voltage_out: { unit: 'V',  role: 'value.voltage' },
  current_in:  { unit: 'A',  role: 'value.current' },
  current_out: { unit: 'A',  role: 'value.current' },
  power:       { unit: 'W',  role: 'value.power' },
  temperature: { unit: '°C', role: 'value.temperature' },
  duty_cycle:  { unit: '%',  role: 'value' },
  rssi:        { unit: '',   role: 'value' },
  energy:      { unit: 'Wh', role: 'value.power.consumption' },
};

// Statistik-Aggregate (Werte werden in apply() aus den Node-Werten berechnet,
// energy_daily aus stats.overall). Hier nur Anlage-Definition (Unit/Role).
const STATS_METRICS = {
  power_sum:       { unit: 'W',  role: 'value.power' },
  power_avg:       { unit: 'W',  role: 'value.power' },
  power_max:       { unit: 'W',  role: 'value.power' },
  temperature_avg: { unit: '°C', role: 'value.temperature' },
  temperature_max: { unit: '°C', role: 'value.temperature' },
  voltage_in_avg:  { unit: 'V',  role: 'value.voltage' },
  energy_daily:    { unit: 'Wh', role: 'value.power.consumption' },
};

// Zähler aus stats.overall.<a>.count
const STATS_COUNTS = {
  nodes_online:     ['nodes_online', 'count'],
  nodes_total:      ['nodes_total', 'count'],
  nodes_identified: ['nodes_identified', 'count'],
};

const created = new Set();
const nodeInit = new Set();          // Nodes, deren States bereits angelegt sind
const lastWritten = new Map();       // letzter geschriebener Wert je State-ID

function ensureState(id, def, common) {
  if (created.has(id)) return;
  created.add(id);
  createState(id, def, common);
}

// Nur schreiben, wenn sich der Wert ändert -> hält setState/min unter dem Limit.
function setIfChanged(id, val) {
  if (lastWritten.has(id) && lastWritten.get(id) === val) return;
  lastWritten.set(id, val);
  setState(id, val, true);
}

// Legt die States eines Nodes an. Rückgabe true, wenn ERSTMALS angelegt
// (dann diesen Zyklus nicht beschreiben -> kein createState/setState-Race).
function ensureNode(node) {
  if (nodeInit.has(node)) return false;
  nodeInit.add(node);
  for (const [m, meta] of Object.entries(NODE_METRICS)) {
    ensureState(`Tigo.${node}.${m}`, null, {
      type: 'number', read: true, write: false, unit: meta.unit, role: meta.role,
      name: `Tigo ${node}: ${m}`,
    });
  }
  ensureState(`Tigo.${node}.online`, false, {
    type: 'boolean', read: true, write: false, role: 'indicator.reachable',
    name: `Tigo ${node}: online`,
  });
  ensureState(`Tigo.${node}.serial`, '', {
    type: 'string', read: true, write: false, role: 'text',
    name: `Tigo ${node}: Seriennummer`,
  });
  return true;
}

function ensureStats() {
  for (const [k, meta] of Object.entries(STATS_METRICS)) {
    ensureState(`Tigo.stats.${k}`, null, {
      type: 'number', read: true, write: false, unit: meta.unit, role: meta.role,
      name: `Tigo Statistik: ${k}`,
    });
  }
  for (const k of Object.keys(STATS_COUNTS)) {
    ensureState(`Tigo.stats.${k}`, 0, {
      type: 'number', read: true, write: false, role: 'value',
      name: `Tigo Statistik: ${k}`,
    });
  }
}

function num(v) { return (v === null || v === undefined) ? null : v; }

function apply(raw) {
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) { log('Tigo: JSON-Parse-Fehler: ' + e, 'warn'); return; }

  const nodes = data.nodes || {};
  for (const [node, n] of Object.entries(nodes)) {
    // Frisch angelegte Nodes erst im Folgezyklus beschreiben (States existieren
    // dann sicher) -> vermeidet "State not found"-Race.
    if (ensureNode(node)) continue;
    for (const m of Object.keys(NODE_METRICS)) {
      setIfChanged(`Tigo.${node}.${m}`, num(n[m]));
    }
    setIfChanged(`Tigo.${node}.online`, n.state_online === 'online');
    setIfChanged(`Tigo.${node}.serial`, n.node_serial || '');
  }

  // Aggregate aus den Node-Werten berechnen. stats.overall der Bridge ist je nach
  // Tag/Nacht inkonsistent (Detail-Aggregate stehen nur unter stats.A / stats.B),
  // aus den Nodes ist es robust. energy_daily + Zähler kommen aber aus overall
  // (laufender Tages-Zähler bzw. Topologie, nicht aus Momentanwerten ableitbar).
  const vals = (key) => Object.values(nodes).map((n) => n[key]).filter((v) => v !== null && v !== undefined);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const max = (a) => (a.length ? Math.max(...a) : null);

  const pw = vals('power'), tp = vals('temperature'), vi = vals('voltage_in');
  setIfChanged('Tigo.stats.power_sum', pw.length ? sum(pw) : null);
  setIfChanged('Tigo.stats.power_avg', avg(pw));
  setIfChanged('Tigo.stats.power_max', max(pw));
  setIfChanged('Tigo.stats.temperature_avg', avg(tp));
  setIfChanged('Tigo.stats.temperature_max', max(tp));
  setIfChanged('Tigo.stats.voltage_in_avg', avg(vi));

  const ov = (data.stats && data.stats.overall) || {};
  setIfChanged('Tigo.stats.energy_daily', ov.energy ? num(ov.energy.daily) : null);
  for (const [k, path] of Object.entries(STATS_COUNTS)) {
    const [a, b] = path;
    setIfChanged(`Tigo.stats.${k}`, ov[a] ? (ov[a][b] || 0) : 0);
  }
}

// --- Startup: States anlegen (Knotenliste aus aktuellem Wert, sonst Fallback) ---
let nodeList = NODES_FALLBACK;
const cur = getState(SRC);
if (cur && cur.val) {
  try {
    const keys = Object.keys(JSON.parse(cur.val).nodes || {});
    if (keys.length) nodeList = keys;
  } catch (e) { /* Fallback bleibt */ }
}
nodeList.forEach(ensureNode);
ensureStats();

// Throttle: höchstens alle MIN_APPLY_MS verarbeiten. Schützt das setState-Limit
// auch, falls die Bridge UPDATE-Frequenz wieder gesenkt wird.
let lastApply = 0;
const MIN_APPLY_MS = 20000;

on({ id: SRC, change: 'any' }, (obj) => {
  if (Date.now() - lastApply < MIN_APPLY_MS) return;
  lastApply = Date.now();
  apply(obj.state.val);
});

// Initialwert verzögert anwenden, damit createState durch ist.
setTimeout(() => { const c = getState(SRC); if (c && c.val) { lastApply = Date.now(); apply(c.val); } }, 2500);

log('Tigo-Optimizer Parser v0.2.0 gestartet (Quelle: ' + SRC + ')', 'info');
