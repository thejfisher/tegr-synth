/**
 * TEGR Synthesizer — Main Application
 * ====================================
 * Wires together: AudioWorklet, Web MIDI, UI controls, piano keyboard,
 * oscilloscope, phase wheel, mode switching, and ER=EPR entanglement.
 */

// ── Audio Engine Globals ────────────────────────────────────
let audioCtx   = null;
let workletNode = null;
let analyser    = null;
let isRunning   = false;

// ── Application State ───────────────────────────────────────
const state = {
  mode:    'natural',
  erepr:   false,
  locks:   {},
  activeKeys: new Set(),         // currently pressed computer keys
  activeNotes: new Set(),        // currently sounding MIDI notes
  vizData: { voices: [], erepr: null },
};

// ── Keyboard Mapping ────────────────────────────────────────
// Lower octave (C3–B3): computer keys → MIDI notes 48–59
// Upper octave (C4–B4): computer keys → MIDI notes 60–71
const KEY_MAP_LOWER = {
  'z': 48, 's': 49, 'x': 50, 'd': 51, 'c': 52,
  'v': 53, 'g': 54, 'b': 55, 'h': 56, 'n': 57,
  'j': 58, 'm': 59,
};
const KEY_MAP_UPPER = {
  'q': 60, '2': 61, 'w': 62, '3': 63, 'e': 64,
  'r': 65, '5': 66, 't': 67, '6': 68, 'y': 69,
  '7': 70, 'u': 71,
};
const KEY_MAP = { ...KEY_MAP_LOWER, ...KEY_MAP_UPPER };

// Reverse map for showing key hints on piano
const NOTE_TO_KEY = {};
for (const [k, v] of Object.entries(KEY_MAP)) NOTE_TO_KEY[v] = k.toUpperCase();

// ── Initialize Audio Engine ─────────────────────────────────
async function initAudio() {
  if (isRunning) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

    // Load the TEGR AudioWorklet processor
    await audioCtx.audioWorklet.addModule('tegr-processor.js');

    // Create the worklet node (stereo output)
    workletNode = new AudioWorkletNode(audioCtx, 'tegr-processor', {
      outputChannelCount: [2],
    });

    // Analyser for oscilloscope
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    // Connect: Worklet → Analyser → Destination
    workletNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Listen for messages from the worklet
    workletNode.port.onmessage = (e) => handleWorkletMessage(e.data);

    isRunning = true;
    console.log('[TEGR] Audio engine initialized at', audioCtx.sampleRate, 'Hz');
  } catch (err) {
    console.error('[TEGR] Audio init failed:', err);
    alert('Audio initialization failed. Please use a modern browser (Chrome, Edge, Firefox).');
  }
}

// ── Handle Messages from AudioWorklet ───────────────────────
function handleWorkletMessage(data) {
  if (data.type === 'viz') {
    state.vizData = data;
  } else if (data.type === 'firewall') {
    triggerFirewallVisual();
  }
}

// ── Note On/Off ─────────────────────────────────────────────
function noteOn(note, velocity = 100) {
  if (!workletNode) return;
  state.activeNotes.add(note);
  workletNode.port.postMessage({ type: 'noteOn', note, velocity });
  highlightKey(note, true);
}

function noteOff(note) {
  if (!workletNode) return;
  state.activeNotes.delete(note);
  workletNode.port.postMessage({ type: 'noteOff', note });
  highlightKey(note, false);
}

// ── Send Parameter to Worklet ───────────────────────────────
function sendParam(name, value) {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'param', name, value });
}

function sendMode(mode) {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'mode', mode });
}

function sendLock(param, locked) {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'lock', param, locked });
}

function sendEREPR(enabled) {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: 'erepr', enabled });
}

// ══════════════════════════════════════════════════════════════
// UI COMPONENTS
// ══════════════════════════════════════════════════════════════

