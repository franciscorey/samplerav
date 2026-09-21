// --- ESTADO GLOBAL Y AUDIO CONTEXT ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Nodos de Audio Globales
const masterGainNode = audioCtx.createGain();
masterGainNode.gain.value = 0.8;
masterGainNode.connect(audioCtx.destination);

let activeVideoElement = null;
let activeYtPlayer = null;
let activeSourceType = null;
let activePadIndex = 0;

// BPM Global del Proyecto y Tapping
let globalBPM = 120.0;
let globalTapTimes = [];

// Mapeo Teclado Físico (QWER / ASDF) -> Índice de Pad
const keyMap = {
  'q': 0, 'w': 1, 'e': 2, 'r': 3,
  'a': 4, 's': 5, 'd': 6, 'f': 7
};

// Banco de 8 Pads
const padBank = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  keyLabel: ['Q','W','E','R','A','S','D','F'][i],
  midiNote: 36 + i,
  sourceType: 'local',
  videoElem: null,
  ytPlayer: null,
  ytVideoId: '',
  sourceNode: null,
  highpassFilter: null,
  lowpassFilter: null,
  gainNode: null,
  fileName: "Vacío",
  trimStart: 0.0,    // Cue Start (s)
  duration: 1.0,     // Duración de CUE (0.1 a 5.0 s)
  maxDuration: 60.0, // Límite máximo para el slider de Cue
  playbackRate: 1.0,
  isLooping: true,
  hpFrequency: 20,    // HPF (20 Hz - 8000 Hz)
  lpFrequency: 20000, // LPF (200 Hz - 20000 Hz)
  padBPM: 120.0,
  padTapTimes: []
}));

// Elementos DOM
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const padsGrid = document.getElementById('padsGrid');
const videoBank = document.getElementById('videoBank');
const ytPlayersContainer = document.getElementById('ytPlayersContainer');

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  renderPadsUI();
  setupDragAndDrop();
  setupKeyboardListeners();
  setupMasterVolume();
  setupGlobalTapTempo();
  initWebMIDI();
  setupAudioOutputs();
  setupProjectExportImport();
  setupRecorder();

  requestAnimationFrame(renderCanvasFrame);
});

