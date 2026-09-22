/* ============================================================
   AV SAMPLER & CHOPPER
   Version 2.0 (Full Architecture Refactor)
   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONFIG = {
  PAD_COUNT: 8,
  DEFAULT_BPM: 120,
  DEFAULT_MASTER_VOLUME: 0.8,
  DEFAULT_PAD_DURATION: 2,
  DEFAULT_MAX_DURATION: 60,
  DEFAULT_PLAYBACK_RATE: 1,
  MIN_PLAYBACK_RATE: 0.25,
  MAX_PLAYBACK_RATE: 4,
  MIN_LOOP_DURATION: 0.05,
  MAX_LOOP_DURATION: 60,
  KEY_MAP: ["q", "w", "e", "r", "a", "s", "d", "f"],
  MIDI_NOTES: [36, 37, 38, 39, 40, 41, 42, 43]
};

/* ============================================================
   AUDIO CONTEXT & GLOBALS
   ============================================================ */

let audioCtx = null;
let masterGainNode = null;
let recordingDestination = null;

/* ============================================================
   APP STATE
   ============================================================ */

const state = {
  selectedPad: 0,
  visualPad: 0,
  globalBpm: CONFIG.DEFAULT_BPM,
  masterVolume: CONFIG.DEFAULT_MASTER_VOLUME,
  midiInputId: "",
  audioOutputId: "",
  isRecording: false,
  recordingStartedAt: 0,
  recordingTimer: null,
  recorder: null,
  recordingChunks: [],
  activeProjectName: "Proyecto nuevo"
};

/* ============================================================
   PAD FACTORY & DATA
   ============================================================ */

function createPad(index) {
  return {
    id: index,
    key: CONFIG.KEY_MAP[index],
    midiNote: CONFIG.MIDI_NOTES[index],
    sourceType: "local",
    file: null,
    fileUrl: null,
    fileName: "Vacío",
    video: null,
    youtubeId: "",
    youtubePlayer: null,
    duration: CONFIG.DEFAULT_PAD_DURATION,
    maxDuration: CONFIG.DEFAULT_MAX_DURATION,
    trimStart: 0,
    playbackRate: CONFIG.DEFAULT_PLAYBACK_RATE,
    loop: true,
    playing: false,
    muted: false,
    solo: false,
    bpm: CONFIG.DEFAULT_BPM,
    sync: false,
    highpass: 20,
    lowpass: 20000,
    audioSource: null,
    highpassNode: null,
    lowpassNode: null,
    gainNode: null,
    meterValue: 0,
    lastPlayedAt: 0
  };
}

const pads = Array.from({ length: CONFIG.PAD_COUNT }, (_, index) => createPad(index));

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const dom = {
  padsGrid: document.getElementById("padsGrid"),
  canvas: document.getElementById("outputCanvas"),
  canvasContainer: document.getElementById("canvasContainer"),
  canvasOverlayTag: document.getElementById("canvasOverlayTag"),
  videoBank: document.getElementById("videoBank"),
  ytPlayersContainer: document.getElementById("ytPlayersContainer"),
  masterVolume: document.getElementById("masterVolume"),
  globalBpmValue: document.getElementById("globalBpmValue"),
  globalTapButton: document.getElementById("globalTapButton"),
  statusBadge: document.getElementById("statusBadge"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  audioStartButton: document.getElementById("audioStartButton"),
  loadProjectButton: document.getElementById("loadProjectButton"),
  saveProjectButton: document.getElementById("saveProjectButton"),
  recordButton: document.getElementById("recordButton"),
  mediaFileInput: document.getElementById("mediaFileInput"),
  projectFileInput: document.getElementById("projectFileInput"),
  selectedPadInfo: document.getElementById("selectedPadInfo"),
  visualMasterButton: document.getElementById("visualMasterButton"),
  midiInputSelect: document.getElementById("midiInputSelect"),
  midiStatus: document.getElementById("midiStatus"),
  audioOutputSelect: document.getElementById("audioOutputSelect"),
  audioOutputRefresh: document.getElementById("audioOutputRefresh"),
  projectInfo: document.getElementById("projectInfo"),
  clearProjectButton: document.getElementById("clearProjectButton"),
  recordingStatus: document.getElementById("recordingStatus"),
  recordingTimer: document.getElementById("recordingTimer")
};

/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener("DOMContentLoaded", initialize);

function initialize() {
  initializeAudio();
  renderPads();
  updateSelectedPadUI();
  updateGlobalBpmUI();
  bindGlobalControls();
  bindKeyboard();
  initializeMIDI();
  refreshAudioOutputs();
  drawStandby();
  requestAnimationFrame(renderCanvas);
  setStatus("READY", false);
}

/* ============================================================
   AUDIO INITIALIZATION
   ============================================================ */

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
   GLOBAL CONTROLS
   ============================================================ */

function bindGlobalControls() {
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
      if (masterGainNode) {
        masterGainNode.gain.setTargetAtTime(state.masterVolume, audioCtx.currentTime, 0.01);
      }
    });
  }

  if (dom.globalTapButton) dom.globalTapButton.addEventListener("click", handleGlobalTap);
  if (dom.saveProjectButton) dom.saveProjectButton.addEventListener("click", exportProject);
  if (dom.loadProjectButton) dom.loadProjectButton.addEventListener("click", () => dom.projectFileInput.click());
  if (dom.projectFileInput) dom.projectFileInput.addEventListener("change", handleProjectFile);
  if (dom.clearProjectButton) dom.clearProjectButton.addEventListener("click", clearProject);
  if (dom.recordButton) dom.recordButton.addEventListener("click", toggleRecording);
  if (dom.mediaFileInput) dom.mediaFileInput.addEventListener("change", handleMediaFile);

  if (dom.visualMasterButton) {
    dom.visualMasterButton.addEventListener("click", () => {
      setVisualPad(state.selectedPad);
    });
  }

  if (dom.audioOutputRefresh) dom.audioOutputRefresh.addEventListener("click", refreshAudioOutputs);
  if (dom.audioOutputSelect) dom.audioOutputSelect.addEventListener("change", handleAudioOutputChange);

  if (dom.midiInputSelect) {
    dom.midiInputSelect.addEventListener("change", event => {
      selectMIDIInput(event.target.value);
    });
  }
}