// ── Dial Controller ─────────────────────────────────────────
class Dial {
  constructor(el) {
    this.el      = el;
    this.param   = el.dataset.param;
    this.min     = parseFloat(el.dataset.min);
    this.max     = parseFloat(el.dataset.max);
    this.value   = parseFloat(el.dataset.value);
    this.format  = el.dataset.format || 'number';
    this.pointer = el.querySelector('.dial-pointer');
    this.display = el.querySelector('.dial-value');
    this.dragging = false;
    this.lastY   = 0;

    this.updateVisual();

    // Mouse interaction
    el.addEventListener('mousedown', (e) => this.startDrag(e));
    el.addEventListener('dblclick',  ()  => this.reset());

    // Touch interaction
    el.addEventListener('touchstart', (e) => this.startDrag(e.touches[0]), { passive: false });

    // Mouse wheel
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001 * (this.max - this.min);
      this.setValue(this.value + delta);
    }, { passive: false });
  }

  startDrag(e) {
    this.dragging = true;
    this.lastY = e.clientY;
    e.preventDefault();

    const onMove = (ev) => {
      const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const dy = this.lastY - clientY;
      this.lastY = clientY;
      const sensitivity = (this.max - this.min) / 200;
      this.setValue(this.value + dy * sensitivity);
    };

    const onUp = () => {
      this.dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  setValue(v) {
    this.value = Math.max(this.min, Math.min(this.max, v));
    this.updateVisual();
    sendParam(this.param, this.value);
  }

  reset() {
    this.setValue(parseFloat(this.el.dataset.value));
  }

  updateVisual() {
    // Map value to rotation: -135° (min) to +135° (max)
    const norm = (this.value - this.min) / (this.max - this.min);
    const angle = -135 + norm * 270;
    this.el.style.setProperty('--angle', `${angle}deg`);

    // Format display value
    let text = '';
    switch (this.format) {
      case 'cents':
        text = this.value > 0 ? `+${Math.round(this.value)}` : `${Math.round(this.value)}`;
        break;
      case 'gamma':
        text = this.value.toFixed(1);
        break;
      case 'time':
        text = this.value.toFixed(1) + 's';
        break;
      case 'pct':
        text = Math.round(this.value * 100) + '%';
        break;
      case 'pan': {
        const v = this.value;
        if (Math.abs(v) < 0.05) text = 'C';
        else if (v < 0) text = `L${Math.round(Math.abs(v) * 100)}`;
        else text = `R${Math.round(v * 100)}`;
        break;
      }
      default:
        text = this.value.toFixed(2);
    }
    this.display.textContent = text;
  }
}

// ── Build Piano Keyboard ────────────────────────────────────
function buildKeyboard() {
  const container = document.getElementById('keyboard');
  if (!container) return;

  // Build 2 octaves: C3 (48) to B4 (71)
  const startNote = 48;
  const endNote   = 71;

  // Note names within an octave
  const isBlack = [false, true, false, true, false, false, true, false, true, false, true, false];
  // Black key offsets from their preceding white key (in px fraction)
  const blackOffsets = [0.65, 0.75, 0, 0.6, 0.7, 0.8, 0]; // C#, D#, skip, F#, G#, A#, skip

  let whiteIndex = 0;
  const whiteWidth = 38;
  const gap = 1;

  // First pass: create white keys and calculate positions
  const keys = [];
  for (let note = startNote; note <= endNote; note++) {
    const noteInOctave = note % 12;
    if (!isBlack[noteInOctave]) {
      keys.push({ note, black: false, whiteIdx: whiteIndex });
      whiteIndex++;
    } else {
      keys.push({ note, black: true, whiteIdx: whiteIndex - 1 });
    }
  }

  // Render white keys first
  const totalWhites = keys.filter(k => !k.black).length;
  container.style.width = `${totalWhites * (whiteWidth + gap)}px`;

  for (const k of keys) {
    if (k.black) continue;
    const el = document.createElement('div');
    el.className = 'key key-white';
    el.dataset.note = k.note;
    el.style.width = `${whiteWidth}px`;

    // Key hint
    if (NOTE_TO_KEY[k.note]) {
      const hint = document.createElement('span');
      hint.className = 'key-hint';
      hint.textContent = NOTE_TO_KEY[k.note];
      el.appendChild(hint);
    }

    // Mouse/touch events
    el.addEventListener('mousedown', (e) => { e.preventDefault(); noteOn(k.note, 100); });
    el.addEventListener('mouseup',   ()  => noteOff(k.note));
    el.addEventListener('mouseleave', () => { if (state.activeNotes.has(k.note)) noteOff(k.note); });
    el.addEventListener('touchstart', (e) => { e.preventDefault(); noteOn(k.note, 100); }, { passive: false });
    el.addEventListener('touchend',   ()  => noteOff(k.note));

    container.appendChild(el);
  }

  // Render black keys on top
  let wIdx = 0;
  for (let note = startNote; note <= endNote; note++) {
    const noteInOctave = note % 12;
    if (!isBlack[noteInOctave]) {
      wIdx++;
      continue;
    }

    const el = document.createElement('div');
    el.className = 'key key-black';
    el.dataset.note = note;

    // Position black key relative to its white key neighbors
    const leftPos = (wIdx - 1) * (whiteWidth + gap) + whiteWidth * 0.68;
    el.style.left = `${leftPos}px`;

    // Key hint
    if (NOTE_TO_KEY[note]) {
      const hint = document.createElement('span');
      hint.className = 'key-hint';
      hint.textContent = NOTE_TO_KEY[note];
      el.appendChild(hint);
    }

    el.addEventListener('mousedown', (e) => { e.preventDefault(); noteOn(note, 100); });
    el.addEventListener('mouseup',   ()  => noteOff(note));
    el.addEventListener('mouseleave', () => { if (state.activeNotes.has(note)) noteOff(note); });
    el.addEventListener('touchstart', (e) => { e.preventDefault(); noteOn(note, 100); }, { passive: false });
    el.addEventListener('touchend',   ()  => noteOff(note));

    container.appendChild(el);
  }
}

function highlightKey(note, on) {
  const el = document.querySelector(`.key[data-note="${note}"]`);
  if (el) el.classList.toggle('active', on);
}

// ── Computer Keyboard Input ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (key in KEY_MAP && !state.activeKeys.has(key)) {
    state.activeKeys.add(key);
    noteOn(KEY_MAP[key], 100);
  }
});