// --- RENDERIZADO INTERFAZ GRÁFICA DE PADS ---
function renderPadsUI() {
  padsGrid.innerHTML = '';

  padBank.forEach((pad, index) => {
    const padCard = document.createElement('div');
    padCard.className = `pad-card ${index === activePadIndex ? 'selected' : ''}`;
    padCard.dataset.index = index;

    padCard.innerHTML = `
      <div class="pad-header">
        <span class="pad-number">PAD ${pad.id}</span>
        <span class="pad-key-badge">${pad.keyLabel}</span>
      </div>

      <select class="pad-source-select" onchange="changeSourceType(${index}, this.value)">
        <option value="local" ${pad.sourceType === 'local' ? 'selected' : ''}>Local (.mp4)</option>
        <option value="youtube" ${pad.sourceType === 'youtube' ? 'selected' : ''}>YouTube URL</option>
      </select>

      ${pad.sourceType === 'youtube' ? `
        <div class="yt-input-group">
          <input type="text" id="yt-url-${index}" placeholder="ID/URL YouTube" value="${pad.ytVideoId}">
          <button onclick="loadYouTubeVideo(${index})">Cargar</button>
        </div>
      ` : ''}

      <div class="pad-thumb" id="thumb-${index}">${pad.fileName}</div>

      <div class="pad-controls">
        <!-- Cue Start: Campo Numérico + Barra Deslizadora -->
        <div class="pad-control-row">
          <span>Cue Start (s)</span>
          <input type="number" id="cue-num-${index}" class="num-input-sm" min="0" max="${pad.maxDuration.toFixed(1)}" step="0.1" value="${pad.trimStart}" onchange="updatePadTrimStart(${index}, this.value)">
        </div>
        <div class="pad-control-row">
          <input type="range" id="cue-slider-${index}" min="0" max="${pad.maxDuration}" step="0.1" value="${pad.trimStart}" oninput="updatePadTrimStart(${index}, this.value)">
        </div>

        <!-- Duración (0.1s - 5.0s) -->
        <div class="pad-control-row">
          <span>Duración (0.1-5s)</span>
          <input type="number" class="num-input-sm" min="0.1" max="5.0" step="0.1" value="${pad.duration}" onchange="updatePadDuration(${index}, this.value)">
        </div>

        <!-- Tap BPM del Pad & Sync -->
        <div class="pad-control-row">
          <button class="btn-tap" onclick="handlePadTap(${index})">TAP PAD</button>
          <span id="pad-bpm-label-${index}" style="font-family: monospace; color: var(--accent-cyan);">${pad.padBPM.toFixed(1)} BPM</span>
        </div>

        <div class="pad-control-row">
          <label><input type="checkbox" ${pad.isLooping ? 'checked' : ''} onchange="updatePadLoop(${index}, this.checked)"> 🔁 Loop</label>
          <button class="btn-sync" onclick="syncPadToGlobalBPM(${index})">⚡ SYNC BPM</button>
        </div>

        <!-- Pitch / Speed Slider -->
        <div class="pad-control-row">
          <span>Pitch / Speed</span>
          <span id="rate-label-${index}" style="color: #a855f7;">${pad.playbackRate.toFixed(2)}x</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="0.5" max="2.0" step="0.05" value="${pad.playbackRate}" oninput="updatePadRate(${index}, this.value)">
        </div>

        <!-- High-Pass Filter Slider -->
        <div class="pad-control-row">
          <span>High-Pass Filter</span>
          <span id="hp-label-${index}">${Math.round(pad.hpFrequency)} Hz</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="20" max="8000" step="10" value="${pad.hpFrequency}" oninput="updatePadHighPassSlider(${index}, this.value)">
        </div>

        <!-- Low-Pass Filter Slider -->
        <div class="pad-control-row">
          <span>Low-Pass Filter</span>
          <span id="lp-label-${index}">${Math.round(pad.lpFrequency)} Hz</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="200" max="20000" step="100" value="${pad.lpFrequency}" oninput="updatePadLowPassSlider(${index}, this.value)">
        </div>
      </div>
    `;

    padCard.addEventListener('click', () => selectPad(index));
    padsGrid.appendChild(padCard);
  });
}

function selectPad(index) {
  activePadIndex = index;
  document.querySelectorAll('.pad-card').forEach((card, i) => {
    card.classList.toggle('selected', i === index);
  });
}

// --- TAP TEMPO GLOBAL & PAD TEMPO ---
function setupGlobalTapTempo() {
  const tapBtn = document.getElementById('globalTapBtn');
  tapBtn.addEventListener('click', () => {
    const now = performance.now();
    globalTapTimes.push(now);

    if (globalTapTimes.length > 4) globalTapTimes.shift();

    if (globalTapTimes.length > 1) {
      const intervals = [];
      for (let i = 1; i < globalTapTimes.length; i++) {
        intervals.push(globalTapTimes[i] - globalTapTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
      globalBPM = 60000 / avgInterval;
      document.getElementById('globalBpmLabel').innerText = globalBPM.toFixed(1);
    }
  });
}

function handlePadTap(index) {
  const now = performance.now();
  const pad = padBank[index];
  pad.padTapTimes.push(now);

  if (pad.padTapTimes.length > 4) pad.padTapTimes.shift();

  if (pad.padTapTimes.length > 1) {
    const intervals = [];
    for (let i = 1; i < pad.padTapTimes.length; i++) {
      intervals.push(pad.padTapTimes[i] - pad.padTapTimes[i - 1]);
    }
    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
    pad.padBPM = 60000 / avgInterval;
    
    const label = document.getElementById(`pad-bpm-label-${index}`);
    if (label) label.innerText = `${pad.padBPM.toFixed(1)} BPM`;
  }
}

function syncPadToGlobalBPM(index) {
  const pad = padBank[index];
  if (pad.padBPM <= 0) return;

  const targetRate = globalBPM / pad.padBPM;
  const clampedRate = Math.min(Math.max(0.5, targetRate), 2.0);
  updatePadRate(index, clampedRate);
  
  renderPadsUI();
  setupDragAndDrop();
}

// --- TECLADO NORMAL (QWER / ASDF) ---
function setupKeyboardListeners() {
  const activeKeys = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (keyMap.hasOwnProperty(key) && !activeKeys.has(key)) {
      activeKeys.add(key);
      triggerPad(keyMap[key]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (keyMap.hasOwnProperty(key)) {
      activeKeys.delete(key);
      releasePad(keyMap[key]);
    }
  });
}

// --- VOLUMEN GLOBAL / MASTER ---
function setupMasterVolume() {
  const range = document.getElementById('masterVolRange');
  const label = document.getElementById('masterVolLabel');

  range.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    masterGainNode.gain.setTargetAtTime(val, audioCtx.currentTime, 0.01);
    label.innerText = `${Math.round(val * 100)}%`;
  });
}

