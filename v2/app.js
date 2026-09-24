/* ============================================================
   AV CHOPPER — INSTRUMENTO AUDIOVISUAL DE 16 PADS (v3)
   Arquitectura: PLAYLIST → VIDEO → CUES → PADS → PERFORMANCE → VISUALIZER
   ============================================================

   DECISIONES TÉCNICAS (leer antes de tocar el código):

   1) Cada PAD que reproduce tiene su PROPIA instancia de reproducción
      (su propio <video> o su propio YT.Player), separada del "editor"
      que se usa para previsualizar mientras se editan cues. Esto es
      necesario porque un mismo <video>/iframe no puede estar en dos
      posiciones de reproducción a la vez: si Pad 1 y Pad 4 usan cues
      distintos del mismo Video 01, cada uno necesita su propia copia.
      Estas instancias de pad se crean de forma perezosa (la primera
      vez que el pad suena) y se destruyen si el pad cambia de cue.

   2) YouTube NO puede dibujarse en el <canvas> (el iframe es de otro
      origen) NI su audio puede entrar al grafo de Web Audio API (la
      API de YouTube no expone un MediaStream). Esto es una limitación
      real del navegador, no una falta de implementación. Por eso:
         - Los pads con cue de YouTube reproducen en un "monitor"
           aparte (fuera del canvas compositor), visible para el
           usuario.
         - No aparecen en el canvas ni en la grabación.
         - Sí se puede controlar su volumen/mute vía la API de
           YouTube (eso sí es técnicamente posible), pero no se
           mezcla con el master ni se graba.

   3) Mute/Solo se mantienen a nivel de PAD (además de Volume, HPF,
      LPF, Rate, Loop, Trigger/Gate, Visual, BPM/Sync) aunque no
      aparecían en el JSON de ejemplo del documento de arquitectura.
   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURACIÓN
   ============================================================ */

const CONFIG = {
  PAD_COUNT: 16,
  KEY_MAP: ["1", "2", "3", "4", "q", "w", "e", "r", "a", "s", "d", "f", "z", "x", "c", "v"],
  MIDI_BASE_NOTE: 36, // 36–51

  DEFAULT_BPM: 120,
  DEFAULT_MASTER_VOLUME: 0.8,

  HPF_MIN: 20,
  HPF_MAX: 8000,
  LPF_MIN: 20,
  LPF_MAX: 20000,

  MIN_PLAYBACK_RATE: 0.25,
  MAX_PLAYBACK_RATE: 4,
  YT_ALLOWED_RATES: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],

  MIN_CUE_DURATION: 0.05,
  DEFAULT_NEW_CUE_DURATION: 2,

  SPLIT_MAX_SOURCES: { simple: 1, split2: 2, split4: 4 },

  YT_RETRY_LIMIT: 25, // ~5s (200ms * 25) esperando a que un YT.Player esté listo
  ZOOM_LEVELS: [1, 2, 4, 8, 16]
};

/* ============================================================
   IDENTIFICADORES
   ============================================================ */

let _idCounter = 0;
function generateId(prefix) {
  _idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

/* ============================================================
   ENTIDADES: VIDEO / CUE / PAD
   ============================================================ */

function createVideo({ name, sourceType, sourceUrl = null, fileName = "", duration = 0, youtubeId = "" }) {
  return {
    id: generateId("video"),
    name,
    sourceType, // "local" | "youtube"
    sourceUrl,  // Object URL (solo local) — nunca se exporta
    youtubeId,
    fileName,
    duration,   // segundos
    cues: [],
    linked: sourceType === "youtube" ? true : !!sourceUrl,
    // runtime (no se exporta):
    editorEl: null,
    editorYtPlayer: null,
    editorReady: false
  };
}

function createCue(videoId, { name, startTime, endTime }) {
  return { id: generateId("cue"), videoId, name, startTime, endTime };
}

function cueDuration(cue) {
  return Math.max(0, cue.endTime - cue.startTime);
}

function createPad(index) {
  return {
    id: index + 1,
    key: CONFIG.KEY_MAP[index],
    midiNote: CONFIG.MIDI_BASE_NOTE + index,

    cueId: null,
    playMode: "trigger", // "trigger" | "gate"
    loop: false,
    volume: 1,
    muted: false,
    solo: false,
    highPass: CONFIG.HPF_MIN,
    lowPass: CONFIG.LPF_MAX,
    playbackRate: 1,
    visualMode: "auto", // "auto" | "visible" | "hidden"
    bpm: CONFIG.DEFAULT_BPM,
    sync: false,

    // runtime:
    playing: false,
    playToken: 0,
    engine: null, // { kind:"local", videoId, videoEl, ready } | { kind:"youtube", videoId, ytPlayer, containerEl, ready }
    audioSource: null,
    highpassNode: null,
    lowpassNode: null,
    gainNode: null,
    meterValue: 0
  };
}

/* ============================================================
   ESTADO GLOBAL
   ============================================================ */

const videos = [];
const pads = Array.from({ length: CONFIG.PAD_COUNT }, (_, i) => createPad(i));

const state = {
  workMode: "chop", // "chop" | "multi"
  selectedVideoId: null,
  selectedCueId: null,
  selectedPadId: 1,

  playheadTime: 0,
  timelineZoomIndex: 0,
  timelineDrag: null, // { kind:"move"|"resize-start"|"resize-end"|"scrub", cueId, pointerId, ... }

  globalBpm: CONFIG.DEFAULT_BPM,
  masterVolume: CONFIG.DEFAULT_MASTER_VOLUME,

  visualizerMode: "simple", // "simple" | "split2" | "split4"
  visualActiveSources: [], // ids de pad, más reciente al final

  midiInputId: "",

  isRecording: false,
  recordingStartedAt: 0,
  recordingTimerHandle: null,
  recorder: null,
  recordingChunks: [],

  editorPreviewWatch: null // { videoId, endTime } — corta el preview del editor al llegar al fin del cue
};

/* ============================================================
   AUDIO CONTEXT & GLOBALES
   ============================================================ */

let audioCtx = null;
let masterGainNode = null;
let recordingDestination = null;

function initializeAudio() {
  if (audioCtx) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    setStatus("AUDIO UNSUPPORTED", false);
    return;
  }
  audioCtx = new AudioContextClass();
  masterGainNode = audioCtx.createGain();
  masterGainNode.gain.value = state.masterVolume;
  masterGainNode.connect(audioCtx.destination);
}

async function resumeAudio() {
  initializeAudio();
  if (audioCtx && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (error) {
      console.error("Error al reactivar AudioContext:", error);
      setStatus("AUDIO ERROR", false);
    }
  }
}

/* ============================================================
   DOM
   ============================================================ */

const dom = {
  workModeChopBtn: document.getElementById("workModeChopBtn"),
  workModeMultiBtn: document.getElementById("workModeMultiBtn"),

  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  audioStartButton: document.getElementById("audioStartButton"),
  recordButton: document.getElementById("recordButton"),
  recordingTimer: document.getElementById("recordingTimer"),

  masterVolume: document.getElementById("masterVolume"),
  globalBpmValue: document.getElementById("globalBpmValue"),
  globalTapButton: document.getElementById("globalTapButton"),

  midiInputSelect: document.getElementById("midiInputSelect"),
  midiStatus: document.getElementById("midiStatus"),

  loadProjectButton: document.getElementById("loadProjectButton"),
  saveProjectButton: document.getElementById("saveProjectButton"),
  clearProjectButton: document.getElementById("clearProjectButton"),
  projectFileInput: document.getElementById("projectFileInput"),

  playlistList: document.getElementById("playlistList"),
  addLocalVideoButton: document.getElementById("addLocalVideoButton"),
  addYoutubeVideoButton: document.getElementById("addYoutubeVideoButton"),
  youtubeUrlInput: document.getElementById("youtubeUrlInput"),
  mediaFileInput: document.getElementById("mediaFileInput"),
  relinkFileInput: document.getElementById("relinkFileInput"),

  timelineTitle: document.getElementById("timelineTitle"),
  timelineTrack: document.getElementById("timelineTrack"),
  timelineCues: document.getElementById("timelineCues"),
  timelinePlayhead: document.getElementById("timelinePlayhead"),
  timelineRuler: document.getElementById("timelineRuler"),
  timelineZoomIn: document.getElementById("timelineZoomIn"),
  timelineZoomOut: document.getElementById("timelineZoomOut"),
  timelineZoomLevel: document.getElementById("timelineZoomLevel"),
  editorPreviewContainer: document.getElementById("editorPreviewContainer"),
  transportPlayPause: document.getElementById("transportPlayPause"),
  transportGoStart: document.getElementById("transportGoStart"),
  playheadTimeLabel: document.getElementById("playheadTimeLabel"),

  cuePropsEmpty: document.getElementById("cuePropsEmpty"),
  cuePropsForm: document.getElementById("cuePropsForm"),
  cueNameInput: document.getElementById("cueNameInput"),
  cueStartInput: document.getElementById("cueStartInput"),
  cueEndInput: document.getElementById("cueEndInput"),
  cueDurationInput: document.getElementById("cueDurationInput"),
  cueNewButton: document.getElementById("cueNewButton"),
  cueDeleteButton: document.getElementById("cueDeleteButton"),
  cueDuplicateButton: document.getElementById("cueDuplicateButton"),
  cueSplitButton: document.getElementById("cueSplitButton"),
  cueMergeButton: document.getElementById("cueMergeButton"),
  cueDivide2: document.getElementById("cueDivide2"),
  cueDivide4: document.getElementById("cueDivide4"),
  cueDivide8: document.getElementById("cueDivide8"),
  cuePreviewButton: document.getElementById("cuePreviewButton"),
  cueGoStartButton: document.getElementById("cueGoStartButton"),
  cueGoEndButton: document.getElementById("cueGoEndButton"),
  cuePadAssignGrid: document.getElementById("cuePadAssignGrid"),

  outputCanvas: document.getElementById("outputCanvas"),
  canvasOverlayTag: document.getElementById("canvasOverlayTag"),
  visualizerModeButtons: document.getElementById("visualizerModeButtons"),
  ytMonitor: document.getElementById("ytMonitor"),

  padsGrid: document.getElementById("padsGrid"),

  padDetailEmpty: document.getElementById("padDetailEmpty"),
  padDetailForm: document.getElementById("padDetailForm"),
  padDetailTitle: document.getElementById("padDetailTitle"),
  padCueLabel: document.getElementById("padCueLabel"),
  padModeButton: document.getElementById("padModeButton"),
  padLoopButton: document.getElementById("padLoopButton"),
  padMuteButton: document.getElementById("padMuteButton"),
  padSoloButton: document.getElementById("padSoloButton"),
  padVolumeInput: document.getElementById("padVolumeInput"),
  padVolumeOutput: document.getElementById("padVolumeOutput"),
  padHPInput: document.getElementById("padHPInput"),
  padHPOutput: document.getElementById("padHPOutput"),
  padLPInput: document.getElementById("padLPInput"),
  padLPOutput: document.getElementById("padLPOutput"),
  padRateInput: document.getElementById("padRateInput"),
  padRateOutput: document.getElementById("padRateOutput"),
  padBpmInput: document.getElementById("padBpmInput"),
  padSyncButton: document.getElementById("padSyncButton"),
  padVisualSelect: document.getElementById("padVisualSelect"),
  padUnassignButton: document.getElementById("padUnassignButton"),

  videoBank: document.getElementById("videoBank"),
  ytPlayersContainer: document.getElementById("ytPlayersContainer")
};