/* ============================================================
   PAD RENDERING & UI
   ============================================================ */

function renderPads() {
  if (!dom.padsGrid) return;
  dom.padsGrid.innerHTML = "";

  pads.forEach(pad => {
    const card = createPadCard(pad);
    dom.padsGrid.appendChild(card);
  });
}

function createPadCard(pad) {
  const card = document.createElement("article");
  card.className = "pad-card";
  card.dataset.pad = pad.id;

  if (pad.id === state.selectedPad) card.classList.add("selected");
  if (pad.playing) card.classList.add("playing");

  /* HEADER */
  const header = document.createElement("div");
  header.className = "pad-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "pad-title-group";

  const number = document.createElement("span");
  number.className = "pad-number";
  number.textContent = `PAD ${pad.id + 1}`;

  const key = document.createElement("span");
  key.className = "pad-key-badge";
  key.textContent = pad.key.toUpperCase();

  titleGroup.append(number, key);

  const playButton = document.createElement("button");
  playButton.className = "pad-play-btn";
  playButton.type = "button";
  playButton.textContent = pad.playing ? "STOP" : "PLAY";
  if (pad.playing) playButton.classList.add("active");

  playButton.addEventListener("click", event => {
    event.stopPropagation();
    togglePadPlayback(pad.id);
  });

  header.append(titleGroup, playButton);

  /* SOURCE SELECT */
  const sourceSelect = document.createElement("select");
  sourceSelect.className = "pad-source-select";
  sourceSelect.innerHTML = `
    LOCAL
    YOUTUBE
  `;
  sourceSelect.value = pad.sourceType;

  sourceSelect.addEventListener("click", event => event.stopPropagation());
  sourceSelect.addEventListener("change", event => {
    event.stopPropagation();
    setPadSourceType(pad.id, event.target.value);
  });

  /* YOUTUBE INPUT GROUP */
  const youtubeGroup = document.createElement("div");
  youtubeGroup.className = "yt-input-group";
  youtubeGroup.style.display = pad.sourceType === "youtube" ? "flex" : "none";

  const youtubeInput = document.createElement("input");
  youtubeInput.type = "text";
  youtubeInput.placeholder = "YouTube URL";
  youtubeInput.value = pad.youtubeId ? `https://youtu.be/${pad.youtubeId}` : "";

  const youtubeButton = document.createElement("button");
  youtubeButton.type = "button";
  youtubeButton.textContent = "LOAD";

  youtubeInput.addEventListener("click", event => event.stopPropagation());
  youtubeButton.addEventListener("click", event => {
    event.stopPropagation();
    loadYouTubeFromInput(pad.id, youtubeInput.value);
  });

  youtubeGroup.append(youtubeInput, youtubeButton);

  /* LOCAL LOAD BUTTON */
  const localButton = document.createElement("button");
  localButton.type = "button";
  localButton.className = "btn";
  localButton.textContent = "CARGAR VIDEO";
  localButton.style.width = "100%";
  localButton.style.marginBottom = "6px";
  localButton.style.display = pad.sourceType === "local" ? "block" : "none";

  localButton.addEventListener("click", event => {
    event.stopPropagation();
    state.selectedPad = pad.id;
    updateSelectedPadUI();
    if (dom.mediaFileInput) dom.mediaFileInput.click();
  });

  /* THUMB / INFO */
  const thumb = document.createElement("div");
  thumb.className = "pad-thumb";
  thumb.textContent = pad.fileName;

  /* METER BAR */
  const meter = document.createElement("div");
  meter.className = "pad-meter-bar";

  const meterProgress = document.createElement("div");
  meterProgress.className = "pad-meter-progress";
  meterProgress.style.width = `${pad.meterValue}%`;

  meter.appendChild(meterProgress);

  /* CONTROLS */
  const controls = document.createElement("div");
  controls.className = "pad-controls";

  controls.appendChild(
    createRangeRow("CUE", pad.trimStart, 0, Math.max(pad.maxDuration, 1), 0.01, value => {
      pad.trimStart = Number(value);
      clampPadTrim(pad);
    })
  );

  controls.appendChild(
    createRangeRow("LOOP", pad.duration, CONFIG.MIN_LOOP_DURATION, Math.max(pad.maxDuration, 1), 0.01, value => {
      pad.duration = Number(value);
      clampPadDuration(pad);
    })
  );

  controls.appendChild(
    createRangeRow(
      "RATE",
      pad.playbackRate,
      CONFIG.MIN_PLAYBACK_RATE,
      CONFIG.MAX_PLAYBACK_RATE,
      0.01,
      value => {
        setPadRate(pad.id, Number(value));
      },
      val => `${Number(val).toFixed(2)}x`
    )
  );

  controls.appendChild(
    createNumberRow("BPM", pad.bpm, value => {
      const bpm = Number(value);
      if (!Number.isFinite(bpm) || bpm <= 0) return;
      pad.bpm = Math.min(400, Math.max(20, bpm));
    })
  );

  /* BUTTON ROW */
  const buttonRow = document.createElement("div");
  buttonRow.className = "pad-control-row";

  const muteButton = createSmallButton("MUTE", pad.muted, "btn-mute");
  muteButton.addEventListener("click", event => {
    event.stopPropagation();
    toggleMute(pad.id);
  });

  const soloButton = createSmallButton("SOLO", pad.solo, "btn-solo");
  soloButton.addEventListener("click", event => {
    event.stopPropagation();
    toggleSolo(pad.id);
  });

  const syncButton = createSmallButton("SYNC", pad.sync, "btn-sync");
  syncButton.addEventListener("click", event => {
    event.stopPropagation();
    toggleSync(pad.id);
  });

  const visualButton = createSmallButton("VIDEO", pad.id === state.visualPad, "btn-sync");
  visualButton.addEventListener("click", event => {
    event.stopPropagation();
    setVisualPad(pad.id);
  });

  buttonRow.append(muteButton, soloButton, syncButton, visualButton);
  controls.appendChild(buttonRow);

  card.append(header, sourceSelect, youtubeGroup, localButton, thumb, meter, controls);

  card.addEventListener("click", () => {
    selectPad(pad.id);
  });

  /* DRAG & DROP */
  card.addEventListener("dragover", event => {
    event.preventDefault();
    card.classList.add("drag-highlight");
  });

  card.addEventListener("dragleave", () => {
    card.classList.remove("drag-highlight");
  });

  card.addEventListener("drop", event => {
    event.preventDefault();
    card.classList.remove("drag-highlight");

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      setStatus("INVALID FILE", false);
      return;
    }

    state.selectedPad = pad.id;
    loadLocalFile(pad.id, file);
  });

  return card;
}