// --- CAMBIO DE FUENTE (LOCAL VS YOUTUBE) ---
function changeSourceType(index, type) {
  padBank[index].sourceType = type;
  renderPadsUI();
  setupDragAndDrop();
}

// --- CARGA YOUTUBE Y CASCADA (PADS 1 -> 2, 3, 4) ---
function loadYouTubeVideo(index) {
  const input = document.getElementById(`yt-url-${index}`);
  if (!input) return;
  
  let val = input.value.trim();
  if (val.includes('v=')) {
    val = val.split('v=')[1].split('&')[0];
  } else if (val.includes('youtu.be/')) {
    val = val.split('youtu.be/')[1].split('?')[0];
  }

  if (!val) return;

  // Si se carga en el Pad 1 (index 0), replicar en Pads 2, 3 y 4 (indices 1, 2, 3)
  const targets = (index === 0) ? [0, 1, 2, 3] : [index];

  targets.forEach(idx => {
    const pad = padBank[idx];
    pad.sourceType = 'youtube';
    pad.ytVideoId = val;
    pad.fileName = `YT: ${val}`;

    let playerDiv = document.getElementById(`yt-player-${idx}`);
    if (!playerDiv) {
      playerDiv = document.createElement('div');
      playerDiv.id = `yt-player-${idx}`;
      ytPlayersContainer.appendChild(playerDiv);
    } else {
      playerDiv.innerHTML = '';
    }

    pad.ytPlayer = new YT.Player(`yt-player-${idx}`, {
      height: '1080',
      width: '1920',
      videoId: val,
      playerVars: { 
        'controls': 0, 
        'disablekb': 1, 
        'modestbranding': 1,
        'rel': 0,
        'autoplay': 0
      },
      events: {
        'onReady': (evt) => {
          const dur = evt.target.getDuration();
          if (dur > 0) pad.maxDuration = dur;
          const thumb = document.getElementById(`thumb-${idx}`);
          if (thumb) thumb.innerText = `YouTube: ${val}`;
        }
      }
    });
  });

  if (index === 0) {
    renderPadsUI();
    setupDragAndDrop();
  }
}

// --- CARGA DE ARCHIVOS LOCALES Y CASCADA (PADS 1 -> 2, 3, 4) ---
function setupDragAndDrop() {
  const padCards = document.querySelectorAll('.pad-card');

  padCards.forEach((card, index) => {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      card.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); });
    });

    ['dragenter', 'dragover'].forEach(() => card.classList.add('drag-highlight'));
    ['dragleave', 'drop'].forEach(() => card.classList.remove('drag-highlight'));

    card.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('video/')) {
        assignFileToPad(index, files[0]);
      }
    });
  });
}

function assignFileToPad(padIndex, file) {
  // Carga en Cascada si el Pad es el N° 1 (index 0)
  const targetIndices = (padIndex === 0) ? [0, 1, 2, 3] : [padIndex];

  targetIndices.forEach(idx => {
    const pad = padBank[idx];
    pad.sourceType = 'local';

    if (pad.videoElem) {
      URL.revokeObjectURL(pad.videoElem.src);
      pad.videoElem.remove();
    }

    const videoUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = videoUrl;
    video.preload = 'auto';
    video.playsInline = true;

    videoBank.appendChild(video);

    pad.videoElem = video;
    pad.fileName = file.name;

    video.onloadedmetadata = () => {
      pad.maxDuration = video.duration || 60.0;
      initAudioNodesForPad(pad);
      const thumb = document.getElementById(`thumb-${idx}`);
      if (thumb) thumb.innerText = file.name;
    };
  });

  if (padIndex === 0) {
    renderPadsUI();
    setupDragAndDrop();
  }
}