/* ============================================================
   HELPERS GENERALES
   ============================================================ */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getVideo(id) {
  return videos.find(v => v.id === id) || null;
}
function getCue(id) {
  for (const v of videos) {
    const c = v.cues.find(cc => cc.id === id);
    if (c) return c;
  }
  return null;
}
function getVideoForCue(cue) {
  return cue ? getVideo(cue.videoId) : null;
}
function getPad(id) {
  return pads.find(p => p.id === id) || null;
}
function padsUsingVideo(videoId) {
  const cueIds = new Set((getVideo(videoId)?.cues || []).map(c => c.id));
  return pads.filter(p => p.cueId && cueIds.has(p.cueId));
}

function formatTimecode(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rem.toFixed(3).padStart(6, "0")}`;
}

function parseTimecode(str) {
  const raw = String(str).trim();
  if (raw.includes(":")) {
    const parts = raw.split(":");
    const m = parseInt(parts[0], 10) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  const val = parseFloat(raw);
  return Number.isFinite(val) ? val : 0;
}

function freqToSlider(freq, min, max) {
  const c = clamp(freq, min, max);
  return (Math.log(c / min) / Math.log(max / min)) * 100;
}
function sliderToFreq(pos, min, max) {
  const c = clamp(Number(pos), 0, 100);
  return min * Math.pow(max / min, c / 100);
}
function formatFreq(freq) {
  if (freq >= 1000) return `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}kHz`;
  return `${Math.round(freq)}Hz`;
}

function snapToAllowedYouTubeRate(rate) {
  return CONFIG.YT_ALLOWED_RATES.reduce(
    (closest, allowed) => (Math.abs(allowed - rate) < Math.abs(closest - rate) ? allowed : closest),
    CONFIG.YT_ALLOWED_RATES[0]
  );
}

function getPadEffectiveRate(pad) {
  if (!pad.sync || !state.globalBpm || !pad.bpm) return pad.playbackRate;
  return pad.playbackRate * (state.globalBpm / pad.bpm);
}

function setStatus(text, active = false) {
  if (dom.statusText) dom.statusText.textContent = text;
  if (dom.statusDot) {
    dom.statusDot.style.background = active ? "#00ffcc" : "#888";
    dom.statusDot.style.boxShadow = active ? "0 0 8px #00ffcc" : "none";
  }
}

function extractYouTubeId(url) {
  if (!url) return "";
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{11})/);
  return match ? match[1] : url.length === 11 ? url : "";
}

/* ============================================================
   INICIALIZACIÓN
   ============================================================ */

document.addEventListener("DOMContentLoaded", initialize);

function initialize() {
  initializeAudio();
  bindTopbarControls();
  bindPlaylistControls();
  bindTimelineControls();
  bindCuePropsControls();
  bindVisualizerControls();
  bindPadDetailControls();
  bindKeyboard();
  initializeMIDI();

  renderAll();
  requestAnimationFrame(performanceTick);
  setStatus("READY", false);
}

function renderAll() {
  applyWorkModeUI();
  renderPlaylist();
  renderTimeline();
  renderCueProperties();
  renderVisualizerModeButtons();
  renderPadGrid();
  renderPadDetail();
  updateGlobalBpmUI();
}

/* ============================================================
   MODO DE TRABAJO: CHOP / MULTI
   ============================================================ */

function setWorkMode(mode) {
  state.workMode = mode === "multi" ? "multi" : "chop";
  applyWorkModeUI();
}

function applyWorkModeUI() {
  document.body.classList.toggle("mode-chop", state.workMode === "chop");
  document.body.classList.toggle("mode-multi", state.workMode === "multi");
  if (dom.workModeChopBtn) dom.workModeChopBtn.classList.toggle("active", state.workMode === "chop");
  if (dom.workModeMultiBtn) dom.workModeMultiBtn.classList.toggle("active", state.workMode === "multi");
}

/* ============================================================
   TOPBAR
   ============================================================ */

function bindTopbarControls() {
  if (dom.workModeChopBtn) dom.workModeChopBtn.addEventListener("click", () => setWorkMode("chop"));
  if (dom.workModeMultiBtn) dom.workModeMultiBtn.addEventListener("click", () => setWorkMode("multi"));

  if (dom.audioStartButton) {
    dom.audioStartButton.addEventListener("click", async () => {
      await resumeAudio();
      setStatus("AUDIO READY", false);
      dom.audioStartButton.textContent = "AUDIO ✓";
    });
  }

  if (dom.masterVolume) {
    dom.masterVolume.addEventListener("input", event => {
      state.masterVolume = Number(event.target.value);
      if (masterGainNode && audioCtx) {
        masterGainNode.gain.setTargetAtTime(state.masterVolume, audioCtx.currentTime, 0.01);
      }
    });
  }

  if (dom.globalTapButton) dom.globalTapButton.addEventListener("click", handleGlobalTap);

  if (dom.recordButton) dom.recordButton.addEventListener("click", toggleRecording);

  if (dom.saveProjectButton) dom.saveProjectButton.addEventListener("click", exportProject);
  if (dom.loadProjectButton) dom.loadProjectButton.addEventListener("click", () => dom.projectFileInput.click());
  if (dom.projectFileInput) dom.projectFileInput.addEventListener("change", handleProjectFile);
  if (dom.clearProjectButton) dom.clearProjectButton.addEventListener("click", clearProject);

  if (dom.midiInputSelect) {
    dom.midiInputSelect.addEventListener("change", event => selectMIDIInput(event.target.value));
  }
}

let tapTimes = [];
function handleGlobalTap() {
  const now = performance.now();
  tapTimes.push(now);
  if (tapTimes.length > 4) tapTimes.shift();

  if (tapTimes.length > 1) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round(60000 / avgMs);
    if (bpm >= 30 && bpm <= 300) {
      state.globalBpm = bpm;
      updateGlobalBpmUI();
    }
  }
}

function updateGlobalBpmUI() {
  if (dom.globalBpmValue) dom.globalBpmValue.textContent = `${state.globalBpm} BPM`;
}

/* ============================================================
   MOTOR DE REPRODUCCIÓN POR PAD (instancias dedicadas)
   ============================================================ */

function destroyPadEngine(pad) {
  if (pad.audioSource) { try { pad.audioSource.disconnect(); } catch (e) {} }
  if (pad.highpassNode) { try { pad.highpassNode.disconnect(); } catch (e) {} }
  if (pad.lowpassNode) { try { pad.lowpassNode.disconnect(); } catch (e) {} }
  if (pad.gainNode) { try { pad.gainNode.disconnect(); } catch (e) {} }
  pad.audioSource = null;
  pad.highpassNode = null;
  pad.lowpassNode = null;
  pad.gainNode = null;

  if (pad.engine) {
    if (pad.engine.kind === "local" && pad.engine.videoEl) {
      try {
        pad.engine.videoEl.pause();
        pad.engine.videoEl.src = "";
        pad.engine.videoEl.load();
        pad.engine.videoEl.remove();
      } catch (e) {
        console.warn("Error destruyendo <video> de pad:", e);
      }
    }
    if (pad.engine.kind === "youtube") {
      if (pad.engine.ytPlayer) {
        try { pad.engine.ytPlayer.destroy(); } catch (e) {}
      }
      if (pad.engine.containerEl) pad.engine.containerEl.remove();
    }
  }
  pad.engine = null;
  pad.playing = false;
}

function ensurePadEngine(pad, video) {
  if (pad.engine && pad.engine.videoId === video.id && pad.engine.kind === video.sourceType) {
    return pad.engine;
  }
  destroyPadEngine(pad);

  if (video.sourceType === "local") {
    const el = document.createElement("video");
    el.src = video.sourceUrl;
    el.preload = "auto";
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.dataset.pad = pad.id;
    if (dom.videoBank) dom.videoBank.appendChild(el);

    pad.engine = { kind: "local", videoId: video.id, videoEl: el, ready: false };
    el.addEventListener("loadedmetadata", () => { pad.engine.ready = true; });
    el.addEventListener("error", () => {
      setStatus(`PAD ${pad.id}: ERROR DE MEDIA`, false);
      pad.playing = false;
      updatePadTileState(pad.id);
    });

    if (audioCtx) {
      try {
        pad.audioSource = audioCtx.createMediaElementSource(el);
        pad.highpassNode = audioCtx.createBiquadFilter();
        pad.highpassNode.type = "highpass";
        pad.highpassNode.frequency.value = pad.highPass;
        pad.lowpassNode = audioCtx.createBiquadFilter();
        pad.lowpassNode.type = "lowpass";
        pad.lowpassNode.frequency.value = pad.lowPass;
        pad.gainNode = audioCtx.createGain();

        pad.audioSource.connect(pad.highpassNode);
        pad.highpassNode.connect(pad.lowpassNode);
        pad.lowpassNode.connect(pad.gainNode);
        pad.gainNode.connect(masterGainNode);

        updatePadGain(pad);
      } catch (e) {
        console.error("Error creando grafo de audio del pad:", e);
      }
    }
  } else if (video.sourceType === "youtube") {
    const container = document.createElement("div");
    container.className = "yt-monitor-item";
    container.id = `pad-yt-${pad.id}-${generateId("box")}`;

    const label = document.createElement("div");
    label.className = "yt-monitor-label";
    label.textContent = `PAD ${pad.id}`;
    const frameHost = document.createElement("div");
    frameHost.className = "yt-monitor-frame";
    const inner = document.createElement("div");
    inner.id = container.id + "-inner";
    frameHost.appendChild(inner);
    container.append(label, frameHost);

    if (dom.ytMonitor) dom.ytMonitor.appendChild(container);

    pad.engine = { kind: "youtube", videoId: video.id, ytPlayer: null, containerEl: container, ready: false };

    ensureYouTubeAPI(() => {
      if (!pad.engine || pad.engine.videoId !== video.id) return; // el pad cambió de cue mientras cargaba la API
      pad.engine.ytPlayer = new window.YT.Player(inner.id, {
        height: "100%",
        width: "100%",
        videoId: video.youtubeId,
        playerVars: { autoplay: 0, controls: 1, disablekb: 1, fs: 0, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            pad.engine.ready = true;
            updatePadGain(pad);
          }
        }
      });
    });
  }

  return pad.engine;
}

/* ============================================================
   PREVIEW DEL EDITOR (independiente de los pads de performance)
   ============================================================ */

function ensureVideoEditorEngine(video) {
  if (video.sourceType === "local") {
    if (video.editorEl) return video.editorEl;
    if (!video.sourceUrl) return null;
    const el = document.createElement("video");
    el.src = video.sourceUrl;
    el.preload = "metadata";
    el.playsInline = true;
    el.dataset.editorFor = video.id;
    if (dom.videoBank) dom.videoBank.appendChild(el);
    video.editorEl = el;

    el.addEventListener("loadedmetadata", () => {
      video.editorReady = true;
      if (!video.duration || video.duration <= 0) video.duration = el.duration || 0;
      renderPlaylist();
      if (state.selectedVideoId === video.id) renderTimeline();
    });
    return el;
  }

  if (video.sourceType === "youtube") {
    if (video.editorYtPlayer) return video.editorYtPlayer;
    const container = document.createElement("div");
    container.id = `editor-yt-${video.id}`;
    if (dom.editorPreviewContainer) dom.editorPreviewContainer.appendChild(container);

    ensureYouTubeAPI(() => {
      video.editorYtPlayer = new window.YT.Player(container.id, {
        height: "100%",
        width: "100%",
        videoId: video.youtubeId,
        playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            video.editorReady = true;
            const d = video.editorYtPlayer.getDuration();
            if (d) video.duration = d;
            renderPlaylist();
            if (state.selectedVideoId === video.id) renderTimeline();
          }
        }
      });
    });
    return null;
  }
  return null;
}

function destroyVideoEditorEngine(video) {
  if (video.editorEl) {
    try {
      video.editorEl.pause();
      video.editorEl.src = "";
      video.editorEl.load();
      video.editorEl.remove();
    } catch (e) {}
    video.editorEl = null;
  }
  if (video.editorYtPlayer) {
    try { video.editorYtPlayer.destroy(); } catch (e) {}
    video.editorYtPlayer = null;
  }
  const leftoverContainer = document.getElementById(`editor-yt-${video.id}`);
  if (leftoverContainer) leftoverContainer.remove();
  video.editorReady = false;
}

function ensureYouTubeAPI(callback) {
  if (window.YT && window.YT.Player) {
    callback();
    return;
  }
  if (!window.onYouTubeIframeAPIReady) {
    window.onYouTubeIframeAPIReady = () => {
      window.__ytApiReady = true;
      if (window.__ytCallbacks) {
        window.__ytCallbacks.forEach(cb => cb());
        window.__ytCallbacks = [];
      }
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  }
  if (window.__ytApiReady) callback();
  else {
    window.__ytCallbacks = window.__ytCallbacks || [];
    window.__ytCallbacks.push(callback);
  }
}

/* ============================================================
   GANANCIA DE AUDIO POR PAD (Volume + Mute + Solo)
   ============================================================ */

function updatePadGain(pad) {
  const anySolo = pads.some(p => p.solo);
  let multiplier = 1;
  if (pad.muted) multiplier = 0;
  else if (anySolo) multiplier = pad.solo ? 1 : 0;

  const target = clamp(pad.volume, 0, 1) * multiplier;

  if (pad.gainNode && audioCtx) {
    pad.gainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.01);
  }

  // El volumen/mute de YouTube se puede controlar vía su propia API (esto sí es
  // posible), pero su audio nunca pasa por masterGainNode: no se mezcla ni se graba.
  if (pad.engine && pad.engine.kind === "youtube" && pad.engine.ytPlayer && pad.engine.ready) {
    try {
      pad.engine.ytPlayer.setVolume(Math.round(target * 100));
      if (target <= 0) pad.engine.ytPlayer.mute();
      else pad.engine.ytPlayer.unMute();
    } catch (e) {}
  }
}
function updateAllPadGains() {
  pads.forEach(updatePadGain);
}

/* ============================================================
   PLAYBACK: START / STOP
   ============================================================ */

function startPad(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  if (!pad.cueId) { setStatus(`PAD ${padId}: SIN CUE ASIGNADO`, false); return; }
  const cue = getCue(pad.cueId);
  if (!cue) { setStatus(`PAD ${padId}: CUE INEXISTENTE`, false); pad.cueId = null; return; }
  const video = getVideoForCue(cue);
  if (!video) { setStatus(`PAD ${padId}: VIDEO INEXISTENTE`, false); return; }
  if (video.sourceType === "local" && !video.linked) { setStatus("FUENTE LOCAL NO VINCULADA", false); return; }

  resumeAudio().then(() => {
    const engine = ensurePadEngine(pad, video);
    pad.playToken += 1;
    const token = pad.playToken;

    if (video.sourceType === "local") {
      const el = engine.videoEl;
      const beginPlay = () => {
        if (pad.playToken !== token) return;
        try { el.currentTime = cue.startTime; } catch (e) {}
        el.playbackRate = getPadEffectiveRate(pad);
        el.preservesPitch = false;
        el.play()
          .then(() => {
            if (pad.playToken !== token) return;
            pad.playing = true;
            onPadStarted(pad);
          })
          .catch(err => {
            console.error("Error reproduciendo pad:", err);
            setStatus("PLAY ERROR", false);
          });
      };
      if (el.readyState >= 1) beginPlay();
      else el.addEventListener("loadedmetadata", beginPlay, { once: true });
    } else if (video.sourceType === "youtube") {
      const attemptPlay = (retries = 0) => {
        if (pad.playToken !== token) return;
        if (!engine.ready || !engine.ytPlayer) {
          if (retries > CONFIG.YT_RETRY_LIMIT) { setStatus(`PAD ${padId}: YOUTUBE NO DISPONIBLE`, false); return; }
          setStatus("YOUTUBE CARGANDO...", false);
          setTimeout(() => attemptPlay(retries + 1), 200);
          return;
        }
        try {
          engine.ytPlayer.seekTo(cue.startTime, true);
          engine.ytPlayer.setPlaybackRate(snapToAllowedYouTubeRate(getPadEffectiveRate(pad)));
          engine.ytPlayer.playVideo();
          pad.playing = true;
          onPadStarted(pad);
        } catch (err) {
          console.error("Error reproduciendo YouTube pad:", err);
          setStatus("YOUTUBE ERROR", false);
        }
      };
      attemptPlay();
    }
  });
}

function stopPad(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  pad.playToken += 1;

  if (pad.engine) {
    if (pad.engine.kind === "local" && pad.engine.videoEl) {
      try { pad.engine.videoEl.pause(); } catch (e) {}
    } else if (pad.engine.kind === "youtube" && pad.engine.ytPlayer) {
      try { pad.engine.ytPlayer.pauseVideo(); } catch (e) {}
    }
  }

  pad.playing = false;
  pad.meterValue = 0;
  onPadStopped(pad);
}

function stopAllPads() {
  pads.forEach(pad => { if (pad.playing) stopPad(pad.id); });
}

function onPadStarted(pad) {
  registerVisualActivation(pad);
  updatePadTileState(pad.id);
  updateCanvasOverlayTag();
  setStatus(`PLAY PAD ${pad.id}`, true);
}
function onPadStopped(pad) {
  unregisterVisualSource(pad.id);
  updatePadTileState(pad.id);
  updateCanvasOverlayTag();
}

// Punto único de entrada para teclado / MIDI / botón: decide trigger vs gate.
function handlePadPress(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  if (pad.playMode === "gate") {
    if (!pad.playing) startPad(padId);
  } else if (pad.playing) {
    stopPad(padId);
  } else {
    startPad(padId);
  }
}
function handlePadRelease(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  if (pad.playMode === "gate" && pad.playing) stopPad(padId);
}

/* ============================================================
   TICK DE PERFORMANCE (rAF): límites de cue, loop, meters, canvas
   ============================================================ */

function performanceTick() {
  pads.forEach(pad => {
    if (!pad.playing || !pad.cueId) return;
    const cue = getCue(pad.cueId);
    if (!cue || !pad.engine) return;
    const video = getVideoForCue(cue);
    if (!video) return;

    let currentTime = null;
    if (video.sourceType === "local" && pad.engine.videoEl) {
      currentTime = pad.engine.videoEl.currentTime;
    } else if (video.sourceType === "youtube" && pad.engine.ytPlayer && pad.engine.ready) {
      try { currentTime = pad.engine.ytPlayer.getCurrentTime(); } catch (e) {}
    }
    if (currentTime === null || currentTime === undefined) return;

    const dur = Math.max(cueDuration(cue), 0.001);
    const progress = clamp(((currentTime - cue.startTime) / dur) * 100, 0, 100);
    pad.meterValue = progress;
    updatePadMeterUI(pad.id, progress);

    if (currentTime >= cue.endTime - 0.02) {
      if (pad.loop) {
        if (video.sourceType === "local") pad.engine.videoEl.currentTime = cue.startTime;
        else if (pad.engine.ytPlayer) pad.engine.ytPlayer.seekTo(cue.startTime, true);
      } else {
        stopPad(pad.id);
      }
    }
  });

  // Preview del editor: cortar al llegar al fin del cue en vista previa
  if (state.editorPreviewWatch) {
    const { videoId, endTime } = state.editorPreviewWatch;
    const video = getVideo(videoId);
    if (video && video.editorEl && !video.editorEl.paused) {
      if (video.editorEl.currentTime >= endTime - 0.02) {
        video.editorEl.pause();
        state.editorPreviewWatch = null;
      }
      updatePlayheadUI(video.editorEl.currentTime);
    }
  }

  renderCanvasFrame();
  requestAnimationFrame(performanceTick);
}

/* ============================================================
   VISUALIZADOR: activación / rotación de fuentes visuales
   ============================================================ */

function registerVisualActivation(pad) {
  if (pad.visualMode === "hidden") return;
  const max = CONFIG.SPLIT_MAX_SOURCES[state.visualizerMode] || 1;
  let sources = state.visualActiveSources.filter(id => id !== pad.id);
  sources.push(pad.id);
  while (sources.length > max) {
    let evictIdx = sources.findIndex(id => {
      const p = getPad(id);
      return p && p.visualMode === "auto";
    });
    if (evictIdx === -1) evictIdx = 0;
    sources.splice(evictIdx, 1);
  }
  state.visualActiveSources = sources;
}

function unregisterVisualSource(padId) {
  state.visualActiveSources = state.visualActiveSources.filter(id => id !== padId);
}

function setVisualizerMode(mode) {
  state.visualizerMode = mode;
  const max = CONFIG.SPLIT_MAX_SOURCES[mode] || 1;
  state.visualActiveSources = state.visualActiveSources.slice(-max);
  renderVisualizerModeButtons();
}

function layoutCells(mode, w, h) {
  if (mode === "split2") return [{ x: 0, y: 0, w: w / 2, h }, { x: w / 2, y: 0, w: w / 2, h }];
  if (mode === "split4") {
    return [
      { x: 0, y: 0, w: w / 2, h: h / 2 },
      { x: w / 2, y: 0, w: w / 2, h: h / 2 },
      { x: 0, y: h / 2, w: w / 2, h: h / 2 },
      { x: w / 2, y: h / 2, w: w / 2, h: h / 2 }
    ];
  }
  return [{ x: 0, y: 0, w, h }];
}

/* ============================================================
   CANVAS
   ============================================================ */

function renderCanvasFrame() {
  if (!dom.outputCanvas) return;
  const ctx = dom.outputCanvas.getContext("2d");
  const w = dom.outputCanvas.width;
  const h = dom.outputCanvas.height;

  const sources = state.visualActiveSources.map(id => getPad(id)).filter(p => p && p.playing);

  if (sources.length === 0) {
    drawStandby(ctx, w, h);
    return;
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const cells = layoutCells(state.visualizerMode, w, h);

  sources.forEach((pad, i) => {
    const cell = cells[i];
    if (!cell) return;
    const cue = getCue(pad.cueId);
    const video = getVideoForCue(cue);
    if (!video) return;

    if (video.sourceType === "local" && pad.engine && pad.engine.videoEl && pad.engine.videoEl.readyState >= 2) {
      ctx.drawImage(pad.engine.videoEl, cell.x, cell.y, cell.w, cell.h);
    } else if (video.sourceType === "youtube") {
      drawYoutubePlaceholder(ctx, cell);
    } else {
      drawEmptyCell(ctx, cell);
    }
    drawCellLabel(ctx, cell, `PAD ${pad.id}`);
  });
}

function drawStandby(ctx, w, h) {
  ctx.fillStyle = "#111116";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "14px monospace";
  ctx.textAlign = "center";
  ctx.fillText("AV CHOPPER :: NO HAY FUENTES ACTIVAS", w / 2, h / 2);
}

function drawYoutubePlaceholder(ctx, cell) {
  ctx.fillStyle = "#1a1420";
  ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
  ctx.fillStyle = "#ff4d5e";
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText("▶ YOUTUBE", cell.x + cell.w / 2, cell.y + cell.h / 2 - 6);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px monospace";
  ctx.fillText("ver monitor aparte", cell.x + cell.w / 2, cell.y + cell.h / 2 + 10);
}

function drawEmptyCell(ctx, cell) {
  ctx.fillStyle = "#0f0f13";
  ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
}

function drawCellLabel(ctx, cell, text) {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(cell.x + 4, cell.y + 4, text.length * 7 + 10, 16);
  ctx.fillStyle = "#00ffcc";
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.fillText(text, cell.x + 8, cell.y + 15);
}

function updateCanvasOverlayTag() {
  const count = pads.filter(p => p.playing).length;
  if (dom.canvasOverlayTag) dom.canvasOverlayTag.textContent = count > 0 ? `ACTIVO (${count})` : "STANDBY";
}

/* ============================================================
   PLAYLIST DE VIDEOS
   ============================================================ */

function bindPlaylistControls() {
  if (dom.addLocalVideoButton) dom.addLocalVideoButton.addEventListener("click", () => dom.mediaFileInput.click());
  if (dom.mediaFileInput) dom.mediaFileInput.addEventListener("change", handleAddLocalVideoFile);
  if (dom.addYoutubeVideoButton) dom.addYoutubeVideoButton.addEventListener("click", handleAddYoutubeVideo);
  if (dom.relinkFileInput) dom.relinkFileInput.addEventListener("change", handleRelinkFile);
}

function handleAddLocalVideoFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    setStatus("FORMATO NO SOPORTADO", false);
    return;
  }

  const url = URL.createObjectURL(file);
  const video = createVideo({ name: file.name, sourceType: "local", sourceUrl: url, fileName: file.name });
  videos.push(video);
  ensureVideoEditorEngine(video);

  state.selectedVideoId = video.id;
  state.selectedCueId = null;
  renderPlaylist();
  renderTimeline();
  renderCueProperties();
  setStatus("VIDEO AGREGADO", false);
}

function handleAddYoutubeVideo() {
  const url = dom.youtubeUrlInput ? dom.youtubeUrlInput.value : "";
  const ytId = extractYouTubeId(url);
  if (!ytId) { setStatus("URL DE YOUTUBE INVÁLIDA", false); return; }

  const video = createVideo({ name: `YouTube ${ytId}`, sourceType: "youtube", youtubeId: ytId, fileName: "" });
  videos.push(video);
  ensureVideoEditorEngine(video);

  if (dom.youtubeUrlInput) dom.youtubeUrlInput.value = "";
  state.selectedVideoId = video.id;
  state.selectedCueId = null;
  renderPlaylist();
  renderTimeline();
  renderCueProperties();
  setStatus("VIDEO DE YOUTUBE AGREGADO", false);
}

let _relinkTargetVideoId = null;
function requestRelink(videoId) {
  _relinkTargetVideoId = videoId;
  if (dom.relinkFileInput) dom.relinkFileInput.click();
}
function handleRelinkFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !_relinkTargetVideoId) return;
  const video = getVideo(_relinkTargetVideoId);
  _relinkTargetVideoId = null;
  if (!video) return;

  if (video.sourceUrl) URL.revokeObjectURL(video.sourceUrl);
  video.sourceUrl = URL.createObjectURL(file);
  video.fileName = file.name;
  video.linked = true;
  destroyVideoEditorEngine(video);
  ensureVideoEditorEngine(video);
  renderPlaylist();
  if (state.selectedVideoId === video.id) renderTimeline();
  setStatus("FUENTE VINCULADA", false);
}

function selectVideo(videoId) {
  state.selectedVideoId = videoId;
  state.selectedCueId = null;
  ensureVideoEditorEngine(getVideo(videoId));
  renderPlaylist();
  renderTimeline();
  renderCueProperties();
}

function removeVideo(videoId) {
  const video = getVideo(videoId);
  if (!video) return;
  const usedBy = padsUsingVideo(videoId);
  if (usedBy.length > 0) {
    const ok = window.confirm(`${usedBy.length} pad(s) usan cues de este video y quedarán sin cue asignado. ¿Eliminar de todas formas?`);
    if (!ok) return;
  }

  const cueIds = new Set(video.cues.map(c => c.id));
  pads.forEach(pad => {
    if (pad.cueId && cueIds.has(pad.cueId)) {
      if (pad.playing) stopPad(pad.id);
      destroyPadEngine(pad);
      pad.cueId = null;
    }
  });

  destroyVideoEditorEngine(video);
  if (video.sourceUrl) URL.revokeObjectURL(video.sourceUrl);

  const idx = videos.findIndex(v => v.id === videoId);
  if (idx !== -1) videos.splice(idx, 1);

  if (state.selectedVideoId === videoId) {
    state.selectedVideoId = videos[0] ? videos[0].id : null;
    state.selectedCueId = null;
  }

  renderPlaylist();
  renderTimeline();
  renderCueProperties();
  renderPadGrid();
  renderPadDetail();
}

function renameVideo(videoId, name) {
  const video = getVideo(videoId);
  if (!video) return;
  video.name = name || video.name;
  renderPlaylist();
  if (state.selectedVideoId === videoId) {
    if (dom.timelineTitle) dom.timelineTitle.textContent = `${video.name} — ${formatTimecode(video.duration)}`;
  }
}

function renderPlaylist() {
  if (!dom.playlistList) return;
  dom.playlistList.innerHTML = "";

  if (videos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "playlist-empty";
    empty.textContent = "Sin videos todavía. Agregá uno para empezar.";
    dom.playlistList.appendChild(empty);
    return;
  }

  videos.forEach(video => {
    const row = document.createElement("div");
    row.className = "playlist-row";
    if (video.id === state.selectedVideoId) row.classList.add("selected");

    const main = document.createElement("div");
    main.className = "playlist-row-main";
    main.addEventListener("click", () => selectVideo(video.id));

    const nameEl = document.createElement("div");
    nameEl.className = "playlist-row-name";
    nameEl.textContent = video.name;

    const meta = document.createElement("div");
    meta.className = "playlist-row-meta";
    const usedByCount = padsUsingVideo(video.id).length;
    const sourceTag = video.sourceType === "youtube" ? "YT" : "LOCAL";
    const linkTag = video.sourceType === "local" && !video.linked ? " · ⚠ no vinculado" : "";
    meta.textContent = `${sourceTag} · ${formatTimecode(video.duration)} · ${video.cues.length} cue(s) · ${usedByCount} pad(s)${linkTag}`;

    main.append(nameEl, meta);

    const actions = document.createElement("div");
    actions.className = "playlist-row-actions";

    if (video.sourceType === "local" && !video.linked) {
      const relinkBtn = document.createElement("button");
      relinkBtn.type = "button";
      relinkBtn.className = "btn-xs";
      relinkBtn.textContent = "VINCULAR";
      relinkBtn.addEventListener("click", e => { e.stopPropagation(); requestRelink(video.id); });
      actions.appendChild(relinkBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-xs btn-danger";
    delBtn.textContent = "✕";
    delBtn.title = "Eliminar video";
    delBtn.addEventListener("click", e => { e.stopPropagation(); removeVideo(video.id); });
    actions.appendChild(delBtn);

    row.append(main, actions);
    dom.playlistList.appendChild(row);
  });
}

/* ============================================================
   TIMELINE / EDITOR DE CUES
   ============================================================ */

function bindTimelineControls() {
  if (dom.timelineZoomIn) dom.timelineZoomIn.addEventListener("click", () => changeZoom(1));
  if (dom.timelineZoomOut) dom.timelineZoomOut.addEventListener("click", () => changeZoom(-1));

  if (dom.transportPlayPause) dom.transportPlayPause.addEventListener("click", toggleEditorPreviewPlayback);
  if (dom.transportGoStart) dom.transportGoStart.addEventListener("click", () => seekEditor(0));

  if (dom.timelineTrack) {
    dom.timelineTrack.addEventListener("pointerdown", onTimelineTrackPointerDown);
  }
}

function changeZoom(direction) {
  const idx = clamp(state.timelineZoomIndex + direction, 0, CONFIG.ZOOM_LEVELS.length - 1);
  state.timelineZoomIndex = idx;
  if (dom.timelineZoomLevel) dom.timelineZoomLevel.textContent = `${CONFIG.ZOOM_LEVELS[idx]}x`;
  renderTimeline();
}

function getSelectedVideo() {
  return state.selectedVideoId ? getVideo(state.selectedVideoId) : null;
}

function timeToPx(time, video, trackWidth) {
  const dur = Math.max(video.duration, 0.001);
  return (time / dur) * trackWidth;
}
function pxToTime(px, video, trackWidth) {
  const dur = Math.max(video.duration, 0.001);
  return clamp((px / trackWidth) * dur, 0, dur);
}

function renderTimeline() {
  const video = getSelectedVideo();

  if (dom.editorPreviewContainer) {
    dom.editorPreviewContainer.querySelectorAll(":scope > video").forEach(el => { if (!el.dataset.keep) el.remove(); });
  }

  if (!video) {
    if (dom.timelineTitle) dom.timelineTitle.textContent = "Ningún video seleccionado";
    if (dom.timelineCues) dom.timelineCues.innerHTML = "";
    if (dom.timelineTrack) dom.timelineTrack.classList.add("empty");
    return;
  }

  if (dom.timelineTrack) dom.timelineTrack.classList.remove("empty");
  if (dom.timelineTitle) dom.timelineTitle.textContent = `${video.name} — ${formatTimecode(video.duration)}`;

  if (dom.editorPreviewContainer && video.sourceType === "local" && video.editorEl) {
    video.editorEl.dataset.keep = "1";
    video.editorEl.controls = false;
    video.editorEl.style.width = "100%";
    video.editorEl.style.height = "100%";
    video.editorEl.style.objectFit = "contain";
    if (video.editorEl.parentElement !== dom.editorPreviewContainer) {
      dom.editorPreviewContainer.appendChild(video.editorEl);
    }
  }

  const zoom = CONFIG.ZOOM_LEVELS[state.timelineZoomIndex];
  const baseWidth = dom.timelineTrack ? dom.timelineTrack.clientWidth || 800 : 800;
  const trackWidth = baseWidth * zoom;

  if (dom.timelineCues) {
    dom.timelineCues.style.width = `${trackWidth}px`;
    dom.timelineCues.innerHTML = "";

    video.cues.forEach(cue => {
      dom.timelineCues.appendChild(renderCueBlock(cue, video, trackWidth));
    });
  }
  if (dom.timelineRuler) dom.timelineRuler.style.width = `${trackWidth}px`;

  updatePlayheadUI(state.playheadTime);
}

function renderCueBlock(cue, video, trackWidth) {
  const block = document.createElement("div");
  block.className = "cue-block";
  block.dataset.cueId = cue.id;
  if (cue.id === state.selectedCueId) block.classList.add("selected");

  const left = timeToPx(cue.startTime, video, trackWidth);
  const width = Math.max(timeToPx(cueDuration(cue), video, trackWidth), 4);
  block.style.left = `${left}px`;
  block.style.width = `${width}px`;

  const label = document.createElement("div");
  label.className = "cue-block-label";
  const assignedPad = pads.find(p => p.cueId === cue.id);
  label.textContent = assignedPad ? `${cue.name} · PAD ${assignedPad.id}` : cue.name;
  block.appendChild(label);

  const handleStart = document.createElement("div");
  handleStart.className = "cue-handle cue-handle-start";
  const handleEnd = document.createElement("div");
  handleEnd.className = "cue-handle cue-handle-end";
  block.append(handleStart, handleEnd);

  block.addEventListener("pointerdown", event => {
    event.stopPropagation();
    selectCue(cue.id);
    const kind = event.target === handleStart ? "resize-start" : event.target === handleEnd ? "resize-end" : "move";
    beginCueDrag(event, cue, video, kind);
  });

  return block;
}

function beginCueDrag(event, cue, video, kind) {
  const trackWidth = dom.timelineCues ? dom.timelineCues.clientWidth : 800;
  const startX = event.clientX;
  const originalStart = cue.startTime;
  const originalEnd = cue.endTime;
  const blockEl = dom.timelineCues.querySelector(`[data-cue-id="${cue.id}"]`);

  state.timelineDrag = { pointerId: event.pointerId, kind, cueId: cue.id };
  try { event.target.setPointerCapture(event.pointerId); } catch (e) {}

  function onMove(moveEvent) {
    const deltaPx = moveEvent.clientX - startX;
    const deltaTime = (deltaPx / trackWidth) * video.duration;

    if (kind === "move") {
      const dur = originalEnd - originalStart;
      let newStart = clamp(originalStart + deltaTime, 0, Math.max(0, video.duration - dur));
      cue.startTime = newStart;
      cue.endTime = newStart + dur;
    } else if (kind === "resize-start") {
      cue.startTime = clamp(originalStart + deltaTime, 0, cue.endTime - CONFIG.MIN_CUE_DURATION);
    } else if (kind === "resize-end") {
      cue.endTime = clamp(originalEnd + deltaTime, cue.startTime + CONFIG.MIN_CUE_DURATION, video.duration);
    }

    if (blockEl) {
      blockEl.style.left = `${timeToPx(cue.startTime, video, trackWidth)}px`;
      blockEl.style.width = `${Math.max(timeToPx(cueDuration(cue), video, trackWidth), 4)}px`;
    }
    if (state.selectedCueId === cue.id) updateCuePropsInputsOnly(cue);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.timelineDrag = null;
    renderPlaylist();
    if (state.selectedCueId === cue.id) renderCueProperties();
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function onTimelineTrackPointerDown(event) {
  if (event.target !== dom.timelineTrack && event.target !== dom.timelineRuler) return;
  const video = getSelectedVideo();
  if (!video) return;
  const rect = dom.timelineTrack.getBoundingClientRect();
  const scrollLeft = dom.timelineTrack.scrollLeft || 0;
  const trackWidth = dom.timelineCues ? dom.timelineCues.clientWidth : rect.width;

  function seekFromEvent(e) {
    const x = e.clientX - rect.left + scrollLeft;
    const t = pxToTime(x, video, trackWidth);
    seekEditor(t);
  }
  seekFromEvent(event);

  function onMove(e) { seekFromEvent(e); }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function seekEditor(time) {
  const video = getSelectedVideo();
  if (!video) return;
  state.playheadTime = clamp(time, 0, video.duration);
  if (video.sourceType === "local" && video.editorEl) {
    try { video.editorEl.currentTime = state.playheadTime; } catch (e) {}
  } else if (video.sourceType === "youtube" && video.editorYtPlayer) {
    try { video.editorYtPlayer.seekTo(state.playheadTime, true); } catch (e) {}
  }
  updatePlayheadUI(state.playheadTime);
}

function toggleEditorPreviewPlayback() {
  const video = getSelectedVideo();
  if (!video) return;
  if (video.sourceType === "local" && video.editorEl) {
    if (video.editorEl.paused) video.editorEl.play().catch(() => {});
    else video.editorEl.pause();
  } else if (video.sourceType === "youtube" && video.editorYtPlayer) {
    try {
      const st = video.editorYtPlayer.getPlayerState();
      if (st === 1) video.editorYtPlayer.pauseVideo();
      else video.editorYtPlayer.playVideo();
    } catch (e) {}
  }
}

function updatePlayheadUI(time) {
  state.playheadTime = time;
  const video = getSelectedVideo();
  if (dom.playheadTimeLabel) dom.playheadTimeLabel.textContent = formatTimecode(time);
  if (dom.timelinePlayhead && video) {
    const trackWidth = dom.timelineCues ? dom.timelineCues.clientWidth : 800;
    dom.timelinePlayhead.style.left = `${timeToPx(time, video, trackWidth)}px`;
  }
}

/* ============================================================
   OPERACIONES DE CUES
   ============================================================ */

function selectCue(cueId) {
  state.selectedCueId = cueId;
  renderTimeline();
  renderCueProperties();
}

function addNewCue() {
  const video = getSelectedVideo();
  if (!video) { setStatus("SELECCIONÁ UN VIDEO PRIMERO", false); return; }
  const start = clamp(state.playheadTime, 0, Math.max(0, video.duration - CONFIG.MIN_CUE_DURATION));
  const end = clamp(start + CONFIG.DEFAULT_NEW_CUE_DURATION, start + CONFIG.MIN_CUE_DURATION, video.duration);
  const cue = createCue(video.id, { name: `Cue ${video.cues.length + 1}`, startTime: start, endTime: end });
  video.cues.push(cue);
  state.selectedCueId = cue.id;
  renderTimeline();
  renderCueProperties();
  renderPlaylist();
}

function deleteCue(cueId) {
  const cue = getCue(cueId);
  if (!cue) return;
  const video = getVideo(cue.videoId);
  if (!video) return;

  pads.forEach(pad => {
    if (pad.cueId === cueId) {
      if (pad.playing) stopPad(pad.id);
      destroyPadEngine(pad);
      pad.cueId = null;
    }
  });

  video.cues = video.cues.filter(c => c.id !== cueId);
  if (state.selectedCueId === cueId) state.selectedCueId = null;

  renderTimeline();
  renderCueProperties();
  renderPlaylist();
  renderPadGrid();
  renderPadDetail();
}

function duplicateCue(cueId) {
  const cue = getCue(cueId);
  if (!cue) return;
  const video = getVideo(cue.videoId);
  const dur = cueDuration(cue);
  let start = cue.endTime;
  let end = start + dur;
  if (end > video.duration) { start = Math.max(0, video.duration - dur); end = video.duration; }
  const copy = createCue(video.id, { name: `${cue.name} copia`, startTime: start, endTime: end });
  video.cues.push(copy);
  state.selectedCueId = copy.id;
  renderTimeline();
  renderCueProperties();
  renderPlaylist();
}

function splitSelectedCueAtPlayhead() {
  const cue = getCue(state.selectedCueId);
  if (!cue) { setStatus("SELECCIONÁ UN CUE", false); return; }
  const video = getVideo(cue.videoId);
  const t = state.playheadTime;
  if (t <= cue.startTime + CONFIG.MIN_CUE_DURATION || t >= cue.endTime - CONFIG.MIN_CUE_DURATION) {
    setStatus("PLAYHEAD FUERA DEL RANGO DEL CUE", false);
    return;
  }
  const originalEnd = cue.endTime;
  cue.endTime = t;
  const secondHalf = createCue(video.id, { name: `${cue.name} B`, startTime: t, endTime: originalEnd });
  video.cues.push(secondHalf);
  state.selectedCueId = secondHalf.id;
  renderTimeline();
  renderCueProperties();
  renderPlaylist();
}

function mergeSelectedCueWithNext() {
  const cue = getCue(state.selectedCueId);
  if (!cue) { setStatus("SELECCIONÁ UN CUE", false); return; }
  const video = getVideo(cue.videoId);
  const sorted = video.cues.slice().sort((a, b) => a.startTime - b.startTime);
  const idx = sorted.findIndex(c => c.id === cue.id);
  if (idx === -1 || idx === sorted.length - 1) { setStatus("NO HAY UN CUE SIGUIENTE PARA UNIR", false); return; }
  const next = sorted[idx + 1];

  cue.startTime = Math.min(cue.startTime, next.startTime);
  cue.endTime = Math.max(cue.endTime, next.endTime);

  pads.forEach(pad => { if (pad.cueId === next.id) pad.cueId = cue.id; });
  video.cues = video.cues.filter(c => c.id !== next.id);

  state.selectedCueId = cue.id;
  renderTimeline();
  renderCueProperties();
  renderPlaylist();
  renderPadGrid();
}

function divideVideoIntoSegments(n) {
  const video = getSelectedVideo();
  if (!video) { setStatus("SELECCIONÁ UN VIDEO PRIMERO", false); return; }
  if (!video.duration || video.duration <= 0) { setStatus("DURACIÓN DESCONOCIDA TODAVÍA", false); return; }

  const ok = window.confirm(`Esto reemplaza los ${video.cues.length} cue(s) actuales de "${video.name}" por ${n} segmentos iguales. ¿Continuar?`);
  if (!ok) return;

  const oldCueIds = new Set(video.cues.map(c => c.id));
  const segDur = video.duration / n;
  const newCues = [];
  for (let i = 0; i < n; i++) {
    const start = i * segDur;
    const end = i === n - 1 ? video.duration : (i + 1) * segDur;
    newCues.push(createCue(video.id, { name: `Seg ${i + 1}`, startTime: start, endTime: end }));
  }
  video.cues = newCues;

  pads.forEach(pad => {
    if (pad.cueId && oldCueIds.has(pad.cueId)) {
      if (pad.playing) stopPad(pad.id);
      destroyPadEngine(pad);
      pad.cueId = null;
    }
  });

  state.selectedCueId = newCues[0] ? newCues[0].id : null;
  renderTimeline();
  renderCueProperties();
  renderPlaylist();
  renderPadGrid();
  setStatus(`VIDEO DIVIDIDO EN ${n}`, false);
}

function previewSelectedCue() {
  const cue = getCue(state.selectedCueId);
  if (!cue) return;
  const video = getVideo(cue.videoId);
  if (!video) return;

  if (video.sourceType === "local" && video.editorEl) {
    video.editorEl.currentTime = cue.startTime;
    state.editorPreviewWatch = { videoId: video.id, endTime: cue.endTime };
    video.editorEl.play().catch(() => {});
  } else if (video.sourceType === "youtube" && video.editorYtPlayer) {
    try {
      video.editorYtPlayer.seekTo(cue.startTime, true);
      video.editorYtPlayer.playVideo();
      state.editorPreviewWatch = { videoId: video.id, endTime: cue.endTime };
    } catch (e) {}
  }
}

function goToCueStart() {
  const cue = getCue(state.selectedCueId);
  if (cue) seekEditor(cue.startTime);
}
function goToCueEnd() {
  const cue = getCue(state.selectedCueId);
  if (cue) seekEditor(cue.endTime);
}

/* ============================================================
   PANEL DE PROPIEDADES DEL CUE
   ============================================================ */

function bindCuePropsControls() {
  if (dom.cueNameInput) dom.cueNameInput.addEventListener("change", e => {
    const cue = getCue(state.selectedCueId);
    if (!cue) return;
    cue.name = e.target.value || cue.name;
    renderTimeline();
    renderPlaylist();
  });

  if (dom.cueStartInput) dom.cueStartInput.addEventListener("change", e => applyCueTimeInput("start", e.target.value));
  if (dom.cueEndInput) dom.cueEndInput.addEventListener("change", e => applyCueTimeInput("end", e.target.value));
  if (dom.cueDurationInput) dom.cueDurationInput.addEventListener("change", e => applyCueTimeInput("duration", e.target.value));

  if (dom.cueNewButton) dom.cueNewButton.addEventListener("click", addNewCue);
  if (dom.cueDeleteButton) dom.cueDeleteButton.addEventListener("click", () => { if (state.selectedCueId) deleteCue(state.selectedCueId); });
  if (dom.cueDuplicateButton) dom.cueDuplicateButton.addEventListener("click", () => { if (state.selectedCueId) duplicateCue(state.selectedCueId); });
  if (dom.cueSplitButton) dom.cueSplitButton.addEventListener("click", splitSelectedCueAtPlayhead);
  if (dom.cueMergeButton) dom.cueMergeButton.addEventListener("click", mergeSelectedCueWithNext);
  if (dom.cueDivide2) dom.cueDivide2.addEventListener("click", () => divideVideoIntoSegments(2));
  if (dom.cueDivide4) dom.cueDivide4.addEventListener("click", () => divideVideoIntoSegments(4));
  if (dom.cueDivide8) dom.cueDivide8.addEventListener("click", () => divideVideoIntoSegments(8));
  if (dom.cuePreviewButton) dom.cuePreviewButton.addEventListener("click", previewSelectedCue);
  if (dom.cueGoStartButton) dom.cueGoStartButton.addEventListener("click", goToCueStart);
  if (dom.cueGoEndButton) dom.cueGoEndButton.addEventListener("click", goToCueEnd);
}

function applyCueTimeInput(field, rawValue) {
  const cue = getCue(state.selectedCueId);
  if (!cue) return;
  const video = getVideo(cue.videoId);
  const val = parseTimecode(rawValue);

  if (field === "start") {
    cue.startTime = clamp(val, 0, cue.endTime - CONFIG.MIN_CUE_DURATION);
  } else if (field === "end") {
    cue.endTime = clamp(val, cue.startTime + CONFIG.MIN_CUE_DURATION, video.duration);
  } else if (field === "duration") {
    const newDur = Math.max(CONFIG.MIN_CUE_DURATION, val);
    cue.endTime = clamp(cue.startTime + newDur, cue.startTime + CONFIG.MIN_CUE_DURATION, video.duration);
  }

  renderTimeline();
  renderCueProperties();
  renderPlaylist();
}

function updateCuePropsInputsOnly(cue) {
  if (dom.cueStartInput) dom.cueStartInput.value = formatTimecode(cue.startTime);
  if (dom.cueEndInput) dom.cueEndInput.value = formatTimecode(cue.endTime);
  if (dom.cueDurationInput) dom.cueDurationInput.value = formatTimecode(cueDuration(cue));
}

function renderCueProperties() {
  const cue = getCue(state.selectedCueId);

  if (!cue) {
    if (dom.cuePropsEmpty) dom.cuePropsEmpty.style.display = "block";
    if (dom.cuePropsForm) dom.cuePropsForm.style.display = "none";
    return;
  }

  if (dom.cuePropsEmpty) dom.cuePropsEmpty.style.display = "none";
  if (dom.cuePropsForm) dom.cuePropsForm.style.display = "flex";

  if (dom.cueNameInput) dom.cueNameInput.value = cue.name;
  updateCuePropsInputsOnly(cue);

  if (dom.cuePadAssignGrid) {
    dom.cuePadAssignGrid.innerHTML = "";
    pads.forEach(pad => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pad-assign-btn";
      const isThisCue = pad.cueId === cue.id;
      const isOccupiedByOther = pad.cueId && !isThisCue;
      if (isThisCue) btn.classList.add("assigned");
      else if (isOccupiedByOther) btn.classList.add("occupied");
      btn.textContent = String(pad.id);
      btn.title = isThisCue ? "Este cue ya está asignado a este pad (click para desasignar)"
        : isOccupiedByOther ? `Pad ${pad.id} tiene otro cue asignado (click para reasignar)`
        : `Asignar a Pad ${pad.id}`;
      btn.addEventListener("click", () => {
        if (isThisCue) unassignPad(pad.id);
        else assignCueToPad(cue.id, pad.id);
      });
      dom.cuePadAssignGrid.appendChild(btn);
    });
  }
}

/* ============================================================
   ASIGNACIÓN PAD ↔ CUE
   ============================================================ */

function assignCueToPad(cueId, padId) {
  const pad = getPad(padId);
  if (!pad) return;
  if (pad.playing) stopPad(padId);
  destroyPadEngine(pad);
  pad.cueId = cueId;

  renderPadGrid();
  renderPadDetail();
  renderCueProperties();
  renderTimeline();
  setStatus(`CUE ASIGNADO A PAD ${padId}`, false);
}

function unassignPad(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  if (pad.playing) stopPad(padId);
  destroyPadEngine(pad);
  pad.cueId = null;

  renderPadGrid();
  renderPadDetail();
  renderCueProperties();
  renderTimeline();
}

/* ============================================================
   VISUALIZADOR: controles de modo
   ============================================================ */

function bindVisualizerControls() {
  if (!dom.visualizerModeButtons) return;
  dom.visualizerModeButtons.querySelectorAll("[data-vis-mode]").forEach(btn => {
    btn.addEventListener("click", () => setVisualizerMode(btn.dataset.visMode));
  });
}

function renderVisualizerModeButtons() {
  if (!dom.visualizerModeButtons) return;
  dom.visualizerModeButtons.querySelectorAll("[data-vis-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.visMode === state.visualizerMode);
  });
}

/* ============================================================
   16 PADS — GRILLA COMPACTA (PERFORMANCE)
   ============================================================ */

const padTileRefs = new Map();

function renderPadGrid() {
  if (!dom.padsGrid) return;
  dom.padsGrid.innerHTML = "";
  padTileRefs.clear();

  pads.forEach(pad => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "pad-tile";
    tile.dataset.pad = pad.id;

    const top = document.createElement("div");
    top.className = "pad-tile-top";
    const num = document.createElement("span");
    num.className = "pad-tile-num";
    num.textContent = pad.id;
    const key = document.createElement("span");
    key.className = "pad-tile-key";
    key.textContent = pad.key.toUpperCase();
    top.append(num, key);

    const label = document.createElement("div");
    label.className = "pad-tile-label";
    label.textContent = getPadCueLabel(pad);

    const meter = document.createElement("div");
    meter.className = "pad-tile-meter";
    const meterFill = document.createElement("div");
    meterFill.className = "pad-tile-meter-fill";
    meter.appendChild(meterFill);

    const dots = document.createElement("div");
    dots.className = "pad-tile-dots";
    const muteDot = document.createElement("span");
    muteDot.className = "dot dot-mute";
    const soloDot = document.createElement("span");
    soloDot.className = "dot dot-solo";
    const modeDot = document.createElement("span");
    modeDot.className = "dot dot-mode";
    dots.append(muteDot, soloDot, modeDot);

    tile.append(top, label, meter, dots);

    tile.addEventListener("click", () => selectPad(pad.id));
    tile.addEventListener("pointerdown", event => {
      const p = getPad(pad.id);
      if (p.playMode === "gate") {
        event.preventDefault();
        try { tile.setPointerCapture(event.pointerId); } catch (e) {}
        handlePadPress(pad.id);
      }
    });
    tile.addEventListener("pointerup", () => handlePadRelease(pad.id));
    tile.addEventListener("pointercancel", () => handlePadRelease(pad.id));
    tile.addEventListener("dblclick", event => {
      // doble click = disparo rápido en modo trigger sin necesitar seleccionar antes
      event.stopPropagation();
      const p = getPad(pad.id);
      if (p.playMode !== "gate") handlePadPress(pad.id);
    });

    dom.padsGrid.appendChild(tile);
    padTileRefs.set(pad.id, { tile, label, meterFill, muteDot, soloDot, modeDot });
  });

  pads.forEach(pad => updatePadTileState(pad.id));
}

function getPadCueLabel(pad) {
  if (!pad.cueId) return "— SIN CUE —";
  const cue = getCue(pad.cueId);
  if (!cue) return "— CUE INVÁLIDO —";
  const video = getVideo(cue.videoId);
  return `${cue.name}${video ? " · " + video.name : ""}`;
}

function updatePadTileState(padId) {
  const pad = getPad(padId);
  const refs = padTileRefs.get(padId);
  if (!pad || !refs) return;

  refs.tile.classList.toggle("selected", padId === state.selectedPadId);
  refs.tile.classList.toggle("playing", pad.playing);
  refs.tile.classList.toggle("empty", !pad.cueId);

  refs.label.textContent = getPadCueLabel(pad);
  refs.muteDot.classList.toggle("active", pad.muted);
  refs.soloDot.classList.toggle("active", pad.solo);
  refs.modeDot.classList.toggle("active", pad.playMode === "gate");

  if (!pad.playing) refs.meterFill.style.width = "0%";
}

function updatePadMeterUI(padId, progress) {
  const refs = padTileRefs.get(padId);
  if (refs) refs.meterFill.style.width = `${progress}%`;
}

function selectPad(padId) {
  state.selectedPadId = padId;
  pads.forEach(p => updatePadTileState(p.id));
  renderPadDetail();
}

/* ============================================================
   PANEL DE DETALLE DEL PAD SELECCIONADO
   ============================================================ */

function bindPadDetailControls() {
  if (dom.padModeButton) dom.padModeButton.addEventListener("click", () => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    if (pad.playing) stopPad(pad.id);
    pad.playMode = pad.playMode === "gate" ? "trigger" : "gate";
    renderPadDetail();
    updatePadTileState(pad.id);
  });

  if (dom.padLoopButton) dom.padLoopButton.addEventListener("click", () => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.loop = !pad.loop;
    renderPadDetail();
  });

  if (dom.padMuteButton) dom.padMuteButton.addEventListener("click", () => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.muted = !pad.muted;
    updateAllPadGains();
    renderPadDetail();
    updatePadTileState(pad.id);
  });

  if (dom.padSoloButton) dom.padSoloButton.addEventListener("click", () => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.solo = !pad.solo;
    updateAllPadGains();
    renderPadDetail();
    updatePadTileState(pad.id);
  });

  if (dom.padSyncButton) dom.padSyncButton.addEventListener("click", () => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.sync = !pad.sync;
    renderPadDetail();
  });

  if (dom.padVolumeInput) dom.padVolumeInput.addEventListener("input", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.volume = Number(e.target.value);
    if (dom.padVolumeOutput) dom.padVolumeOutput.textContent = pad.volume.toFixed(2);
    updateAllPadGains();
  });

  if (dom.padHPInput) dom.padHPInput.addEventListener("input", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.highPass = sliderToFreq(e.target.value, CONFIG.HPF_MIN, CONFIG.HPF_MAX);
    if (pad.highpassNode) pad.highpassNode.frequency.value = pad.highPass;
    if (dom.padHPOutput) dom.padHPOutput.textContent = formatFreq(pad.highPass);
  });

  if (dom.padLPInput) dom.padLPInput.addEventListener("input", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.lowPass = sliderToFreq(e.target.value, CONFIG.LPF_MIN, CONFIG.LPF_MAX);
    if (pad.lowpassNode) pad.lowpassNode.frequency.value = pad.lowPass;
    if (dom.padLPOutput) dom.padLPOutput.textContent = formatFreq(pad.lowPass);
  });

  if (dom.padRateInput) dom.padRateInput.addEventListener("input", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.playbackRate = clamp(Number(e.target.value), CONFIG.MIN_PLAYBACK_RATE, CONFIG.MAX_PLAYBACK_RATE);
    if (dom.padRateOutput) dom.padRateOutput.textContent = `${pad.playbackRate.toFixed(2)}x`;
    applyLiveRate(pad);
  });

  if (dom.padBpmInput) dom.padBpmInput.addEventListener("change", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    const bpm = Number(e.target.value);
    if (Number.isFinite(bpm) && bpm > 0) pad.bpm = clamp(bpm, 20, 400);
    applyLiveRate(pad);
  });

  if (dom.padVisualSelect) dom.padVisualSelect.addEventListener("change", e => {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    pad.visualMode = e.target.value;
    if (pad.visualMode === "hidden") unregisterVisualSource(pad.id);
    else if (pad.playing) registerVisualActivation(pad);
  });

  if (dom.padUnassignButton) dom.padUnassignButton.addEventListener("click", () => {
    if (state.selectedPadId) unassignPad(state.selectedPadId);
  });
}

function applyLiveRate(pad) {
  if (!pad.playing || !pad.engine) return;
  if (pad.engine.kind === "local" && pad.engine.videoEl) {
    pad.engine.videoEl.playbackRate = getPadEffectiveRate(pad);
  } else if (pad.engine.kind === "youtube" && pad.engine.ytPlayer) {
    try { pad.engine.ytPlayer.setPlaybackRate(snapToAllowedYouTubeRate(getPadEffectiveRate(pad))); } catch (e) {}
  }
}

function renderPadDetail() {
  const pad = getPad(state.selectedPadId);
  if (!pad) {
    if (dom.padDetailEmpty) dom.padDetailEmpty.style.display = "block";
    if (dom.padDetailForm) dom.padDetailForm.style.display = "none";
    return;
  }

  if (dom.padDetailEmpty) dom.padDetailEmpty.style.display = "none";
  if (dom.padDetailForm) dom.padDetailForm.style.display = "flex";

  if (dom.padDetailTitle) dom.padDetailTitle.textContent = `PAD ${pad.id} (${pad.key.toUpperCase()})`;
  if (dom.padCueLabel) dom.padCueLabel.textContent = getPadCueLabel(pad);

  if (dom.padModeButton) {
    dom.padModeButton.textContent = pad.playMode === "gate" ? "GATE" : "TRIGGER";
    dom.padModeButton.classList.toggle("active", pad.playMode === "gate");
  }
  if (dom.padLoopButton) dom.padLoopButton.classList.toggle("active", pad.loop);
  if (dom.padMuteButton) dom.padMuteButton.classList.toggle("active", pad.muted);
  if (dom.padSoloButton) dom.padSoloButton.classList.toggle("active", pad.solo);
  if (dom.padSyncButton) dom.padSyncButton.classList.toggle("active", pad.sync);

  if (dom.padVolumeInput) dom.padVolumeInput.value = pad.volume;
  if (dom.padVolumeOutput) dom.padVolumeOutput.textContent = pad.volume.toFixed(2);

  if (dom.padHPInput) dom.padHPInput.value = freqToSlider(pad.highPass, CONFIG.HPF_MIN, CONFIG.HPF_MAX);
  if (dom.padHPOutput) dom.padHPOutput.textContent = formatFreq(pad.highPass);

  if (dom.padLPInput) dom.padLPInput.value = freqToSlider(pad.lowPass, CONFIG.LPF_MIN, CONFIG.LPF_MAX);
  if (dom.padLPOutput) dom.padLPOutput.textContent = formatFreq(pad.lowPass);

  if (dom.padRateInput) dom.padRateInput.value = pad.playbackRate;
  if (dom.padRateOutput) dom.padRateOutput.textContent = `${pad.playbackRate.toFixed(2)}x`;

  if (dom.padBpmInput) dom.padBpmInput.value = pad.bpm;
  if (dom.padVisualSelect) dom.padVisualSelect.value = pad.visualMode;
}

/* ============================================================
   TECLADO
   ============================================================ */

function bindKeyboard() {
  window.addEventListener("keydown", event => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const key = event.key.toLowerCase();
    const padIndex = CONFIG.KEY_MAP.indexOf(key);
    if (padIndex === -1 || event.repeat) return;
    handlePadPress(padIndex + 1);
  });

  window.addEventListener("keyup", event => {
    const key = event.key.toLowerCase();
    const padIndex = CONFIG.KEY_MAP.indexOf(key);
    if (padIndex === -1) return;
    handlePadRelease(padIndex + 1);
  });

  window.addEventListener("blur", () => {
    pads.forEach(pad => {
      if (pad.playMode === "gate" && pad.playing) stopPad(pad.id);
    });
  });
}

/* ============================================================
   MIDI
   ============================================================ */

function initializeMIDI() {
  if (!navigator.requestMIDIAccess) {
    if (dom.midiStatus) dom.midiStatus.textContent = "NO SOPORTADO";
    return;
  }
  navigator.requestMIDIAccess()
    .then(midiAccess => {
      const inputs = Array.from(midiAccess.inputs.values());
      if (dom.midiInputSelect) {
        dom.midiInputSelect.innerHTML = '<option value="">SELECCIONAR MIDI</option>';
        inputs.forEach(input => {
          const opt = document.createElement("option");
          opt.value = input.id;
          opt.textContent = input.name || `Dispositivo ${input.id}`;
          dom.midiInputSelect.appendChild(opt);
        });
        const stillConnected = inputs.some(i => i.id === state.midiInputId);
        dom.midiInputSelect.value = stillConnected ? state.midiInputId : "";
      }
      // Solo el input elegido queda escuchando (nunca múltiples a la vez).
      midiAccess.inputs.forEach(input => {
        input.onmidimessage = input.id === state.midiInputId ? handleMIDIMessage : null;
      });
      if (dom.midiStatus) {
        const connected = inputs.some(i => i.id === state.midiInputId);
        dom.midiStatus.textContent = state.midiInputId ? (connected ? "CONECTADO" : "DESCONECTADO") : "DESCONECTADO";
      }
      midiAccess.onstatechange = () => initializeMIDI();
    })
    .catch(() => { if (dom.midiStatus) dom.midiStatus.textContent = "ERROR ACCESO"; });
}

function selectMIDIInput(inputId) {
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess().then(midiAccess => {
    midiAccess.inputs.forEach(input => {
      input.onmidimessage = input.id === inputId ? handleMIDIMessage : null;
    });
    state.midiInputId = inputId;
    if (dom.midiStatus) dom.midiStatus.textContent = inputId ? "CONECTADO" : "DESCONECTADO";
  });
}

function handleMIDIMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status >> 4;
  const isNoteOn = command === 9 && velocity > 0;
  const isNoteOff = command === 8 || (command === 9 && velocity === 0);
  const padIndex = note - CONFIG.MIDI_BASE_NOTE;
  const padId = padIndex + 1;
  const validPad = padIndex >= 0 && padIndex < CONFIG.PAD_COUNT;

  if (isNoteOn && validPad) handlePadPress(padId);
  else if (isNoteOff && validPad) handlePadRelease(padId);

  if (command === 11) {
    const pad = getPad(state.selectedPadId);
    if (!pad) return;
    if (note === 112) {
      pad.highPass = (velocity / 127) * CONFIG.HPF_MAX;
      if (pad.highpassNode) pad.highpassNode.frequency.value = pad.highPass;
      renderPadDetail();
    } else if (note === 113) {
      pad.lowPass = (velocity / 127) * (CONFIG.LPF_MAX - CONFIG.LPF_MIN) + CONFIG.LPF_MIN;
      if (pad.lowpassNode) pad.lowpassNode.frequency.value = pad.lowPass;
      renderPadDetail();
    } else if (note === 7) {
      pad.volume = velocity / 127;
      updateAllPadGains();
      renderPadDetail();
    }
  }
}

/* ============================================================
   GRABACIÓN
   ============================================================ */

async function toggleRecording() {
  if (state.isRecording) stopRecording();
  else await startRecording();
}

async function startRecording() {
  await resumeAudio();
  if (!dom.outputCanvas || typeof dom.outputCanvas.captureStream !== "function") {
    setStatus("REC UNSUPPORTED", false);
    return;
  }

  try {
    const canvasStream = dom.outputCanvas.captureStream(30);
    recordingDestination = audioCtx.createMediaStreamDestination();
    masterGainNode.connect(recordingDestination);

    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...recordingDestination.stream.getAudioTracks()
    ]);

    const mimeTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || "";
    if (!mimeType) {
      setStatus("REC UNSUPPORTED", false);
      masterGainNode.disconnect(recordingDestination);
      recordingDestination = null;
      return;
    }

    state.recordingChunks = [];
    state.recorder = new MediaRecorder(combinedStream, { mimeType });
    state.recorder.ondataavailable = e => { if (e.data.size > 0) state.recordingChunks.push(e.data); };
    state.recorder.onstop = exportRecording;
    state.recorder.onerror = e => {
      console.error("Error de MediaRecorder:", e.error);
      setStatus("REC ERROR", false);
      stopRecording();
    };

    state.recorder.start();
    state.isRecording = true;
    state.recordingStartedAt = Date.now();
    if (dom.recordButton) dom.recordButton.classList.add("recording");
    setStatus("GRABANDO... (audio de YouTube no incluido)", true);

    state.recordingTimerHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      if (dom.recordingTimer) dom.recordingTimer.textContent = `${m}:${s}`;
    }, 1000);
  } catch (error) {
    console.error("Error al iniciar grabación:", error);
    setStatus("REC ERROR", false);
    if (recordingDestination) { try { masterGainNode.disconnect(recordingDestination); } catch (e) {} recordingDestination = null; }
  }
}

function stopRecording() {
  if (!state.recorder || !state.isRecording) return;
  try { state.recorder.stop(); } catch (e) {}
  state.isRecording = false;
  clearInterval(state.recordingTimerHandle);
  state.recordingTimerHandle = null;
  if (dom.recordButton) dom.recordButton.classList.remove("recording");
  if (dom.recordingTimer) dom.recordingTimer.textContent = "00:00";
  if (recordingDestination) { try { masterGainNode.disconnect(recordingDestination); } catch (e) {} recordingDestination = null; }
  setStatus("GRABACIÓN FINALIZADA", false);
}

function exportRecording() {
  const blob = new Blob(state.recordingChunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = `av-chopper-rec-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