/* ============================================================
   UI HELPERS
   ============================================================ */

function createRangeRow(label, value, min, max, step, onInput, formatter = null) {
  const row = document.createElement("div");
  row.className = "pad-control-row";

  const labelElement = document.createElement("span");
  labelElement.textContent = label;

  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "4px";

  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;

  const output = document.createElement("output");
  output.textContent = formatter ? formatter(value) : Number(value).toFixed(2);

  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("input", event => {
    const current = Number(event.target.value);
    output.textContent = formatter ? formatter(current) : current.toFixed(2);
    onInput(current);
  });

  wrapper.append(input, output);
  row.append(labelElement, wrapper);
  return row;
}

function createNumberRow(label, value, onChange) {
  const row = document.createElement("div");
  row.className = "pad-control-row";

  const labelElement = document.createElement("span");
  labelElement.textContent = label;

  const input = document.createElement("input");
  input.type = "number";
  input.className = "num-input-sm";
  input.value = value;
  input.min = "20";
  input.max = "400";
  input.step = "1";

  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("change", event => onChange(event.target.value));

  row.append(labelElement, input);
  return row;
}

function createSmallButton(text, active, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.className = className;
  if (active) button.classList.add("active");
  return button;
}

function selectPad(index) {
  if (index < 0 || index >= pads.length) return;
  state.selectedPad = index;
  updateSelectedPadUI();
  renderPads();
}