// --- WEBAUDIO API: HPF Y LPF EN SERIE ---
function initAudioNodesForPad(pad) {
  if (pad.sourceNode) return;

  pad.sourceNode = audioCtx.createMediaElementSource(pad.videoElem);
  
  // High-Pass Filter
  pad.highpassFilter = audioCtx.createBiquadFilter();
  pad.highpassFilter.type = 'highpass';
  pad.highpassFilter.frequency.value = pad.hpFrequency;

  // Low-Pass Filter
  pad.lowpassFilter = audioCtx.createBiquadFilter();
  pad.lowpassFilter.type = 'lowpass';
  pad.lowpassFilter.frequency.value = pad.lpFrequency;

  pad.gainNode = audioCtx.createGain();
  pad.gainNode.gain.value = 1.0;

  // Cadena Audio: Video -> HPF -> LPF -> GainPad -> MasterGain
  pad.sourceNode.connect(pad.highpassFilter);
  pad.highpassFilter.connect(pad.lowpassFilter);
  pad.lowpassFilter.connect(pad.gainNode);
  pad.gainNode.connect(masterGainNode);
}

// --- CONTROLES DE PARÁMETROS Y CUE ---
function updatePadTrimStart(index, val) {
  const pad = padBank[index];
  let numVal = parseFloat(val) || 0;
  numVal = Math.min(Math.max(0, numVal), pad.maxDuration);
  pad.trimStart = numVal;

  // Sincronizar numérico y slider
  const numInput = document.getElementById(`cue-num-${index}`);
  const sliderInput = document.getElementById(`cue-slider-${index}`);
  if (numInput) numInput.value = numVal.toFixed(1);
  if (sliderInput) sliderInput.value = numVal;
}

function updatePadDuration(index, val) {
  let dur = parseFloat(val) || 1.0;
  dur = Math.min(Math.max(0.1, dur), 5.0);
  padBank[index].duration = dur;
}

function updatePadRate(index, value) {
  const pad = padBank[index];
  pad.playbackRate = parseFloat(value);
  
  if (pad.videoElem) {
    pad.videoElem.playbackRate = pad.playbackRate;
    pad.videoElem.preservesPitch = false;
  }
  
  const label = document.getElementById(`rate-label-${index}`);
  if (label) label.innerText = `${pad.playbackRate.toFixed(2)}x`;
}

function updatePadLoop(index, isChecked) {
  padBank[index].isLooping = isChecked;
}

function updatePadHighPassSlider(index, val) {
  const hz = parseFloat(val);
  setPadHighPass(index, hz);
}

function setPadHighPass(index, hz) {
  const pad = padBank[index];
  pad.hpFrequency = hz;
  if (pad.highpassFilter) {
    pad.highpassFilter.frequency.setTargetAtTime(hz, audioCtx.currentTime, 0.01);
  }
  const label = document.getElementById(`hp-label-${index}`);
  if (label) label.innerText = `${Math.round(hz)} Hz`;
}

function updatePadLowPassSlider(index, val) {
  const hz = parseFloat(val);
  setPadLowPass(index, hz);
}

function setPadLowPass(index, hz) {
  const pad = padBank[index];
  pad.lpFrequency = hz;
  if (pad.lowpassFilter) {
    pad.lowpassFilter.frequency.setTargetAtTime(hz, audioCtx.currentTime, 0.01);
  }
  const label = document.getElementById(`lp-label-${index}`);
  if (label) label.innerText = `${Math.round(hz)} Hz`;
}

