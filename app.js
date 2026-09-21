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

// BPM Global del Proyecto y Tapping Variable
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
  gainNode: null,
  fileName: "Vacío",
  trimStart: 0.0,    // Inicio de CUE (segundos)
  duration: 1.0,     // Duración de CUE EXTENDIDA (0.1 a 5.0 segundos)
  playbackRate: 1.0,
  isLooping: true,
  hpFrequency: 20,   // High-Pass Filter Frequency (Hz)
  padBPM: 120.0,     // Tempo específico del Pad
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
  
  // Bucle de renderizado Canvas @ 60fps
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
        <div class="pad-control-row">
          <span>Cue Start (s)</span>
          <input type="number" class="num-input-sm" min="0" max="600" step="0.1" value="${pad.trimStart}" onchange="updatePadTrimStart(${index}, this.value)">
        </div>

        <div class="pad-control-row">
          <span>Duración (0-5s)</span>
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

        <div class="pad-control-row">
          <span>Pitch/Speed</span>
          <span id="rate-label-${index}" style="color: #a855f7;">${pad.playbackRate.toFixed(2)}x</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="0.5" max="2.0" step="0.05" value="${pad.playbackRate}" oninput="updatePadRate(${index}, this.value)" style="width: 100%;">
        </div>

        <!-- High-Pass Filter Slider -->
        <div class="pad-control-row">
          <span>High-Pass Filter</span>
          <span id="hp-label-${index}">${Math.round(pad.hpFrequency)} Hz</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="20" max="8000" step="10" value="${pad.hpFrequency}" oninput="updatePadHighPassSlider(${index}, this.value)" style="width: 100%;">
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

// Sincronizar velocidad del Pad al BPM del Proyecto
function syncPadToGlobalBPM(index) {
  const pad = padBank[index];
  if (pad.padBPM <= 0) return;

  const targetRate = globalBPM / pad.padBPM;
  // Limitar entre 0.5x y 2.0x
  const clampedRate = Math.min(Math.max(0.5, targetRate), 2.0);
  updatePadRate(index, clampedRate);
  
  // Re-renderizar el slider para reflejar el cambio
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

  const pad = padBank[index];
  pad.ytVideoId = val;
  pad.fileName = `YT: ${val}`;

  let playerDiv = document.getElementById(`yt-player-${index}`);
  if (!playerDiv) {
    playerDiv = document.createElement('div');
    playerDiv.id = `yt-player-${index}`;
    ytPlayersContainer.appendChild(playerDiv);
  }

  pad.ytPlayer = new YT.Player(`yt-player-${index}`, {
    height: '360',
    width: '640',
    videoId: val,
    playerVars: { 'controls': 0, 'disablekb': 1 },
    events: {
      'onReady': () => {
        document.getElementById(`thumb-${index}`).innerText = `YouTube: ${val}`;
      }
    }
  });
}

// --- CARGA DE ARCHIVOS LOCALES (DRAG & DROP) ---
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
        padBank[index].sourceType = 'local';
        assignFileToPad(index, files[0]);
      }
    });
  });
}

function assignFileToPad(padIndex, file) {
  const pad = padBank[padIndex];

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
    initAudioNodesForPad(pad);
    document.getElementById(`thumb-${padIndex}`).innerText = file.name;
  };
}

// --- WEBAUDIO API IMPLEMENTACIÓN HIGH-PASS FILTER ---
function initAudioNodesForPad(pad) {
  if (pad.sourceNode) return;

  pad.sourceNode = audioCtx.createMediaElementSource(pad.videoElem);
  pad.highpassFilter = audioCtx.createBiquadFilter();
  pad.highpassFilter.type = 'highpass';
  pad.highpassFilter.frequency.value = pad.hpFrequency;

  pad.gainNode = audioCtx.createGain();
  pad.gainNode.gain.value = 1.0;

  // Cadena Audio: Video -> HighPass -> GainPad -> MasterGain
  pad.sourceNode.connect(pad.highpassFilter);
  pad.highpassFilter.connect(pad.gainNode);
  pad.gainNode.connect(masterGainNode);
}

// --- CONTROLES DE PARAMETROS ---
function updatePadTrimStart(index, val) {
  padBank[index].trimStart = Math.max(0, parseFloat(val) || 0);
}

function updatePadDuration(index, val) {
  // Extendido hasta 5.0 segundos
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

// --- RENDERIZADO EN CANVAS ---
function renderCanvasFrame() {
  if (activeSourceType === 'local' && activeVideoElement && !activeVideoElement.paused) {
    ctx.drawImage(activeVideoElement, 0, 0, canvas.width, canvas.height);
  } else if (activeSourceType === 'youtube' && activeYtPlayer && activeYtPlayer.getIframe) {
    const iframe = activeYtPlayer.getIframe();
    try {
      ctx.drawImage(iframe, 0, 0, canvas.width, canvas.height);
    } catch(e) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '24px sans-serif';
      ctx.fillText("YouTube Audio Output Active", 50, 100);
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
    version: "1.1",
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
            padBank[i].padBPM = savedPad.padBPM || 120.0;

            if (savedPad.sourceType === 'youtube' && savedPad.ytVideoId) {
              loadYouTubeVideo(i);
            }
          }
        });
        renderPadsUI();
        setupDragAndDrop();
        alert('¡Proyecto cargado exitosamente!');
      }
    } catch(err) {
      alert('Error al leer el archivo JSON del proyecto.');
    }
  };
  reader.readAsText(file);
}

// --- WEBMIDI API ---
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
    if (note === 112) {
      const minHz = 20;
      const maxHz = 8000;
      const hz = minHz * Math.pow(maxHz / minHz, velocity / 127);
      setPadHighPass(activePadIndex, hz);
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
    console.warn('No se pudieron listar las interfaces de audio:', err);
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