function updateSelectedPadUI() {
  const pad = pads[state.selectedPad];
  if (!pad) return;

  if (dom.selectedPadInfo) {
    dom.selectedPadInfo.innerHTML = `
      **PAD ${pad.id + 1}**
      ${pad.key.toUpperCase()}
    `;
  }

  if (dom.visualMasterButton) {
    dom.visualMasterButton.textContent = state.visualPad === pad.id ? "VIDEO ACTIVO ✓" : "USAR COMO VIDEO";
  }
}

function setVisualPad(index) {
  if (!pads[index]) return;
  state.visualPad = index;
  updateSelectedPadUI();
  renderPads();
  updateCanvasStatus();
}

/* ============================================================
   PLAYBACK ENGINE
   ============================================================ */

async function togglePadPlayback(index) {
  const pad = pads[index];
  if (!pad) return;

  await resumeAudio();

  if (pad.playing) {
    stopPadPlayback(index);
  } else {
    startPadPlayback(index);
  }
}

async function startPadPlayback(index) {
  const pad = pads[index];
  if (!pad) return;

  await resumeAudio();

  if (pad.sourceType === "local") {
    if (!pad.video) {
      setStatus(`PAD ${index + 1}: SIN FUENTE`, false);
      selectPad(index);
      return;
    }

    const media = pad.video;
    const start = clamp(pad.trimStart, 0, Math.max(media.duration || 0, 0));

    try {
      media.currentTime = start;
    } catch (error) {
      console.warn("Error ajustando tiempo inicial (cue):", error);
    }

    media.playbackRate = getEffectivePlaybackRate(pad);
    media.preservesPitch = false;

    try {
      await media.play();
    } catch (error) {
      console.error("Error al reproducir media:", error);
      setStatus("PLAY ERROR", false);
      return;
    }

    pad.playing = true;
    pad.lastPlayedAt = performance.now();
    setVisualPad(index);
    setStatus(`PLAY PAD ${index + 1}`, true);
  } else if (pad.sourceType === "youtube") {
    if (!pad.youtubePlayer) {
      setStatus(`PAD ${index + 1}: YT NO CARGADO`, false);
      return;
    }

    try {
      pad.youtubePlayer.seekTo(pad.trimStart, true);
      pad.youtubePlayer.setPlaybackRate(getEffectivePlaybackRate(pad));
      pad.youtubePlayer.playVideo();

      pad.playing = true;
      pad.lastPlayedAt = performance.now();
      setVisualPad(index);
      setStatus(`PLAY PAD ${index + 1}`, true);
    } catch (error) {
      console.error("Error al reproducir YouTube:", error);
      setStatus("YOUTUBE ERROR", false);
    }
  }

  updatePadVisualState();
}

function stopPadPlayback(index) {
  const pad = pads[index];
  if (!pad) return;

  if (pad.sourceType === "local" && pad.video) {
    pad.video.pause();
  }

  if (pad.sourceType === "youtube" && pad.youtubePlayer) {
    try {
      pad.youtubePlayer.pauseVideo();
    } catch {}
  }

  pad.playing = false;
  pad.meterValue = 0;

  updatePadVisualState();
  updateCanvasStatus();
}

function stopAllPads() {
  pads.forEach((_, index) => stopPadPlayback(index));
}

function attachMediaEvents(pad) {
  if (!pad.video) return;
  const media = pad.video;

  media.addEventListener("timeupdate", () => {
    if (!pad.playing) return;

    const current = media.currentTime;
    const end = pad.trimStart + pad.duration;

    if (current >= end || current >= media.duration) {
      if (pad.loop) {
        media.currentTime = pad.trimStart;
      } else {
        stopPadPlayback(pad.id);
      }
    }
    updatePadMeter(pad);
  });

  media.addEventListener("ended", () => {
    if (pad.loop && pad.playing) {
      media.currentTime = pad.trimStart;
      media.play().catch(console.warn);
    } else {
      pad.playing = false;
      updatePadVisualState();
    }
  });

  media.addEventListener("error", () => {
    pad.playing = false;
    setStatus(`ERROR PAD ${pad.id + 1}`, false);
    updatePadVisualState();
  });
}

function destroyPadMedia(pad) {
  if (pad.video) {
    try {
      pad.video.pause();
      pad.video.src = "";
      pad.video.load();
      pad.video.remove();
    } catch (e) {
      console.warn("Error destruyendo recurso de video:", e);
    }
    pad.video = null;
  }

  if (pad.fileUrl && pad.fileUrl.startsWith("blob:")) {
    URL.revokeObjectURL(pad.fileUrl);
  }

  pad.file = null;
  pad.fileUrl = null;
  pad.fileName = "Vacío";
  pad.playing = false;
}