document.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key in KEY_MAP) {
    state.activeKeys.delete(key);
    noteOff(KEY_MAP[key]);
  }
});

// ── Web MIDI ────────────────────────────────────────────────
async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    console.log('[TEGR] Web MIDI not supported');
    return;
  }
  try {
    const midi = await navigator.requestMIDIAccess();
    const dot  = document.getElementById('midi-dot');
    const label = document.getElementById('midi-label');

    const connectInputs = () => {
      let hasDevice = false;
      for (const input of midi.inputs.values()) {
        hasDevice = true;
        input.onmidimessage = handleMIDI;
      }
      if (hasDevice) {
        dot.classList.add('connected');
        label.textContent = 'MIDI ●';
      } else {
        dot.classList.remove('connected');
        label.textContent = 'MIDI';
      }
    };

    midi.onstatechange = connectInputs;
    connectInputs();
    console.log('[TEGR] MIDI initialized');
  } catch (err) {
    console.log('[TEGR] MIDI access denied:', err);
  }
}

function handleMIDI(msg) {
  const [status, note, velocity] = msg.data;
  const cmd = status & 0xf0;

  if (cmd === 0x90 && velocity > 0) {
    noteOn(note, velocity);
  } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
    noteOff(note);
  } else if (cmd === 0xb0) {
    // CC messages — map to dials
    handleMIDICC(note, velocity);
  }
}

function handleMIDICC(cc, value) {
  const norm = value / 127;
  // Map common CCs to parameters
  const ccMap = {
    1:  { param: 'gamma_drive', min: 1, max: 10 },      // Mod wheel → γ drive
    74: { param: 'gamma_drive', min: 1, max: 10 },      // Cutoff → γ drive
    71: { param: 'torsion_g',   min: 0, max: 1 },       // Resonance → torsion
    7:  { param: 'master_vol',  min: 0, max: 1 },       // Volume
    10: { param: 'x_pos',      min: -1, max: 1 },       // Pan
    91: { param: 'z_depth',    min: 0, max: 1 },        // Reverb → depth
  };

  if (cc in ccMap) {
    const m = ccMap[cc];
    const val = m.min + norm * (m.max - m.min);
    sendParam(m.param, val);
    // Update corresponding dial visual
    const dial = dials.find(d => d.param === m.param);
    if (dial) {
      dial.value = val;
      dial.updateVisual();
    }
  }
}