/* ============================================================
   PROYECTO: EXPORT / IMPORT / MIGRACIÓN v2 → v3
   ============================================================ */

function buildV3ProjectObject() {
  return {
    version: 3,
    timestamp: Date.now(),
    globalBpm: state.globalBpm,
    masterVolume: state.masterVolume,
    videos: videos.map(v => ({
      id: v.id,
      name: v.name,
      sourceType: v.sourceType,
      fileName: v.fileName || "",
      youtubeId: v.youtubeId || "",
      duration: v.duration,
      cues: v.cues.map(c => ({ id: c.id, name: c.name, startTime: c.startTime, endTime: c.endTime }))
    })),
    pads: pads.map(p => ({
      id: p.id,
      key: p.key,
      cueId: p.cueId,
      playMode: p.playMode,
      loop: p.loop,
      volume: p.volume,
      muted: p.muted,
      solo: p.solo,
      highPass: p.highPass,
      lowPass: p.lowPass,
      playbackRate: p.playbackRate,
      visualMode: p.visualMode,
      bpm: p.bpm,
      sync: p.sync
    })),
    visualizer: { mode: state.visualizerMode, maxSources: CONFIG.SPLIT_MAX_SOURCES[state.visualizerMode] || 1 }
  };
}

function exportProject() {
  const data = buildV3ProjectObject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `av-chopper-project-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleProjectFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      detectAndLoadProject(data);
    } catch (err) {
      setStatus("JSON DE PROYECTO INVÁLIDO", false);
    }
  };
  reader.readAsText(file);
}

function detectAndLoadProject(data) {
  if (data && Array.isArray(data.videos)) {
    loadProjectData(data);
  } else if (data && Array.isArray(data.pads) && data.pads[0] && "trimStart" in data.pads[0]) {
    const migrated = migrateV2Project(data);
    loadProjectData(migrated);
    setStatus("PROYECTO v2 MIGRADO A v3", false);
  } else {
    setStatus("FORMATO DE PROYECTO NO RECONOCIDO", false);
  }
}

function migrateV2Project(data) {
  const v3 = {
    version: 3,
    globalBpm: data.globalBpm || CONFIG.DEFAULT_BPM,
    masterVolume: data.masterVolume !== undefined ? data.masterVolume : CONFIG.DEFAULT_MASTER_VOLUME,
    videos: [],
    pads: [],
    visualizer: { mode: "simple", maxSources: 1 }
  };

  (data.pads || []).forEach((p, i) => {
    if (i > 7) return; // v2 tenía 8 pads (índices 0-7)
    const hasSource = (p.sourceType === "local" && p.fileName && p.fileName !== "Vacío") ||
                       (p.sourceType === "youtube" && p.youtubeId);
    if (!hasSource) return;

    // v2 usaba teclas q w e r a s d f -> en v3 esas mismas teclas son los pads 5-12.
    const newPadId = i + 5;

    const trimStart = p.trimStart || 0;
    const dur = p.duration || 1;
    const videoDuration = Math.max(trimStart + dur, dur, 1);

    const video = {
      id: generateId("video"),
      name: p.sourceType === "youtube" ? `YT ${p.youtubeId}` : (p.fileName || `Video pad ${i + 1}`),
      sourceType: p.sourceType === "youtube" ? "youtube" : "local",
      fileName: p.fileName || "",
      youtubeId: p.youtubeId || "",
      duration: videoDuration,
      cues: []
    };
    const cueId = generateId("cue");
    video.cues.push({ id: cueId, name: "Migrado", startTime: trimStart, endTime: trimStart + dur });
    v3.videos.push(video);

    v3.pads.push({
      id: newPadId,
      cueId,
      playMode: p.triggerMode === "gate" ? "gate" : "trigger",
      loop: p.loop !== undefined ? p.loop : true,
      volume: p.volume !== undefined ? p.volume : 1,
      muted: !!p.muted,
      solo: !!p.solo,
      highPass: p.highpass || CONFIG.HPF_MIN,
      lowPass: p.lowpass || CONFIG.LPF_MAX,
      playbackRate: p.playbackRate || 1,
      visualMode: "auto",
      bpm: p.bpm || CONFIG.DEFAULT_BPM,
      sync: !!p.sync
    });
  });

  return v3;
}

function destroyAllEngines() {
  pads.forEach(destroyPadEngine);
  videos.forEach(destroyVideoEditorEngine);
}

function loadProjectData(data) {
  stopAllPads();
  destroyAllEngines();

  videos.length = 0;
  pads.length = 0;

  if (data.globalBpm) state.globalBpm = data.globalBpm;
  if (data.masterVolume !== undefined) {
    state.masterVolume = data.masterVolume;
    if (dom.masterVolume) dom.masterVolume.value = data.masterVolume;
    if (masterGainNode) masterGainNode.gain.value = data.masterVolume;
  }

  (data.videos || []).forEach(vData => {
    const video = createVideo({
      name: vData.name || "Video",
      sourceType: vData.sourceType === "youtube" ? "youtube" : "local",
      sourceUrl: null,
      fileName: vData.fileName || "",
      duration: vData.duration || 0,
      youtubeId: vData.youtubeId || ""
    });
    video.id = vData.id || video.id;
    video.linked = video.sourceType === "youtube";
    video.cues = (vData.cues || []).map(cData => ({
      id: cData.id || generateId("cue"),
      videoId: video.id,
      name: cData.name || "Cue",
      startTime: cData.startTime || 0,
      endTime: cData.endTime || 0
    }));
    videos.push(video);
    if (video.sourceType === "youtube" && video.youtubeId) ensureVideoEditorEngine(video);
  });

  for (let i = 0; i < CONFIG.PAD_COUNT; i++) pads.push(createPad(i));

  (data.pads || []).forEach(pData => {
    const pad = pads.find(p => p.id === pData.id);
    if (!pad) return;
    pad.cueId = pData.cueId || null;
    pad.playMode = pData.playMode === "gate" ? "gate" : "trigger";
    pad.loop = !!pData.loop;
    pad.volume = pData.volume !== undefined ? clamp(Number(pData.volume), 0, 1) : 1;
    pad.muted = !!pData.muted;
    pad.solo = !!pData.solo;
    pad.highPass = clamp(pData.highPass !== undefined ? pData.highPass : CONFIG.HPF_MIN, CONFIG.HPF_MIN, CONFIG.HPF_MAX);
    pad.lowPass = clamp(pData.lowPass !== undefined ? pData.lowPass : CONFIG.LPF_MAX, CONFIG.LPF_MIN, CONFIG.LPF_MAX);
    pad.playbackRate = clamp(pData.playbackRate || 1, CONFIG.MIN_PLAYBACK_RATE, CONFIG.MAX_PLAYBACK_RATE);
    pad.visualMode = ["auto", "visible", "hidden"].includes(pData.visualMode) ? pData.visualMode : "auto";
    pad.bpm = pData.bpm || CONFIG.DEFAULT_BPM;
    pad.sync = !!pData.sync;
  });

  if (data.visualizer && data.visualizer.mode) state.visualizerMode = data.visualizer.mode;
  state.visualActiveSources = [];
  state.selectedVideoId = videos[0] ? videos[0].id : null;
  state.selectedCueId = null;
  state.selectedPadId = 1;
  state.playheadTime = 0;

  updateAllPadGains();
  renderAll();
  setStatus("PROYECTO CARGADO", false);
}

function clearProject() {
  stopAllPads();
  destroyAllEngines();
  videos.forEach(v => { if (v.sourceUrl) URL.revokeObjectURL(v.sourceUrl); });

  videos.length = 0;
  pads.length = 0;
  for (let i = 0; i < CONFIG.PAD_COUNT; i++) pads.push(createPad(i));

  state.selectedVideoId = null;
  state.selectedCueId = null;
  state.selectedPadId = 1;
  state.playheadTime = 0;
  state.visualActiveSources = [];
  state.visualizerMode = "simple";

  renderAll();
  setStatus("PROYECTO REINICIADO", false);
}
