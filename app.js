// --- ESTADO GLOBAL Y AUDIO CONTEXT ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let activeVideoElement = null;
let activePadIndex = 0;

// Banco de 8 Pads
const padBank = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  midiNote: 36 + i, // Pad 1 = C1 (36) hasta Pad 8 = G1 (43)
  videoElem: null,
  sourceNode: null,
  highpassFilter: null,
  gainNode: null,
  fileName: "Vacío",
  trimStart: 0,
  trimEnd: 0,
  playbackRate: 1.0,
  isLooping: true,
  hpFrequency: 20
}));

// Elementos DOM
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const padsGrid = document.getElementById('padsGrid');
const videoBank = document.getElementById('videoBank');

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  renderPadsUI();
  setupDragAndDrop();
  initWebMIDI();
  setupAudioOutputs();
  setupRecorder();
  
  // Bucle de renderizado Canvas @ 60fps
  requestAnimationFrame(renderCanvasFrame);
});

// Renderizar la rejilla visual de pads
function renderPadsUI() {
  padsGrid.innerHTML = '';

  padBank.forEach((pad, index) => {
    const padCard = document.createElement('div');
    padCard.className = `pad-card ${index === activePadIndex ? 'selected' : ''}`;
    padCard.dataset.index = index;

    padCard.innerHTML = `
      <div class="pad-header">
        <span class="pad-number">PAD ${pad.id}</span>
        <span class="pad-note">Nota: ${pad.midiNote}</span>
      </div>
      <div class="pad-thumb" id="thumb-${index}">${pad.fileName}</div>
      <div class="pad-controls">
        <div class="pad-control-row">
          <label><input type="checkbox" ${pad.isLooping ? 'checked' : ''} onchange="updatePadLoop(${index}, this.checked)"> 🔁 Loop</label>
          <span id="rate-label-${index}" style="color: #a855f7;">${pad.playbackRate.toFixed(2)}x</span>
        </div>
        <div class="pad-control-row">
          <span>Pitch / Speed</span>
          <input type="range" min="0.5" max="2.0" step="0.05" value="${pad.playbackRate}" oninput="updatePadRate(${index}, this.value)">
        </div>
        <div class="pad-control-row">
          <span>High-Pass</span>
          <span id="hp-label-${index}">${Math.round(pad.hpFrequency)} Hz</span>
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
    pad.trimStart = 0;
    pad.trimEnd = video.duration;
    initAudioNodesForPad(pad);
    
    document.getElementById(`thumb-${padIndex}`).innerText = file.name;
    console.log(`Video cargado en Pad ${pad.id}: ${file.name}`);
  };
}

// --- CONFIGURACIÓN WEB AUDIO API ---
function initAudioNodesForPad(pad) {
  if (pad.sourceNode) return; // Evitar reconectar si ya existe

  pad.sourceNode = audioCtx.createMediaElementSource(pad.videoElem);
  pad.highpassFilter = audioCtx.createBiquadFilter();
  pad.highpassFilter.type = 'highpass';
  pad.highpassFilter.frequency.value = pad.hpFrequency;

  pad.gainNode = audioCtx.createGain();
  pad.gainNode.gain.value = 1.0;

  // Cadena Audio: Video -> HighPass -> Gain -> Destination
  pad.sourceNode.connect(pad.highpassFilter);
  pad.highpassFilter.connect(pad.gainNode);
  pad.gainNode.connect(audioCtx.destination);
}

// --- CONTROLES DE PITCH Y LOOP ---
function updatePadRate(index, value) {
  const pad = padBank[index];
  pad.playbackRate = parseFloat(value);
  
  if (pad.videoElem) {
    pad.videoElem.playbackRate = pad.playbackRate;
    pad.videoElem.preservesPitch = false; // Efecto varispeed estilo vinilo
  }
  
  const label = document.getElementById(`rate-label-${index}`);
  if (label) label.innerText = `${pad.playbackRate.toFixed(2)}x`;
}

function updatePadLoop(index, isChecked) {
  padBank[index].isLooping = isChecked;
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

// --- DISPARO DE PADS (TRIGGER / GATE) ---
function triggerPad(index) {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const pad = padBank[index];
  if (!pad || !pad.videoElem) return;

  selectPad(index);

  const v = pad.videoElem;
  v.playbackRate = pad.playbackRate;
  v.preservesPitch = false;

  v.currentTime = pad.trimStart;
  v.play();

  // Control de Loop manual para respetar TrimEnd
  v.ontimeupdate = () => {
    if (pad.isLooping && pad.trimEnd > 0 && v.currentTime >= pad.trimEnd) {
      v.currentTime = pad.trimStart;
    }
  };

  activeVideoElement = v;

  // Feedback visual
  const card = document.querySelectorAll('.pad-card')[index];
  if (card) card.classList.add('active');
}

function releasePad(index) {
  const pad = padBank[index];
  if (!pad || !pad.videoElem) return;

  pad.videoElem.pause();

  const card = document.querySelectorAll('.pad-card')[index];
  if (card) card.classList.remove('active');
}

// --- RENDERIZADO EN CANVAS ---
function renderCanvasFrame() {
  if (activeVideoElement && !activeVideoElement.paused) {
    ctx.drawImage(activeVideoElement, 0, 0, canvas.width, canvas.height);
  } else if (!activeVideoElement) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(renderCanvasFrame);
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
    // Encoder CC 112 controla el High-Pass del pad seleccionado actualmente
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
    console.warn('No se pudieron listar las tarjetas de audio:', err);
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

  // Conectar las ganancias de los pads al destino de grabación
  padBank.forEach(pad => {
    if (pad.gainNode) pad.gainNode.connect(audioDestination);
  });

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