// --- DISPARO DE PADS (TRIGGER / GATE CUE) ---
function triggerPad(index) {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const pad = padBank[index];
  if (!pad) return;

  selectPad(index);
  const calculatedEnd = pad.trimStart + pad.duration;

  if (pad.sourceType === 'local' && pad.videoElem) {
    const v = pad.videoElem;
    v.playbackRate = pad.playbackRate;
    v.preservesPitch = false;

    v.currentTime = pad.trimStart;
    v.play();

    v.ontimeupdate = () => {
      if (v.currentTime >= calculatedEnd) {
        if (pad.isLooping) {
          v.currentTime = pad.trimStart;
        } else {
          v.pause();
        }
      }
    };

    activeVideoElement = v;
    activeSourceType = 'local';

  } else if (pad.sourceType === 'youtube' && pad.ytPlayer && pad.ytPlayer.seekTo) {
    pad.ytPlayer.seekTo(pad.trimStart, true);
    pad.ytPlayer.playVideo();
    
    activeYtPlayer = pad.ytPlayer;
    activeSourceType = 'youtube';
  }

  const card = document.querySelectorAll('.pad-card')[index];
  if (card) card.classList.add('active');
}

function releasePad(index) {
  const pad = padBank[index];
  if (!pad) return;

  if (pad.sourceType === 'local' && pad.videoElem) {
    pad.videoElem.pause();
  } else if (pad.sourceType === 'youtube' && pad.ytPlayer && pad.ytPlayer.pauseVideo) {
    pad.ytPlayer.pauseVideo();
  }

  const card = document.querySelectorAll('.pad-card')[index];
  if (card) card.classList.remove('active');
}