// ══════════════════════════════════════════════════════════════
// VISUALIZATION
// ══════════════════════════════════════════════════════════════

// ── Oscilloscope ────────────────────────────────────────────
function drawOscilloscope() {
  const canvas = document.getElementById('oscilloscope');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(W * i / 4, 0);
    ctx.lineTo(W * i / 4, H);
    ctx.stroke();
  }

  if (!analyser) return;

  const bufferLen = analyser.frequencyBinCount;
  const data = new Uint8Array(bufferLen);
  analyser.getByteTimeDomainData(data);

  // Draw waveform
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 6;
  ctx.beginPath();

  const sliceWidth = W / bufferLen;
  let x = 0;
  for (let i = 0; i < bufferLen; i++) {
    const v = data[i] / 128.0;
    const y = (v * H) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ── Phase Wheel ─────────────────────────────────────────────
const VOICE_COLORS = ['#00e5ff', '#ff2d7b', '#a855f7', '#22d3ee', '#f472b6', '#818cf8', '#34d399', '#fbbf24'];

function drawPhaseWheel() {
  const canvas = document.getElementById('phase-wheel');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(cx, cy) - 20;

  ctx.clearRect(0, 0, W, H);

  // Outer ring
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.3, 0, Math.PI * 2);
  ctx.stroke();

  // Tick marks (every 30°)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(cx + (radius - 6) * Math.cos(a), cy + (radius - 6) * Math.sin(a));
    ctx.lineTo(cx + (radius + 2) * Math.cos(a), cy + (radius + 2) * Math.sin(a));
    ctx.stroke();
  }

  const { voices, erepr } = state.vizData;
  if (!voices || voices.length === 0) {
    // "No signal" text
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('θ', cx, cy + 4);
    return;
  }

  // ER=EPR tether line
  if (erepr && erepr.active) {
    const vA = voices.find(v => v.note === erepr.noteA);
    const vB = voices.find(v => v.note === erepr.noteB);
    if (vA && vB) {
      const aA = vA.theta - Math.PI / 2;
      const aB = vB.theta - Math.PI / 2;
      const xA = cx + radius * Math.cos(aA);
      const yA = cy + radius * Math.sin(aA);
      const xB = cx + radius * Math.cos(aB);
      const yB = cy + radius * Math.sin(aB);

      ctx.strokeStyle = 'rgba(255, 45, 123, 0.4)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ff2d7b';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(xA, yA);
      ctx.lineTo(xB, yB);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // Voice dots
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    const angle = v.theta - Math.PI / 2;   // start from top
    const color = VOICE_COLORS[i % VOICE_COLORS.length];
    const dotR = 4 + v.amplitude * 4;

    const dx = cx + radius * Math.cos(angle);
    const dy = cy + radius * Math.sin(angle);

    // Trail (subtle arc showing recent path)
    ctx.strokeStyle = color + '30';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle - 0.5, angle);
    ctx.stroke();

    // Dot
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // γ indicator (inner radius proportional to gamma)
    const gammaR = Math.min(radius * 0.3 * (v.gamma / 5), radius * 0.8);
    if (v.gamma > 1.05) {
      ctx.strokeStyle = color + '40';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, gammaR, angle - 0.2, angle + 0.2);
      ctx.stroke();
    }
  }

  // Update ER=EPR status label
  const statusEl = document.getElementById('erepr-status');
  if (statusEl) {
    if (erepr && erepr.active) {
      statusEl.textContent = `ER=EPR Δγ: ${erepr.deltaGamma.toFixed(2)}`;
      statusEl.className = 'erepr-status active';
    } else if (erepr && !erepr.active) {
      statusEl.textContent = 'BOND SNAPPED';
      statusEl.className = 'erepr-status snapped';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'erepr-status';
    }
  }
}

// ── Firewall Visual Effect ──────────────────────────────────
function triggerFirewallVisual() {
  const app = document.getElementById('app');
  if (app) {
    app.classList.add('firewall-active');
    setTimeout(() => app.classList.remove('firewall-active'), 600);
  }
}

// ── Animation Loop ──────────────────────────────────────────
function animationLoop() {
  drawOscilloscope();
  drawPhaseWheel();
  updateStateReadout();
  requestAnimationFrame(animationLoop);
}

