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

// Banco de 8 Pads (Todos en STOP por defecto)
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
  trimStart: 0.0,
  duration: 2.0,
  maxDuration: 60.0,
  playbackRate: 1.0,
  isLooping: true,
  isPlaying: false, // ESTADO STOP POR DEFECTO
  isMuted: false,
  isSolo: false,
  hpFrequency: 20,
  lpFrequency: 20000,
  padBPM: 120.0,
  padTapTimes: []
}));

// Elementos DOM
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const padsGrid = document.getElementById('padsGrid');
const videoBank = document.getElementById('videoBank');
const ytPlayersContainer = document.getElementById('ytPlayersContainer');
const canvasWrapper = document.getElementById('canvasWrapper');
const canvasStatusTag = document.getElementById('canvasStatusTag');

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

  // Primer frame de pantalla de espera (fondo activo)
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  requestAnimationFrame(renderCanvasFrame);
});

// --- RENDERIZADO INTERFAZ GRÁFICA DE PADS ---
function renderPadsUI() {
  padsGrid.innerHTML = '';

  padBank.forEach((pad, index) => {
    const padCard = document.createElement('div');
    padCard.className = `pad-card ${index === activePadIndex ? 'selected' : ''} ${pad.isPlaying ? 'playing' : ''}`;
    padCard.dataset.index = index;

    padCard.innerHTML = `
      <div class="pad-header">
        <div class="pad-title-group">
          <span class="pad-number">PAD ${pad.id}</span>
          <span class="pad-key-badge">${pad.keyLabel}</span>
        </div>
        <div>
          <button class="pad-play-btn ${pad.isPlaying ? 'active' : ''}" onclick="togglePlayPad(event, ${index})">
            ${pad.isPlaying ? '⏸ PAUSE' : '▶ PLAY'}
          </button>
        </div>
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

      <!-- Meter Bar -->
      <div class="pad-meter-bar">
        <div class="pad-meter-progress" id="meter-${index}"></div>
      </div>

      <div class="pad-controls">
        <div class="pad-control-row">
          <span>Cue Start</span>
          <input type="number" id="cue-num-${index}" class="num-input-sm" min="0" max="${pad.maxDuration.toFixed(1)}" step="0.1" value="${pad.trimStart}" onchange="updatePadTrimStart(${index}, this.value)">
        </div>
        <div class="pad-control-row slider-cyan">
          <input type="range" id="cue-slider-${index}" min="0" max="${pad.maxDuration}" step="0.1" value="${pad.trimStart}" oninput="updatePadTrimStart(${index}, this.value)">
        </div>

        <div class="pad-control-row">
          <span>Loop Size</span>
          <div style="display: flex; align-items: center; gap: 4px;">
            <input type="number" class="num-input-sm" min="0.1" max="10.0" step="0.1" value="${pad.duration}" onchange="updatePadDuration(${index}, this.value)">
            <span style="font-size: 9px; color: var(--text-muted);">seg</span>
          </div>
        </div>
        <div class="pad-control-row slider-green">
          <input type="range" min="0.1" max="10.0" step="0.1" value="${pad.duration}" oninput="updatePadDuration(${index}, this.value)">
        </div>

        <div class="pad-control-row">
          <div style="display: flex; gap: 3px;">
            <button class="btn-mute ${pad.isMuted ? 'active' : ''}" onclick="toggleMute(${index})">M</button>
            <button class="btn-solo ${pad.isSolo ? 'active' : ''}" onclick="toggleSolo(${index})">S</button>
          </div>
          <button class="btn-tap" onclick="handlePadTap(${index})">TAP</button>
          <span id="pad-bpm-label-${index}" style="font-family: monospace; color: var(--accent-cyan); font-size: 9px;">${pad.padBPM.toFixed(1)} BPM</span>
        </div>

        <div class="pad-control-row">
          <label style="font-size: 9px;"><input type="checkbox" ${pad.isLooping ? 'checked' : ''} onchange="updatePadLoop(${index}, this.checked)"> 🔁 Continuous Loop</label>
          <button class="btn-sync" onclick="syncPadToGlobalBPM(${index})">⚡ SYNC</button>
        </div>

        <div class="pad-control-row">
          <span>Pitch / Speed</span>
          <span id="rate-label-${index}" style="color: #a855f7;">${pad.playbackRate.toFixed(2)}x</span>
        </div>
        <div class="pad-control-row">
          <input type="range" min="0.5" max="2.0" step="0.05" value="${pad.playbackRate}" oninput="updatePadRate(${index}, this.value)">
        </div>

        <div class="pad-control-row">
          <span>High-Pass</span>
          <span id="hp-label-${index}" style="color: var(--accent-orange);">${Math.round(pad.hpFrequency)} Hz</span>
        </div>
        <div class="pad-control-row slider-orange">
          <input type="range" min="20" max="8000" step="10" value="${pad.hpFrequency}" oninput="updatePadHighPassSlider(${index}, this.value)">
        </div>

        <div class="pad-control-row">
          <span>Low-Pass</span>
          <span id="lp-label-${index}" style="color: var(--accent-red);">${Math.round(pad.lpFrequency)} Hz</span>
        </div>
        <div class="pad-control-row slider-red">
          <input type="range" min="200" max="20000" step="100" value="${pad.lpFrequency}" oninput="updatePadLowPassSlider(${index}, this.value)">
        </div>
      </div>
    `;

    padCard.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        selectPad(index);
      }
    });
    padsGrid.appendChild(padCard);
  });
}