// --- RENDERIZADO EN CANVAS (CON SOPORTE DE VIDEO YOUTUBE) ---
function renderCanvasFrame() {
  if (activeSourceType === 'local' && activeVideoElement && !activeVideoElement.paused) {
    ctx.drawImage(activeVideoElement, 0, 0, canvas.width, canvas.height);
  } else if (activeSourceType === 'youtube' && activeYtPlayer && activeYtPlayer.getIframe) {
    const iframe = activeYtPlayer.getIframe();
    try {
      // Captura directa de fotograma del video en reproducción
      ctx.drawImage(iframe, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      // Si hay restricción CORS en la transmisión de origen, activa el overlay visual HD
      ctx.fillStyle = '#090a0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText("▶ YOUTUBE VIDEO STREAMING ACTIVE", 80, 120);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '20px monospace';
      ctx.fillText(`Pad Activo: ${padBank[activePadIndex].fileName}`, 80, 170);
    }
  } else if (!activeVideoElement) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(renderCanvasFrame);
}

// --- EXPORTAR / IMPORTAR PROYECTO (JSON) ---
function setupProjectExportImport() {
  document.getElementById('exportProjBtn').addEventListener('click', exportProjectJSON);
  
  const importBtn = document.getElementById('importProjBtn');
  const importInput = document.getElementById('importProjInput');

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', importProjectJSON);
}

function exportProjectJSON() {
  const projectData = {
    version: "1.2",
    timestamp: Date.now(),
    globalBPM: globalBPM,
    pads: padBank.map(p => ({
      id: p.id,
      sourceType: p.sourceType,
      ytVideoId: p.ytVideoId,
      trimStart: p.trimStart,
      duration: p.duration,
      playbackRate: p.playbackRate,
      isLooping: p.isLooping,
      hpFrequency: p.hpFrequency,
      lpFrequency: p.lpFrequency,
      padBPM: p.padBPM
    }))
  };

  const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AV_Project_${Date.now()}.json`;
  a.click();
}

function importProjectJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (data.globalBPM) {
        globalBPM = data.globalBPM;
        document.getElementById('globalBpmLabel').innerText = globalBPM.toFixed(1);
      }
      if (data.pads && Array.isArray(data.pads)) {
        data.pads.forEach((savedPad, i) => {
          if (padBank[i]) {
            padBank[i].sourceType = savedPad.sourceType;
            padBank[i].ytVideoId = savedPad.ytVideoId || '';
            padBank[i].trimStart = savedPad.trimStart || 0;
            padBank[i].duration = savedPad.duration || 1.0;
            padBank[i].playbackRate = savedPad.playbackRate || 1.0;
            padBank[i].isLooping = savedPad.isLooping;
            padBank[i].hpFrequency = savedPad.hpFrequency || 20;
            padBank[i].lpFrequency = savedPad.lpFrequency || 20000;
            padBank[i].padBPM = savedPad.padBPM || 120.0;

            if (savedPad.sourceType === 'youtube' && savedPad.ytVideoId) {
              loadYouTubeVideo(i);
            }
          }
        });
        renderPadsUI();
        setupDragAndDrop();
        alert('¡Proyecto cargado con éxito!');
      }
    } catch(err) {
      alert('Error al leer el archivo JSON.');
    }
  };
  reader.readAsText(file);
}

// --- WEBMIDI API CON HPF & LPF CONTROLS ---
function initWebMIDI() {
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFail);
  } else {
    document.getElementById('midiStatus').innerText = 'WebMIDI no soportado';
  }
}

function onMIDISuccess(midiAccess) {
  const inputs = Array.from(midiAccess.inputs.values());
  const statusDot = document.getElementById('midiDot');
  const statusText = document.getElementById('midiStatus');
  const select = document.getElementById('midiInputSelect');

  if (inputs.length > 0) {
    statusDot.classList.add('active');
    statusText.innerText = inputs[0].name;

    select.innerHTML = '';
    inputs.forEach(input => {
      const opt = document.createElement('option');
      opt.text = input.name;
      select.appendChild(opt);
      input.onmidimessage = handleMIDIMessage;
    });
  } else {
    statusText.innerText = 'Conecta tu MiniLab / Teclado MIDI';
  }
}

function onMIDIFail() {
  document.getElementById('midiStatus').innerText = 'Error al acceder a MIDI';
}

function handleMIDIMessage(e) {
  const [status, note, velocity] = e.data;
  const isNoteOn = (status & 0xF0) === 0x90 && velocity > 0;
  const isNoteOff = (status & 0xF0) === 0x80 || ((status & 0xF0) === 0x90 && velocity === 0);
  const isCC = (status & 0xF0) === 0xB0;

  if (isNoteOn) {
    const padIndex = padBank.findIndex(p => p.midiNote === note);
    if (padIndex !== -1) triggerPad(padIndex);
  } else if (isNoteOff) {
    const padIndex = padBank.findIndex(p => p.midiNote === note);
    if (padIndex !== -1) releasePad(padIndex);
  } else if (isCC) {
    // Control CC 112 -> High Pass Filter
    if (note === 112) {
      const hz = 20 * Math.pow(8000 / 20, velocity / 127);
      setPadHighPass(activePadIndex, hz);
    }
    // Control CC 113 -> Low Pass Filter
    else if (note === 113) {
      const hz = 200 * Math.pow(20000 / 200, velocity / 127);
      setPadLowPass(activePadIndex, hz);
    }
  }
}

// --- RUTEOS DE SALIDA DE AUDIO ---
async function setupAudioOutputs() {
  const select = document.getElementById('audioOutputSelect');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    select.innerHTML = '';
    outputs.forEach(device => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.text = device.label || `Salida ${select.length + 1}`;
      select.appendChild(opt);
    });

    select.addEventListener('change', async (e) => {
      if (typeof audioCtx.setSinkId === 'function') {
        await audioCtx.setSinkId(e.target.value);
      }
    });
  } catch (err) {
    console.warn('No se pudieron listar las salidas de audio:', err);
  }
}

// --- MÓDULO DE GRABACIÓN HD (1080p) ---
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;

function setupRecorder() {
  const recBtn = document.getElementById('recBtn');
  recBtn.addEventListener('click', () => {
    if (!isRecording) startRecording();
    else stopRecording();
  });
}

function startRecording() {
  recordedChunks = [];

  const canvasStream = canvas.captureStream(60);
  const audioDestination = audioCtx.createMediaStreamDestination();

  masterGainNode.connect(audioDestination);

  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks()
  ]);

  const options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 8000000 };
  mediaRecorder = new MediaRecorder(combinedStream, options);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = exportVideo;
  mediaRecorder.start();

  isRecording = true;
  const recBtn = document.getElementById('recBtn');
  recBtn.innerText = '⏹ Detener y Exportar';
  recBtn.classList.add('recording');
}

function stopRecording() {
  mediaRecorder.stop();
  isRecording = false;
  const recBtn = document.getElementById('recBtn');
  recBtn.innerText = '🔴 Iniciar REC (1080p)';
  recBtn.classList.remove('recording');
}

function exportVideo() {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AV_Session_${Date.now()}.webm`;
  a.click();
}