/* ============================================================
   LOCAL MEDIA CARGO
   ============================================================ */

function handleMediaFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  loadLocalFile(state.selectedPad, file);
}

function loadLocalFile(index, file) {
  const pad = pads[index];
  if (!pad) return;

  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    setStatus("FORMATO NO SOPORTADO", false);
    return;
  }

  stopPadPlayback(index);
  destroyPadMedia(pad);

  const url = URL.createObjectURL(file);
  const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");

  media.src = url;
  media.preload = "metadata";
  media.playsInline = true;
  media.crossOrigin = "anonymous";
  media.dataset.pad = index;

  if (dom.videoBank) dom.videoBank.appendChild(media);

  pad.file = file;
  pad.fileUrl = url;
  pad.fileName = file.name;
  pad.video = media;

  media.addEventListener("loadedmetadata", () => {
    pad.maxDuration = Number.isFinite(media.duration) ? media.duration : CONFIG.DEFAULT_MAX_DURATION;
    pad.trimStart = clamp(pad.trimStart, 0, Math.max(0, pad.maxDuration - 0.01));
    pad.duration = clamp(pad.duration, CONFIG.MIN_LOOP_DURATION, Math.max(CONFIG.MIN_LOOP_DURATION, pad.maxDuration - pad.trimStart));

    initializePadAudio(pad);
    setStatus(`CARGADO PAD ${index + 1}`, false);
    renderPads();
  });

  attachMediaEvents(pad);
}

/* ============================================================
   AUDIO ROUTING
   ============================================================ */

function setPadSourceType(index, type) {
  const pad = pads[index];
  if (!pad) return;

  stopPadPlayback(index);
  pad.sourceType = type;
  renderPads();
}

function initializePadAudio(pad) {
  if (!audioCtx || !pad.video || pad.audioSource) return;

  try {
    pad.audioSource = audioCtx.createMediaElementSource(pad.video);
    pad.highpassNode = audioCtx.createBiquadFilter();
    pad.lowpassNode = audioCtx.createBiquadFilter();
    pad.gainNode = audioCtx.createGain();

    pad.highpassNode.type = "highpass";
    pad.highpassNode.frequency.value = pad.highpass;

    pad.lowpassNode.type = "lowpass";
    pad.lowpassNode.frequency.value = pad.lowpass;

    // Cadena: Media -> HP -> LP -> Pad Gain -> Master Gain
    pad.audioSource.connect(pad.highpassNode);
    pad.highpassNode.connect(pad.lowpassNode);
    pad.lowpassNode.connect(pad.gainNode);
    pad.gainNode.connect(masterGainNode);

    updatePadAudioGain(pad);
  } catch (e) {
    console.error("Error al inicializar nodos de audio:", e);
  }
}

function updatePadAudioGain(pad) {
  if (!pad.gainNode || !audioCtx) return;

  const anySolo = pads.some(p => p.solo);
  let targetGain = 1.0;

  if (pad.muted) {
    targetGain = 0;
  } else if (anySolo) {
    targetGain = pad.solo ? 1.0 : 0;
  }

  pad.gainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.01);
}

function updateAllAudioGains() {
  pads.forEach(updatePadAudioGain);
}

/* ============================================================
   YOUTUBE ENGINE
   ============================================================ */

function loadYouTubeFromInput(index, url) {
  const pad = pads[index];
  if (!pad) return;

  const ytId = extractYouTubeId(url);
  if (!ytId) {
    setStatus("URL YOUTUBE INVÁLIDA", false);
    return;
  }

  pad.youtubeId = ytId;
  pad.fileName = `YT: ${ytId}`;
  ensureYouTubeAPI(() => createYouTubePlayer(pad));
}

function extractYouTubeId(url) {
  if (!url) return "";
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{11})/);
  return match ? match[1] : url.length === 11 ? url : "";
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

  if (window.__ytApiReady) {
    callback();
  } else {
    window.__ytCallbacks = window.__ytCallbacks || [];
    window.__ytCallbacks.push(callback);
  }
}

function createYouTubePlayer(pad) {
  let container = document.getElementById(`yt-player-${pad.id}`);
  if (!container && dom.ytPlayersContainer) {
    container = document.createElement("div");
    container.id = `yt-player-${pad.id}`;
    dom.ytPlayersContainer.appendChild(container);
  }

  if (pad.youtubePlayer) {
    try {
      pad.youtubePlayer.destroy();
    } catch {}
  }

  pad.youtubePlayer = new window.YT.Player(container.id, {
    height: "180",
    width: "320",
    videoId: pad.youtubeId,
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      modestbranding: 1,
      rel: 0
    },
    events: {
      onReady: () => {
        pad.maxDuration = pad.youtubePlayer.getDuration() || CONFIG.DEFAULT_MAX_DURATION;
        setStatus(`YT PAD ${pad.id + 1} LISTO`, false);
        renderPads();
      },
      onStateChange: event => {
        if (event.data === window.YT.PlayerState.ENDED && pad.playing) {
          if (pad.loop) {
            pad.youtubePlayer.seekTo(pad.trimStart, true);
            pad.youtubePlayer.playVideo();
          } else {
            stopPadPlayback(pad.id);
          }
        }
      }
    }
  });
}