function updateStateReadout() {
  const { voices } = state.vizData;
  const numVoices = voices ? voices.length : 0;

  const srVoices = document.getElementById('sr-voices');
  const srGamma  = document.getElementById('sr-gamma');
  const srTheta  = document.getElementById('sr-theta');
  const srMode   = document.getElementById('sr-mode');

  if (srVoices) srVoices.textContent = numVoices;
  if (srMode) {
    if (state.mode === 'natural') srMode.textContent = 'NAT';
    else if (state.mode === 'adler') srMode.textContent = 'RAE';
    else srMode.textContent = 'SBX';
  }

  if (voices && voices.length > 0) {
    const v = voices[0];
    if (srGamma) srGamma.textContent = v.gamma.toFixed(2);
    if (srTheta) srTheta.textContent = v.theta.toFixed(2);
  } else {
    if (srGamma) srGamma.textContent = '—';
    if (srTheta) srTheta.textContent = '—';
  }
}

// ══════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════

const dials = [];

document.addEventListener('DOMContentLoaded', () => {
  // ── Build piano keyboard ──
  buildKeyboard();

  // ── Initialize dials ──
  document.querySelectorAll('.dial').forEach(el => {
    const dial = new Dial(el);
    dials.push(dial);
  });

  // ── Mode buttons ──
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      sendMode(state.mode);
    });
  });

  // ── ER=EPR toggle and Sync Rate Slider ──
  const ereprBtn = document.getElementById('erepr-btn');
  const ereprRateGroup = document.getElementById('erepr-rate-group');
  const ereprRateSlider = document.getElementById('erepr-rate-slider');

  if (ereprBtn) {
    ereprBtn.addEventListener('click', () => {
      state.erepr = !state.erepr;
      ereprBtn.classList.toggle('active', state.erepr);
      if (ereprRateGroup) {
        ereprRateGroup.style.display = state.erepr ? 'flex' : 'none';
      }
      sendEREPR(state.erepr);
    });
  }

  if (ereprRateSlider) {
    ereprRateSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      // Map 0-100 to 1e-6 (very slow) to 1e-2 (very fast)
      const minP = Math.log10(0.000001);
      const maxP = Math.log10(0.01);
      const scaled = Math.pow(10, minP + (maxP - minP) * (val / 100));
      sendParam('erepr_pull', scaled);
    });
  }

  // ── Lock toggles ──
  document.querySelectorAll('.dial-lock').forEach(btn => {
    btn.addEventListener('click', () => {
      const param = btn.dataset.lock;
      const locked = !btn.classList.contains('locked');
      btn.classList.toggle('locked', locked);
      btn.textContent = locked ? '🔒' : '🔓';
      state.locks[param] = locked;
      sendLock(param, locked);
    });
  });

  // ── Volume slider ──
  const volSlider = document.getElementById('vol-slider');
  const volValue  = document.getElementById('vol-value');
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      const v = parseFloat(volSlider.value);
      sendParam('master_vol', v);
      if (volValue) volValue.textContent = Math.round(v * 100) + '%';
    });
  }

  // ── Startup overlay ──
  const overlay = document.getElementById('start-overlay');
  if (overlay) {
    overlay.addEventListener('click', async () => {
      await initAudio();
      await initMIDI();
      overlay.classList.add('hidden');

      // Send initial parameter values from all dials
      for (const dial of dials) {
        sendParam(dial.param, dial.value);
      }
      sendParam('master_vol', parseFloat(volSlider?.value || 0.7));

      // Start visualization loop
      requestAnimationFrame(animationLoop);
    });
  }

  // Also allow keyboard to trigger startup
  document.addEventListener('keydown', async function startOnKey(e) {
    if (!isRunning && e.key.toLowerCase() in KEY_MAP) {
      await initAudio();
      await initMIDI();
      if (overlay) overlay.classList.add('hidden');
      for (const dial of dials) sendParam(dial.param, dial.value);
      sendParam('master_vol', parseFloat(volSlider?.value || 0.7));
      requestAnimationFrame(animationLoop);
      document.removeEventListener('keydown', startOnKey);
    }
  });
});