function selectPad(index) {
  activePadIndex = index;
  document.querySelectorAll('.pad-card').forEach((card, i) => {
    card.classList.toggle('selected', i === index);
  });
}

// --- CONTROL PLAY / PAUSE MANUAL ---
function togglePlayPad(e, index) {
  if (e) e.stopPropagation();
  const pad = padBank[index];

  if (pad.isPlaying) {
    stopPadPlayback(index);
  } else {
    // Detener cualquier otro pad que se esté ejecutando en ese momento
    padBank.forEach((p, i) => {
      if (i !== index && p.isPlaying) stopPadPlayback(i);
    });
    startPadPlayback(index);
  }
}

function startPadPlayback(index) {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const pad = padBank[index];
  if (!pad) return;

  pad.isPlaying = true;
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
          stopPadPlayback(index);
        }
      }
      updatePadMeter(index, (v.currentTime - pad.trimStart) / pad.duration);
    };

    activeVideoElement = v;
    activeSourceType = 'local';

  } else if (pad.sourceType === 'youtube' && pad.ytPlayer && pad.ytPlayer.seekTo) {
    pad.ytPlayer.seekTo(pad.trimStart, true);
    pad.ytPlayer.playVideo();
    
    activeYtPlayer = pad.ytPlayer;
    activeSourceType = 'youtube';
  }

  updateCanvasHeaderStatus(`CANVAS OUT: PAD ${pad.id} (${pad.fileName})`);
  renderPadsUI();
  setupDragAndDrop();
}

function stopPadPlayback(index) {
  const pad = padBank[index];
  if (!pad) return;

  pad.isPlaying = false;

  if (pad.sourceType === 'local' && pad.videoElem) {
    pad.videoElem.pause();
  } else if (pad.sourceType === 'youtube' && pad.ytPlayer && pad.ytPlayer.pauseVideo) {
    pad.ytPlayer.pauseVideo();
  }

  updatePadMeter(index, 0);

  // NOTA CLAVE: No borramos activeVideoElement ni activeSourceType.
  // El último frame renderizado en el canvas permanecerá fijo y visible.
  updateCanvasHeaderStatus(`CANVAS OUT: PAD ${pad.id} (PAUSADO / FRAME FIJO)`);

  renderPadsUI();
  setupDragAndDrop();
}

function updatePadMeter(index, ratio) {
  const bar = document.getElementById(`meter-${index}`);
  if (bar) {
    const pct = Math.min(Math.max(0, ratio * 100), 100);
    bar.style.width = `${pct}%`;
  }
}

function updateCanvasHeaderStatus(msg) {
  if (canvasStatusTag) canvasStatusTag.innerText = msg;
  if (canvasWrapper) canvasWrapper.classList.add('on-air');
}