/* ============================================================
   CANVAS ENGINE (MODOS CHOP Y MULTI)
   ============================================================ */

function renderCanvas() {
  if (!dom.canvas) return;

  const ctx = dom.canvas.getContext("2d");
  const width = dom.canvas.width;
  const height = dom.canvas.height;

  const modeSelect = document.getElementById("modeSelect");
  const mode = modeSelect ? modeSelect.value : "CHOP";

  if (mode === "CHOP") {
    const pad = pads[state.visualPad];
    if (pad && pad.playing && pad.sourceType === "local" && pad.video && pad.video.readyState >= 2) {
      ctx.drawImage(pad.video, 0, 0, width, height);
    } else if (!pads.some(p => p.playing)) {
      drawStandby();
    }
  } else if (mode === "MULTI") {
    const activePads = pads.filter(p => p.playing && p.sourceType === "local" && p.video && p.video.readyState >= 2);

    if (activePads.length === 0) {
      drawStandby();
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      const count = activePads.length;
      let cols = 1,
        rows = 1;

      if (count === 2) {
        cols = 2;
        rows = 1;
      } else if (count >= 3) {
        cols = 2;
        rows = 2;
      }

      const cellW = width / cols;
      const cellH = height / rows;

      activePads.slice(0, 4).forEach((pad, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        ctx.drawImage(pad.video, col * cellW, row * cellH, cellW, cellH);
      });
    }
  }

  requestAnimationFrame(renderCanvas);
}

function drawStandby() {
  if (!dom.canvas) return;

  const ctx = dom.canvas.getContext("2d");
  const w = dom.canvas.width;
  const h = dom.canvas.height;

  ctx.fillStyle = "#111116";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  for (let x = 0; x < w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "14px monospace";
  ctx.textAlign = "center";
  ctx.fillText("AV SAMPLER :: NO VIDEO STREAM", w / 2, h / 2);
}

function updateCanvasStatus() {
  const activeCount = pads.filter(p => p.playing).length;
  if (dom.canvasOverlayTag) {
    dom.canvasOverlayTag.textContent = activeCount > 0 ? `ACTIVO (${activeCount})` : "STANDBY";
  }
}

/* ============================================================
   MIDI & KEYBOARD
   ============================================================ */

function bindKeyboard() {
  window.addEventListener("keydown", event => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;

    const key = event.key.toLowerCase();
    const padIndex = CONFIG.KEY_MAP.indexOf(key);

    if (padIndex !== -1 && !event.repeat) {
      togglePadPlayback(padIndex);
    }
  });
}

function initializeMIDI() {
  if (!navigator.requestMIDIAccess) {
    if (dom.midiStatus) dom.midiStatus.textContent = "NO SOPORTADO";
    return;
  }

  navigator
    .requestMIDIAccess()
    .then(midiAccess => {
      const inputs = Array.from(midiAccess.inputs.values());
      if (dom.midiInputSelect) {
        dom.midiInputSelect.innerHTML = 'SELECCIONAR MIDI';
        inputs.forEach(input => {
          const option = document.createElement("option");
          option.value = input.id;
          option.textContent = input.name || `Dispositivo ${input.id}`;
          dom.midiInputSelect.appendChild(option);
        });
      }

      midiAccess.onstatechange = () => initializeMIDI();
    })
    .catch(() => {
      if (dom.midiStatus) dom.midiStatus.textContent = "ERROR ACCESO";
    });
}

function selectMIDIInput(inputId) {
  if (!navigator.requestMIDIAccess) return;

  navigator.requestMIDIAccess().then(midiAccess => {
    midiAccess.inputs.forEach(input => {
      input.onmidimessage = input.id === inputId ? handleMIDIMessage : null;
    });
    state.midiInputId = inputId;
    if (dom.midiStatus) {
      dom.midiStatus.textContent = inputId ? "CONECTADO" : "DESCONECTADO";
    }
  });
}

function handleMIDIMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status >> 4;

  if (command === 9 && velocity > 0) {
    const padIndex = CONFIG.MIDI_NOTES.indexOf(note);
    if (padIndex !== -1) {
      togglePadPlayback(padIndex);
    }
  }

  if (command === 11) {
    const pad = pads[state.selectedPad];
    if (!pad) return;

    if (note === 112 && pad.highpassNode) {
      pad.highpass = (velocity / 127) * 1000;
      pad.highpassNode.frequency.value = pad.highpass;
    } else if (note === 113 && pad.lowpassNode) {
      pad.lowpass = (velocity / 127) * 19800 + 20;
      pad.lowpassNode.frequency.value = pad.lowpass;
    } else if (note === 7 && pad.gainNode) {
      const vol = velocity / 127;
      pad.gainNode.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.01);
    }
  }
}

/* ============================================================
   RECORDING ENGINE
   ============================================================ */

async function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  await resumeAudio();

  const canvasStream = dom.canvas.captureStream(30);
  recordingDestination = audioCtx.createMediaStreamDestination();
  masterGainNode.connect(recordingDestination);

  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...recordingDestination.stream.getAudioTracks()
  ]);

  const mimeTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || "";

  if (!mimeType) {
    setStatus("REC UNSUPPORTED", false);
    return;
  }

  state.recordingChunks = [];
  state.recorder = new MediaRecorder(combinedStream, { mimeType });

  state.recorder.ondataavailable = e => {
    if (e.data.size > 0) state.recordingChunks.push(e.data);
  };

  state.recorder.onstop = exportRecording;

  state.recorder.start();
  state.isRecording = true;
  state.recordingStartedAt = Date.now();

  if (dom.recordButton) dom.recordButton.classList.add("recording");
  setStatus("GRABANDO...", true);

  state.recordingTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    if (dom.recordingTimer) dom.recordingTimer.textContent = `\({m}:\){s}`;
  }, 1000);
}

function stopRecording() {
  if (!state.recorder || !state.isRecording) return;

  state.recorder.stop();
  state.isRecording = false;

  clearInterval(state.recordingTimer);
  if (dom.recordButton) dom.recordButton.classList.remove("recording");
  if (dom.recordingTimer) dom.recordingTimer.textContent = "00:00";

  if (recordingDestination) {
    try {
      masterGainNode.disconnect(recordingDestination);
    } catch {}
  }

  setStatus("GRABACIÓN FINALIZADA", false);
}