// --- RENDERIZADO EN CANVAS (SIN STANDBY BLACKOUT) ---
function renderCanvasFrame() {
  // Renderiza el video local si está disponible (esté sonando o en pausa mantiene el frame)
  if (activeSourceType === 'local' && activeVideoElement) {
    ctx.drawImage(activeVideoElement, 0, 0, canvas.width, canvas.height);
  } else if (activeSourceType === 'youtube' && activeYtPlayer && activeYtPlayer.getIframe) {
    const iframe = activeYtPlayer.getIframe();
    try {
      ctx.drawImage(iframe, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      // Fallback para YouTube iframe sin borrar la imagen previa del buffer
    }
  }

  requestAnimationFrame(renderCanvasFrame);
}

// --- RESTO DE FUNCIONALIDADES (Midi, Audio, File/YT Loaders, Rec, Export) ---
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

function toggleMute(index) {
  const pad = padBank[index];
  pad.isMuted = !pad.isMuted;
  if (pad.gainNode) {
    pad.gainNode.gain.value = pad.isMuted ? 0 : 1.0;
  }
  renderPadsUI();
  setupDragAndDrop();
}

function toggleSolo(index) {
  const pad = padBank[index];
  pad.isSolo = !pad.isSolo;

  const hasSolo = padBank.some(p => p.isSolo);

  padBank.forEach(p => {
    if (p.gainNode) {
      if (hasSolo) {
        p.gainNode.gain.value = p.isSolo ? 1.0 : 0;
      } else {
        p.gainNode.gain.value = p.isMuted ? 0 : 1.0;
      }
    }
  });

  renderPadsUI();
  setupDragAndDrop();
}

function setupKeyboardListeners() {
  const activeKeys = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (keyMap.hasOwnProperty(key) && !activeKeys.has(key)) {
      activeKeys.add(key);
      togglePlayPad(null, keyMap[key]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (keyMap.hasOwnProperty(key)) {
      activeKeys.delete(key);
    }
  });
}

function setupMasterVolume() {
  const range = document.getElementById('masterVolRange');
  const label = document.getElementById('masterVolLabel');

  range.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    masterGainNode.gain.setTargetAtTime(val, audioCtx.currentTime, 0.01);
    label.innerText = `${Math.round(val * 100)}%`;
  });
}

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
      playerVars: { 'controls': 0, 'disablekb': 1, 'modestbranding': 1, 'rel': 0, 'autoplay': 0 },
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
      
      // Si no hay video activo actualmente en el canvas, mostrar el primer frame
      if (!activeVideoElement) {
        activeVideoElement = video;
        activeSourceType = 'local';
        video.currentTime = pad.trimStart;
      }
    };
  });

  if (padIndex === 0) {
    renderPadsUI();
    setupDragAndDrop();
  }
}

function initAudioNodesForPad(pad) {
  if (pad.sourceNode) return;

  pad.sourceNode = audioCtx.createMediaElementSource(pad.videoElem);
  
  pad.highpassFilter = audioCtx.createBiquadFilter();
  pad.highpassFilter.type = 'highpass';
  pad.highpassFilter.frequency.value = pad.hpFrequency;

  pad.lowpassFilter = audioCtx.createBiquadFilter();
  pad.lowpassFilter.type = 'lowpass';
  pad.lowpassFilter.frequency.value = pad.lpFrequency;

  pad.gainNode = audioCtx.createGain();
  pad.gainNode.gain.value = 1.0;

  pad.sourceNode.connect(pad.highpassFilter);
  pad.highpassFilter.connect(pad.lowpassFilter);
  pad.lowpassFilter.connect(pad.gainNode);
  pad.gainNode.connect(masterGainNode);
}

function updatePadTrimStart(index, val) {
  const pad = padBank[index];
  let numVal = parseFloat(val) || 0;
  numVal = Math.min(Math.max(0, numVal), pad.maxDuration);
  pad.trimStart = numVal;

  const numInput = document.getElementById(`cue-num-${index}`);
  const sliderInput = document.getElementById(`cue-slider-${index}`);
  if (numInput) numInput.value = numVal.toFixed(1);
  if (sliderInput) sliderInput.value = numVal;
}

function updatePadDuration(index, val) {
  let dur = parseFloat(val) || 2.0;
  dur = Math.min(Math.max(0.1, dur), 10.0);
  padBank[index].duration = dur;
  renderPadsUI();
  setupDragAndDrop();
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

function setupProjectExportImport() {
  document.getElementById('exportProjBtn').addEventListener('click', exportProjectJSON);
  
  const importBtn = document.getElementById('importProjBtn');
  const importInput = document.getElementById('importProjInput');

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', importProjectJSON);
}

function exportProjectJSON() {
  const projectData = {
    version: "1.5",
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
            padBank[i].duration = savedPad.duration || 2.0;
            padBank[i].playbackRate = savedPad.playbackRate || 1.0;
            padBank[i].isLooping = savedPad.isLooping;
            padBank[i].hpFrequency = savedPad.hpFrequency || 20;
            padBank[i].lpFrequency = savedPad.lpFrequency || 20000;
            padBank[i].padBPM = savedPad.padBPM || 120.0;
            padBank[i].isPlaying = false; // Mantiene el estado en STOP al importar

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
  const isCC = (status & 0xF0) === 0xB0;

  if (isNoteOn) {
    const padIndex = padBank.findIndex(p => p.midiNote === note);
    if (padIndex !== -1) togglePlayPad(null, padIndex);
  } else if (isCC) {
    if (note === 112) {
      const hz = 20 * Math.pow(8000 / 20, velocity / 127);
      setPadHighPass(activePadIndex, hz);
    } else if (note === 113) {
      const hz = 200 * Math.pow(20000 / 200, velocity / 127);
      setPadLowPass(activePadIndex, hz);
    }
  }
}

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
  recBtn.innerText = '🔴 REC 1080p';
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