function exportRecording() {
  const blob = new Blob(state.recordingChunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = `av-sampler-rec-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/* ============================================================
   PROJECT STATE EXPORT / IMPORT
   ============================================================ */

function exportProject() {
  const projectData = {
    version: 2,
    timestamp: Date.now(),
    globalBpm: state.globalBpm,
    masterVolume: state.masterVolume,
    pads: pads.map(p => ({
      id: p.id,
      sourceType: p.sourceType,
      youtubeId: p.youtubeId,
      fileName: p.fileName,
      duration: p.duration,
      trimStart: p.trimStart,
      playbackRate: p.playbackRate,
      loop: p.loop,
      muted: p.muted,
      solo: p.solo,
      bpm: p.bpm,
      highpass: p.highpass,
      lowpass: p.lowpass
    }))
  };

  const jsonStr = JSON.stringify(projectData, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `av-project-${Date.now()}.json`;
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
      loadProjectData(data);
    } catch (err) {
      setStatus("JSON PROYECTO INVÁLIDO", false);
    }
  };
  reader.readAsText(file);
}

function loadProjectData(data) {
  stopAllPads();

  if (data.globalBpm) {
    state.globalBpm = data.globalBpm;
    updateGlobalBpmUI();
  }

  if (data.masterVolume !== undefined) {
    state.masterVolume = data.masterVolume;
    if (dom.masterVolume) dom.masterVolume.value = data.masterVolume;
    if (masterGainNode) masterGainNode.gain.value = data.masterVolume;
  }

  if (Array.isArray(data.pads)) {
    data.pads.forEach((pData, idx) => {
      if (!pads[idx]) return;
      const pad = pads[idx];

      pad.sourceType = pData.sourceType || "local";
      pad.youtubeId = pData.youtubeId || "";
      pad.duration = pData.duration || CONFIG.DEFAULT_PAD_DURATION;
      pad.trimStart = pData.trimStart || 0;
      pad.playbackRate = pData.playbackRate || CONFIG.DEFAULT_PLAYBACK_RATE;
      pad.loop = pData.loop !== undefined ? pData.loop : true;
      pad.muted = !!pData.muted;
      pad.solo = !!pData.solo;
      pad.bpm = pData.bpm || CONFIG.DEFAULT_BPM;
      pad.highpass = pData.highpass || 20;
      pad.lowpass = pData.lowpass || 20000;

      if (pad.sourceType === "youtube" && pad.youtubeId) {
        pad.fileName = `YT: ${pad.youtubeId}`;
        ensureYouTubeAPI(() => createYouTubePlayer(pad));
      } else {
        pad.fileName = pData.fileName || "Vacío";
      }
    });
  }

  renderPads();
  setStatus("PROYECTO CARGADO", false);
}

function clearProject() {
  stopAllPads();
  pads.forEach((pad, idx) => {
    destroyPadMedia(pad);
    pads[idx] = createPad(idx);
  });
  renderPads();
  setStatus("PROYECTO REINICIADO", false);
}

/* ============================================================
   MATH & HELPERS
   ============================================================ */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampPadTrim(pad) {
  pad.trimStart = clamp(pad.trimStart, 0, Math.max(0, pad.maxDuration - 0.01));
}

function clampPadDuration(pad) {
  pad.duration = clamp(
    pad.duration,
    CONFIG.MIN_LOOP_DURATION,
    Math.max(CONFIG.MIN_LOOP_DURATION, pad.maxDuration - pad.trimStart)
  );
}

function setPadRate(index, rate) {
  const pad = pads[index];
  if (!pad) return;

  pad.playbackRate = clamp(rate, CONFIG.MIN_PLAYBACK_RATE, CONFIG.MAX_PLAYBACK_RATE);

  if (pad.sourceType === "local" && pad.video) {
    pad.video.playbackRate = getEffectivePlaybackRate(pad);
  } else if (pad.sourceType === "youtube" && pad.youtubePlayer) {
    try {
      pad.youtubePlayer.setPlaybackRate(getEffectivePlaybackRate(pad));
    } catch {}
  }
}

function getEffectivePlaybackRate(pad) {
  if (!pad.sync || !state.globalBpm || !pad.bpm) {
    return pad.playbackRate;
  }
  return pad.playbackRate * (state.globalBpm / pad.bpm);
}

function toggleMute(index) {
  const pad = pads[index];
  if (!pad) return;

  pad.muted = !pad.muted;
  updateAllAudioGains();
  renderPads();
}

function toggleSolo(index) {
  const pad = pads[index];
  if (!pad) return;

  pad.solo = !pad.solo;
  updateAllAudioGains();
  renderPads();
}

function toggleSync(index) {
  const pad = pads[index];
  if (!pad) return;

  pad.sync = !pad.sync;
  setPadRate(index, pad.playbackRate);
  renderPads();
}

let tapTimes = [];
function handleGlobalTap() {
  const now = performance.now();
  tapTimes.push(now);

  if (tapTimes.length > 4) tapTimes.shift();

  if (tapTimes.length > 1) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) {
      intervals.push(tapTimes[i] - tapTimes[i - 1]);
    }
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round(60000 / avgMs);

    if (bpm >= 30 && bpm <= 300) {
      state.globalBpm = bpm;
      updateGlobalBpmUI();
      pads.forEach(p => {
        if (p.sync) setPadRate(p.id, p.playbackRate);
      });
    }
  }
}

function updateGlobalBpmUI() {
  if (dom.globalBpmValue) {
    dom.globalBpmValue.textContent = `${state.globalBpm} BPM`;
  }
}

function updatePadVisualState() {
  renderPads();
}

function updatePadMeter(pad) {
  if (!pad.playing || !pad.video || !pad.duration) return;

  const current = pad.video.currentTime - pad.trimStart;
  const progress = clamp((current / pad.duration) * 100, 0, 100);
  pad.meterValue = progress;

  if (dom.padsGrid) {
    const card = dom.padsGrid.querySelector(`[data-pad="${pad.id}"]`);
    if (card) {
      const bar = card.querySelector(".pad-meter-progress");
      if (bar) bar.style.width = `${progress}%`;
    }
  }
}

function refreshAudioOutputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  navigator.mediaDevices.enumerateDevices().then(devices => {
    const outputs = devices.filter(d => d.kind === "audiooutput");
    if (dom.audioOutputSelect) {
      dom.audioOutputSelect.innerHTML = 'SALIDA DEFAULT';
      outputs.forEach(device => {
        const opt = document.createElement("option");
        opt.value = device.deviceId;
        opt.textContent = device.label || `Salida ${device.deviceId.slice(0, 5)}...`;
        dom.audioOutputSelect.appendChild(opt);
      });
    }
  });
}

function handleAudioOutputChange(event) {
  const deviceId = event.target.value;
  if (audioCtx && typeof audioCtx.setSinkId === "function") {
    audioCtx
      .setSinkId(deviceId)
      .then(() => setStatus("SALIDA AUDIO ACTUALIZADA", false))
      .catch(err => {
        console.error("Error al cambiar salida de audio:", err);
        setStatus("ERROR CAMBIO SALIDA", false);
      });
  }
}

function setStatus(text, active = false) {
  if (dom.statusText) dom.statusText.textContent = text;
  if (dom.statusDot) {
    dom.statusDot.style.background = active ? "#00ffcc" : "#888";
    dom.statusDot.style.boxShadow = active ? "0 0 8px #00ffcc" : "none";
  }
}
