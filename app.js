/* ============================================================
   AV SAMPLER
   Version 2
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

  KEY_MAP: [
    "q",
    "w",
    "e",
    "r",
    "a",
    "s",
    "d",
    "f"
  ],

  MIDI_NOTES: [
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43
  ]

};


/* ============================================================
   AUDIO CONTEXT
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

  recordingStream: null,

  activeProjectName: "Proyecto nuevo"

};


/* ============================================================
   PAD FACTORY
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


const pads = Array.from(
  { length: CONFIG.PAD_COUNT },
  (_, index) => createPad(index)
);


/* ============================================================
   DOM
   ============================================================ */

const dom = {

  padsGrid:
    document.getElementById("padsGrid"),

  canvas:
    document.getElementById("outputCanvas"),

  canvasContainer:
    document.getElementById("canvasContainer"),

  canvasOverlayTag:
    document.getElementById("canvasOverlayTag"),

  videoBank:
    document.getElementById("videoBank"),

  ytPlayersContainer:
    document.getElementById("ytPlayersContainer"),

  masterVolume:
    document.getElementById("masterVolume"),

  globalBpmValue:
    document.getElementById("globalBpmValue"),

  globalTapButton:
    document.getElementById("globalTapButton"),

  statusBadge:
    document.getElementById("statusBadge"),

  statusDot:
    document.getElementById("statusDot"),

  statusText:
    document.getElementById("statusText"),

  audioStartButton:
    document.getElementById("audioStartButton"),

  loadProjectButton:
    document.getElementById("loadProjectButton"),

  saveProjectButton:
    document.getElementById("saveProjectButton"),

  recordButton:
    document.getElementById("recordButton"),

  mediaFileInput:
    document.getElementById("mediaFileInput"),

  projectFileInput:
    document.getElementById("projectFileInput"),

  selectedPadInfo:
    document.getElementById("selectedPadInfo"),

  visualMasterButton:
    document.getElementById("visualMasterButton"),

  midiInputSelect:
    document.getElementById("midiInputSelect"),

  midiStatus:
    document.getElementById("midiStatus"),

  audioOutputSelect:
    document.getElementById("audioOutputSelect"),

  audioOutputRefresh:
    document.getElementById("audioOutputRefresh"),

  projectInfo:
    document.getElementById("projectInfo"),

  clearProjectButton:
    document.getElementById("clearProjectButton"),

  recordingStatus:
    document.getElementById("recordingStatus"),

  recordingTimer:
    document.getElementById("recordingTimer")

};


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener(
  "DOMContentLoaded",
  initialize
);


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

  setStatus(
    "READY",
    false
  );

}


/* ============================================================
   AUDIO INITIALIZATION
   ============================================================ */

function initializeAudio() {

  if (audioCtx) {
    return;
  }

  const AudioContextClass =
    window.AudioContext ||
    window.webkitAudioContext;

  if (!AudioContextClass) {

    setStatus(
      "AUDIO UNSUPPORTED",
      false
    );

    return;

  }

  audioCtx = new AudioContextClass();

  masterGainNode =
    audioCtx.createGain();

  masterGainNode.gain.value =
    state.masterVolume;

  masterGainNode.connect(
    audioCtx.destination
  );

}


/* ============================================================
   RESUME AUDIO
   ============================================================ */

async function resumeAudio() {

  initializeAudio();

  if (
    audioCtx &&
    audioCtx.state === "suspended"
  ) {

    try {

      await audioCtx.resume();

    } catch (error) {

      console.error(
        "No se pudo activar AudioContext:",
        error
      );

      setStatus(
        "AUDIO ERROR",
        false
      );

    }

  }

}


/* ============================================================
   GLOBAL CONTROLS
   ============================================================ */

function bindGlobalControls() {

  dom.audioStartButton.addEventListener(
    "click",
    async () => {

      await resumeAudio();

      setStatus(
        "AUDIO READY",
        false
      );

      dom.audioStartButton.textContent =
        "AUDIO ✓";

    }
  );


  dom.masterVolume.addEventListener(
    "input",
    event => {

      state.masterVolume =
        Number(event.target.value);

      if (masterGainNode) {

        masterGainNode.gain.setTargetAtTime(
          state.masterVolume,
          audioCtx.currentTime,
          0.01
        );

      }

    }
  );


  dom.globalTapButton.addEventListener(
    "click",
    handleGlobalTap
  );


  dom.saveProjectButton.addEventListener(
    "click",
    exportProject
  );


  dom.loadProjectButton.addEventListener(
    "click",
    () => dom.projectFileInput.click()
  );


  dom.projectFileInput.addEventListener(
    "change",
    handleProjectFile
  );


  dom.clearProjectButton.addEventListener(
    "click",
    clearProject
  );


  dom.recordButton.addEventListener(
    "click",
    toggleRecording
  );


  dom.mediaFileInput.addEventListener(
    "change",
    handleMediaFile
  );


  dom.visualMasterButton.addEventListener(
    "click",
    () => {

      setVisualPad(
        state.selectedPad
      );

    }
  );


  dom.audioOutputRefresh.addEventListener(
    "click",
    refreshAudioOutputs
  );


  dom.audioOutputSelect.addEventListener(
    "change",
    handleAudioOutputChange
  );


  dom.midiInputSelect.addEventListener(
    "change",
    event => {

      selectMIDIInput(
        event.target.value
      );

    }
  );

}


/* ============================================================
   PAD RENDERING
   ============================================================ */

function renderPads() {

  dom.padsGrid.innerHTML = "";

  pads.forEach(
    pad => {

      const card =
        createPadCard(pad);

      dom.padsGrid.appendChild(
        card
      );

    }
  );

}


function createPadCard(pad) {

  const card =
    document.createElement("article");

  card.className =
    "pad-card";

  card.dataset.pad =
    pad.id;

  if (
    pad.id === state.selectedPad
  ) {

    card.classList.add(
      "selected"
    );

  }

  if (pad.playing) {

    card.classList.add(
      "playing"
    );

  }


  /* HEADER */

  const header =
    document.createElement("div");

  header.className =
    "pad-header";


  const titleGroup =
    document.createElement("div");

  titleGroup.className =
    "pad-title-group";


  const number =
    document.createElement("span");

  number.className =
    "pad-number";

  number.textContent =
    `PAD ${pad.id + 1}`;


  const key =
    document.createElement("span");

  key.className =
    "pad-key-badge";

  key.textContent =
    pad.key.toUpperCase();


  titleGroup.append(
    number,
    key
  );


  const playButton =
    document.createElement("button");

  playButton.className =
    "pad-play-btn";

  playButton.type =
    "button";

  playButton.textContent =
    pad.playing
      ? "STOP"
      : "PLAY";

  if (pad.playing) {

    playButton.classList.add(
      "active"
    );

  }


  playButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      togglePadPlayback(
        pad.id
      );

    }
  );


  header.append(
    titleGroup,
    playButton
  );


  /* SOURCE */

  const sourceSelect =
    document.createElement("select");

  sourceSelect.className =
    "pad-source-select";

  sourceSelect.innerHTML = `
    <option value="local">LOCAL</option>
    <option value="youtube">YOUTUBE</option>
  `;

  sourceSelect.value =
    pad.sourceType;


  sourceSelect.addEventListener(
    "click",
    event => event.stopPropagation()
  );


  sourceSelect.addEventListener(
    "change",
    event => {

      event.stopPropagation();

      setPadSourceType(
        pad.id,
        event.target.value
      );

    }
  );


  /* YOUTUBE */

  const youtubeGroup =
    document.createElement("div");

  youtubeGroup.className =
    "yt-input-group";

  youtubeGroup.style.display =
    pad.sourceType === "youtube"
      ? "flex"
      : "none";


  const youtubeInput =
    document.createElement("input");

  youtubeInput.type =
    "text";

  youtubeInput.placeholder =
    "YouTube URL";

  youtubeInput.value =
    pad.youtubeId
      ? `https://youtu.be/${pad.youtubeId}`
      : "";


  const youtubeButton =
    document.createElement("button");

  youtubeButton.type =
    "button";

  youtubeButton.textContent =
    "LOAD";


  youtubeInput.addEventListener(
    "click",
    event => event.stopPropagation()
  );

  youtubeButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      loadYouTubeFromInput(
        pad.id,
        youtubeInput.value
      );

    }
  );


  youtubeGroup.append(
    youtubeInput,
    youtubeButton
  );


  /* LOCAL LOAD */

  const localButton =
    document.createElement("button");

  localButton.type =
    "button";

  localButton.className =
    "btn";

  localButton.textContent =
    "CARGAR VIDEO";


  localButton.style.width =
    "100%";

  localButton.style.marginBottom =
    "6px";


  localButton.style.display =
    pad.sourceType === "local"
      ? "block"
      : "none";


  localButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      state.selectedPad =
        pad.id;

      updateSelectedPadUI();

      dom.mediaFileInput.click();

    }
  );


  /* THUMB */

  const thumb =
    document.createElement("div");

  thumb.className =
    "pad-thumb";

  thumb.textContent =
    pad.fileName;


  /* METER */

  const meter =
    document.createElement("div");

  meter.className =
    "pad-meter-bar";


  const meterProgress =
    document.createElement("div");

  meterProgress.className =
    "pad-meter-progress";

  meterProgress.style.width =
    `${pad.meterValue}%`;


  meter.appendChild(
    meterProgress
  );


  /* CONTROLS */

  const controls =
    document.createElement("div");

  controls.className =
    "pad-controls";


  /* CUE */

  controls.appendChild(
    createRangeRow(
      "CUE",
      pad.trimStart,
      0,
      Math.max(
        pad.maxDuration,
        1
      ),
      0.01,
      value => {

        pad.trimStart =
          Number(value);

        clampPadTrim(
          pad
        );

      }
    )
  );


  /* LOOP */

  controls.appendChild(
    createRangeRow(
      "LOOP",
      pad.duration,
      CONFIG.MIN_LOOP_DURATION,
      Math.max(
        pad.maxDuration,
        1
      ),
      0.01,
      value => {

        pad.duration =
          Number(value);

        clampPadDuration(
          pad
        );

      }
    )
  );


  /* RATE */

  controls.appendChild(
    createRangeRow(
      "RATE",
      pad.playbackRate,
      CONFIG.MIN_PLAYBACK_RATE,
      CONFIG.MAX_PLAYBACK_RATE,
      0.01,
      value => {

        setPadRate(
          pad.id,
          Number(value)
        );

      },
      value => `${Number(value).toFixed(2)}x`
    )
  );


  /* BPM */

  controls.appendChild(
    createNumberRow(
      "BPM",
      pad.bpm,
      value => {

        const bpm =
          Number(value);

        if (
          !Number.isFinite(bpm) ||
          bpm <= 0
        ) {

          return;

        }

        pad.bpm =
          Math.min(
            400,
            Math.max(
              20,
              bpm
            )
          );

      }
    )
  );


  /* BUTTONS */

  const buttonRow =
    document.createElement("div");

  buttonRow.className =
    "pad-control-row";


  const muteButton =
    createSmallButton(
      "MUTE",
      pad.muted,
      "btn-mute"
    );


  muteButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      toggleMute(
        pad.id
      );

    }
  );


  const soloButton =
    createSmallButton(
      "SOLO",
      pad.solo,
      "btn-solo"
    );


  soloButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      toggleSolo(
        pad.id
      );

    }
  );


  const syncButton =
    createSmallButton(
      "SYNC",
      pad.sync,
      "btn-sync"
    );


  syncButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      toggleSync(
        pad.id
      );

    }
  );


  const visualButton =
    createSmallButton(
      "VIDEO",
      pad.id === state.visualPad,
      "btn-sync"
    );


  visualButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      setVisualPad(
        pad.id
      );

    }
  );


  buttonRow.append(
    muteButton,
    soloButton,
    syncButton,
    visualButton
  );


  controls.appendChild(
    buttonRow
  );


  /* CARD CONTENT */

  card.append(
    header,
    sourceSelect,
    youtubeGroup,
    localButton,
    thumb,
    meter,
    controls
  );


  /* CARD SELECTION */

  card.addEventListener(
    "click",
    () => {

      selectPad(
        pad.id
      );

    }
  );


  /* DRAG & DROP */

  card.addEventListener(
    "dragover",
    event => {

      event.preventDefault();

      card.classList.add(
        "drag-highlight"
      );

    }
  );


  card.addEventListener(
    "dragleave",
    () => {

      card.classList.remove(
        "drag-highlight"
      );

    }
  );


  card.addEventListener(
    "drop",
    event => {

      event.preventDefault();

      card.classList.remove(
        "drag-highlight"
      );

      const file =
        event.dataTransfer.files?.[0];

      if (!file) {
        return;
      }

      if (
        !file.type.startsWith(
          "video/"
        ) &&
        !file.type.startsWith(
          "audio/"
        )
      ) {

        setStatus(
          "INVALID FILE",
          false
        );

        return;

      }

      state.selectedPad =
        pad.id;

      loadLocalFile(
        pad.id,
        file
      );

    }
  );


  return card;

}


/* ============================================================
   UI HELPERS
   ============================================================ */

function createRangeRow(
  label,
  value,
  min,
  max,
  step,
  onInput,
  formatter = null
) {

  const row =
    document.createElement("div");

  row.className =
    "pad-control-row";


  const labelElement =
    document.createElement("span");

  labelElement.textContent =
    label;


  const wrapper =
    document.createElement("div");


  wrapper.style.display =
    "flex";

  wrapper.style.alignItems =
    "center";

  wrapper.style.gap =
    "4px";


  const input =
    document.createElement("input");

  input.type =
    "range";

  input.min =
    min;

  input.max =
    max;

  input.step =
    step;

  input.value =
    value;


  const output =
    document.createElement("output");

  output.textContent =
    formatter
      ? formatter(value)
      : Number(value).toFixed(
          2
        );


  input.addEventListener(
    "click",
    event => event.stopPropagation()
  );


  input.addEventListener(
    "input",
    event => {

      const current =
        Number(event.target.value);

      output.textContent =
        formatter
          ? formatter(current)
          : current.toFixed(2);

      onInput(
        current
      );

    }
  );


  wrapper.append(
    input,
    output
  );


  row.append(
    labelElement,
    wrapper
  );


  return row;

}


function createNumberRow(
  label,
  value,
  onChange
) {

  const row =
    document.createElement("div");

  row.className =
    "pad-control-row";


  const labelElement =
    document.createElement("span");

  labelElement.textContent =
    label;


  const input =
    document.createElement("input");

  input.type =
    "number";

  input.className =
    "num-input-sm";

  input.value =
    value;

  input.min =
    "20";

  input.max =
    "400";

  input.step =
    "1";


  input.addEventListener(
    "click",
    event => event.stopPropagation()
  );


  input.addEventListener(
    "change",
    event => {

      onChange(
        event.target.value
      );

    }
  );


  row.append(
    labelElement,
    input
  );


  return row;

}


function createSmallButton(
  text,
  active,
  className
) {

  const button =
    document.createElement("button");

  button.type =
    "button";

  button.textContent =
    text;

  button.className =
    className;

  if (active) {

    button.classList.add(
      "active"
    );

  }

  return button;

}


/* ============================================================
   PAD SELECTION
   ============================================================ */

function selectPad(index) {

  if (
    index < 0 ||
    index >= pads.length
  ) {

    return;

  }

  state.selectedPad =
    index;

  updateSelectedPadUI();

  renderPads();

}


function updateSelectedPadUI() {

  const pad =
    pads[state.selectedPad];

  if (!pad) {
    return;
  }

  dom.selectedPadInfo.innerHTML = `
    <strong>PAD ${pad.id + 1}</strong>
    <span>${pad.key.toUpperCase()}</span>
  `;


  dom.visualMasterButton.textContent =
    state.visualPad === pad.id
      ? "VIDEO ACTIVO ✓"
      : "USAR COMO VIDEO";

}


/* ============================================================
   VISUAL PAD
   ============================================================ */

function setVisualPad(index) {

  const pad =
    pads[index];

  if (!pad) {
    return;
  }

  state.visualPad =
    index;

  updateSelectedPadUI();

  renderPads();

  updateCanvasStatus();

}


/* ============================================================
   PAD PLAYBACK
   ============================================================ */

async function togglePadPlayback(index) {

  const pad =
    pads[index];

  if (!pad) {
    return;
  }

  await resumeAudio();

  if (pad.playing) {

    stopPadPlayback(
      index
    );

  } else {

    startPadPlayback(
      index
    );

  }

}


async function startPadPlayback(index) {

  const pad =
    pads[index];

  if (!pad) {
    return;
  }

  await resumeAudio();

  if (
    pad.sourceType === "local"
  ) {

    if (!pad.video) {

      setStatus(
        `PAD ${index + 1}: SIN FUENTE`,
        false
      );

      selectPad(index);

      return;

    }

    const media =
      pad.video;

    const start =
      clamp(
        pad.trimStart,
        0,
        Math.max(
          media.duration || 0,
          0
        )
      );


    try {

      media.currentTime =
        start;

    } catch (error) {

      console.warn(
        "No se pudo establecer cue:",
        error
      );

    }


    media.playbackRate =
      getEffectivePlaybackRate(
        pad
      );

    media.preservesPitch =
      false;


    try {

      await media.play();

    } catch (error) {

      console.error(
        "Error reproduciendo media:",
        error
      );

      setStatus(
        "PLAY ERROR",
        false
      );

      return;

    }


    pad.playing =
      true;

    pad.lastPlayedAt =
      performance.now();

    setVisualPad(index);

    setStatus(
      `PLAY PAD ${index + 1}`,
      true
    );

  }


  else if (
    pad.sourceType === "youtube"
  ) {

    if (!pad.youtubePlayer) {

      setStatus(
        `PAD ${index + 1}: YOUTUBE NO CARGADO`,
        false
      );

      return;

    }


    try {

      pad.youtubePlayer.seekTo(
        pad.trimStart,
        true
      );

      pad.youtubePlayer.setPlaybackRate(
        getEffectivePlaybackRate(
          pad
        )
      );

      pad.youtubePlayer.playVideo();

      pad.playing =
        true;

      pad.lastPlayedAt =
        performance.now();

      setVisualPad(index);

      setStatus(
        `PLAY PAD ${index + 1}`,
        true
      );

    } catch (error) {

      console.error(
        "YouTube playback error:",
        error
      );

      setStatus(
        "YOUTUBE ERROR",
        false
      );

    }

  }


  updatePadVisualState();

}


function stopPadPlayback(index) {

  const pad =
    pads[index];

  if (!pad) {
    return;
  }


  if (
    pad.sourceType === "local" &&
    pad.video
  ) {

    pad.video.pause();

  }


  if (
    pad.sourceType === "youtube" &&
    pad.youtubePlayer
  ) {

    try {

      pad.youtubePlayer.pauseVideo();

    } catch {}

  }


  pad.playing =
    false;

  pad.meterValue =
    0;


  updatePadVisualState();

  updateCanvasStatus();

}


function stopAllPads() {

  pads.forEach(
    (_, index) => {

      stopPadPlayback(
        index
      );

    }
  );

}


/* ============================================================
   MEDIA TIME / LOOP ENGINE
   ============================================================ */

function attachMediaEvents(pad) {

  if (!pad.video) {
    return;
  }

  const media =
    pad.video;


  media.addEventListener(
    "timeupdate",
    () => {

      if (!pad.playing) {
        return;
      }

      const current =
        media.currentTime;

      const end =
        pad.trimStart +
        pad.duration;


      if (
        current >= end ||
        current >= media.duration
      ) {

        if (pad.loop) {

          media.currentTime =
            pad.trimStart;

        } else {

          stopPadPlayback(
            pad.id
          );

        }

      }

      updatePadMeter(
        pad
      );

    }
  );


  media.addEventListener(
    "ended",
    () => {

      if (
        pad.loop &&
        pad.playing
      ) {

        media.currentTime =
          pad.trimStart;

        media.play().catch(
          console.warn
        );

      } else {

        pad.playing =
          false;

        updatePadVisualState();

      }

    }
  );


  media.addEventListener(
    "error",
    () => {

      pad.playing =
        false;

      setStatus(
        `ERROR PAD ${pad.id + 1}`,
        false
      );

      updatePadVisualState();

    }
  );

}


/* ============================================================
   LOCAL MEDIA
   ============================================================ */

function handleMediaFile(event) {

  const file =
    event.target.files?.[0];

  event.target.value =
    "";

  if (!file) {
    return;
  }

  loadLocalFile(
    state.selectedPad,
    file
  );

}


function loadLocalFile(
  index,
  file
) {

  const pad =
    pads[index];

  if (!pad) {
    return;
  }


  if (
    !file.type.startsWith("video/") &&
    !file.type.startsWith("audio/")
  ) {

    setStatus(
      "FORMATO NO SOPORTADO",
      false
    );

    return;

  }


  stopPadPlayback(
    index
  );


  destroyPadMedia(
    pad
  );


  const url =
    URL.createObjectURL(
      file
    );


  const media =
    document.createElement(
      file.type.startsWith("video/")
        ? "video"
        : "audio"
    );


  media.src =
    url;

  media.preload =
    "metadata";

  media.playsInline =
    true;

  media.crossOrigin =
    "anonymous";


  media.dataset.pad =
    index;


  dom.videoBank.appendChild(
    media
  );


  pad.file =
    file;

  pad.fileUrl =
    url;

  pad.fileName =
    file.name;

  pad.video =
    media;


  media.addEventListener(
    "loadedmetadata",
    () => {

      pad.maxDuration =
        Number.isFinite(
          media.duration
        )
          ? media.duration
          : CONFIG.DEFAULT_MAX_DURATION;


      pad.trimStart =
        clamp(
          pad.trimStart,
          0,
          Math.max(
            0,
            pad.maxDuration - 0.01
          )
        );


      pad.duration =
        clamp(
          pad.duration,
          CONFIG.MIN_LOOP_DURATION,
          Math.max(
            CONFIG.MIN_LOOP_DURATION,
            pad.maxDuration - pad.trimStart
          )
        );


      initializePadAudio(
        pad
      );


      setStatus(
        `CARGADO PAD ${index + 1}`,
        false
      );


      renderPads();

    }
  );


  attachMediaEvents(
    pad
  );


  selectPad(index);

}


/* ============================================================
   DESTROY LOCAL MEDIA
   ============================================================ */

function destroyPadMedia(pad) {

  if (pad.video) {

    try {

      pad.video.pause();

    } catch {}

    try {

      pad.video.remove();

    } catch {}

  }


  if (pad.fileUrl) {

    try {

      URL.revokeObjectURL(
        pad.fileUrl
      );

    } catch {}

  }


  if (pad.audioSource) {

    try {

      pad.audioSource.disconnect();

    } catch {}

  }


  pad.video =
    null;

  pad.file =
    null;

  pad.fileUrl =
    null;

  pad.audioSource =
    null;

}


/* ============================================================
   AUDIO GRAPH
   ============================================================ */

function initializePadAudio(pad) {

  if (
    !audioCtx ||
    !pad.video
  ) {

    return;

  }


  if (pad.audioSource) {

    return;

  }


  try {

    const source =
      audioCtx.createMediaElementSource(
        pad.video
      );

    const highpass =
      audioCtx.createBiquadFilter();

    const lowpass =
      audioCtx.createBiquadFilter();

    const gain =
      audioCtx.createGain();


    highpass.type =
      "highpass";

    lowpass.type =
      "lowpass";


    highpass.frequency.value =
      pad.highpass;

    lowpass.frequency.value =
      pad.lowpass;


    source.connect(
      highpass
    );

    highpass.connect(
      lowpass
    );

    lowpass.connect(
      gain
    );

    gain.connect(
      masterGainNode
    );


    pad.audioSource =
      source;

    pad.highpassNode =
      highpass;

    pad.lowpassNode =
      lowpass;

    pad.gainNode =
      gain;


    updatePadGain(
      pad
    );

  } catch (error) {

    console.error(
      "No se pudo crear AudioNode:",
      error
    );

  }

}


/* ============================================================
   GAIN / MUTE / SOLO
   ============================================================ */

function updatePadGain(pad) {

  if (!pad.gainNode) {
    return;
  }


  const hasSolo =
    pads.some(
      item => item.solo
    );


  let gain =
    1;


  if (pad.muted) {

    gain = 0;

  }


  if (
    hasSolo &&
    !pad.solo
  ) {

    gain = 0;

  }


  pad.gainNode.gain.setTargetAtTime(
    gain,
    audioCtx.currentTime,
    0.01
  );

}


function toggleMute(index) {

  const pad =
    pads[index];

  pad.muted =
    !pad.muted;

  updateAllPadGains();

  renderPads();

}


function toggleSolo(index) {

  const pad =
    pads[index];

  pad.solo =
    !pad.solo;

  updateAllPadGains();

  renderPads();

}


function updateAllPadGains() {

  pads.forEach(
    updatePadGain
  );

}


/* ============================================================
   RATE / BPM
   ============================================================ */

function getEffectivePlaybackRate(pad) {

  if (!pad.sync) {

    return pad.playbackRate;

  }


  if (
    !pad.bpm ||
    pad.bpm <= 0
  ) {

    return pad.playbackRate;

  }


  const syncedRate =
    state.globalBpm /
    pad.bpm;


  return clamp(
    pad.playbackRate *
    syncedRate,
    CONFIG.MIN_PLAYBACK_RATE,
    CONFIG.MAX_PLAYBACK_RATE
  );

}


function setPadRate(
  index,
  rate
) {

  const pad =
    pads[index];

  pad.playbackRate =
    clamp(
      Number(rate),
      CONFIG.MIN_PLAYBACK_RATE,
      CONFIG.MAX_PLAYBACK_RATE
    );


  applyPadRate(
    pad
  );

}


function applyPadRate(pad) {

  const rate =
    getEffectivePlaybackRate(
      pad
    );


  if (pad.video) {

    pad.video.playbackRate =
      rate;

    pad.video.preservesPitch =
      false;

  }


  if (pad.youtubePlayer) {

    try {

      pad.youtubePlayer.setPlaybackRate(
        rate
      );

    } catch {}

  }

}


function toggleSync(index) {

  const pad =
    pads[index];

  pad.sync =
    !pad.sync;

  applyPadRate(
    pad
  );

  renderPads();

}


/* ============================================================
   BPM TAP
   ============================================================ */

let globalTapTimes = [];

let padTapTimes =
  Array.from(
    { length: CONFIG.PAD_COUNT },
    () => []
  );


function handleGlobalTap() {

  const now =
    performance.now();

  globalTapTimes.push(
    now
  );


  if (
    globalTapTimes.length > 4
  ) {

    globalTapTimes.shift();

  }


  if (
    globalTapTimes.length >= 2
  ) {

    const intervals = [];

    for (
      let i = 1;
      i < globalTapTimes.length;
      i++
    ) {

      intervals.push(
        globalTapTimes[i] -
        globalTapTimes[i - 1]
      );

    }


    const average =
      intervals.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      intervals.length;


    const bpm =
      60000 /
      average;


    state.globalBpm =
      clamp(
        bpm,
        20,
        400
      );


    updateGlobalBpmUI();

    pads.forEach(
      applyPadRate
    );

  }

}


function updateGlobalBpmUI() {

  dom.globalBpmValue.textContent =
    Math.round(
      state.globalBpm
    );

}


/* ============================================================
   KEYBOARD
   ============================================================ */

const pressedKeys =
  new Set();


function bindKeyboard() {

  window.addEventListener(
    "keydown",
    event => {

      if (
        isTypingTarget(
          event.target
        )
      ) {

        return;

      }


      const key =
        event.key.toLowerCase();


      const index =
        CONFIG.KEY_MAP.indexOf(
          key
        );


      if (
        index === -1 ||
        pressedKeys.has(key)
      ) {

        return;

      }


      pressedKeys.add(
        key
      );


      event.preventDefault();

      togglePadPlayback(
        index
      );

    }
  );


  window.addEventListener(
    "keyup",
    event => {

      pressedKeys.delete(
        event.key.toLowerCase()
      );

    }
  );


  window.addEventListener(
    "blur",
    () => {

      pressedKeys.clear();

    }
  );

}


/* ============================================================
   MIDI
   ============================================================ */

let midiAccess =
  null;

let midiInputs =
  new Map();


async function initializeMIDI() {

  if (
    !navigator.requestMIDIAccess
  ) {

    dom.midiStatus.textContent =
      "Web MIDI no disponible";

    return;

  }


  try {

    midiAccess =
      await navigator.requestMIDIAccess();


    updateMIDIInputs();

    midiAccess.onstatechange =
      updateMIDIInputs;

  } catch (error) {

    console.error(
      "MIDI error:",
      error
    );

    dom.midiStatus.textContent =
      "MIDI no disponible";

  }

}


function updateMIDIInputs() {

  if (!midiAccess) {
    return;
  }


  midiInputs =
    new Map(
      midiAccess.inputs
    );


  const current =
    state.midiInputId;


  dom.midiInputSelect.innerHTML =
    "";


  if (
    midiInputs.size === 0
  ) {

    dom.midiInputSelect.innerHTML =
      `<option value="">Sin dispositivos</option>`;

    dom.midiStatus.textContent =
      "Sin entrada MIDI";

    return;

  }


  midiInputs.forEach(
    input => {

      const option =
        document.createElement(
          "option"
        );

      option.value =
        input.id;

      option.textContent =
        input.name ||
        "MIDI Input";

      dom.midiInputSelect.appendChild(
        option
      );

    }
  );


  if (
    current &&
    midiInputs.has(current)
  ) {

    dom.midiInputSelect.value =
      current;

  } else {

    const first =
      midiInputs.keys().next().value;

    selectMIDIInput(
      first
    );

  }

}


function selectMIDIInput(id) {

  midiInputs.forEach(
    input => {

      input.onmidimessage =
        null;

    }
  );


  state.midiInputId =
    id || "";


  if (!id) {

    dom.midiStatus.textContent =
      "Sin MIDI";

    return;

  }


  const input =
    midiInputs.get(id);


  if (!input) {
    return;
  }


  input.onmidimessage =
    handleMIDIMessage;


  dom.midiStatus.textContent =
    input.name ||
    "MIDI conectado";

}


function handleMIDIMessage(event) {

  const data =
    event.data;


  if (!data || data.length < 2) {
    return;
  }


  const status =
    data[0];

  const command =
    status & 0xf0;

  const note =
    data[1];

  const velocity =
    data[2] || 0;


  /* NOTE ON */

  if (
    command === 0x90 &&
    velocity > 0
  ) {

    const index =
      CONFIG.MIDI_NOTES.indexOf(
        note
      );


    if (index !== -1) {

      togglePadPlayback(
        index
      );

    }

  }


  /* NOTE OFF */

  if (
    command === 0x80 ||
    (
      command === 0x90 &&
      velocity === 0
    )
  ) {

    // Reservado para modo gate futuro.

  }


  /* CC */

  if (
    command === 0xb0
  ) {

    const controller =
      data[1];

    const value =
      data[2];


    const pad =
      pads[state.selectedPad];


    if (
      controller === 112
    ) {

      pad.highpass =
        scaleMIDI(
          value,
          20,
          8000
        );

      updatePadFilters(
        pad
      );

      renderPads();

    }


    if (
      controller === 113
    ) {

      pad.lowpass =
        scaleMIDI(
          value,
          200,
          20000
        );

      updatePadFilters(
        pad
      );

      renderPads();

    }

  }

}


/* ============================================================
   FILTERS
   ============================================================ */

function updatePadFilters(pad) {

  if (!audioCtx) {
    return;
  }


  if (pad.highpassNode) {

    pad.highpassNode.frequency.setTargetAtTime(
      clamp(
        pad.highpass,
        20,
        8000
      ),
      audioCtx.currentTime,
      0.01
    );

  }


  if (pad.lowpassNode) {

    pad.lowpassNode.frequency.setTargetAtTime(
      clamp(
        pad.lowpass,
        200,
        20000
      ),
      audioCtx.currentTime,
      0.01
    );

  }

}


function scaleMIDI(
  value,
  min,
  max
) {

  const normalized =
    value / 127;

  return (
    min +
    (
      max - min
    ) *
    normalized
  );

}


/* ============================================================
   YOUTUBE
   ============================================================ */

function parseYouTubeId(input) {

  if (!input) {
    return null;
  }


  const value =
    input.trim();


  if (
    /^[a-zA-Z0-9_-]{11}$/.test(
      value
    )
  ) {

    return value;

  }


  try {

    const url =
      new URL(
        value
      );


    if (
      url.hostname.includes(
        "youtu.be"
      )
    ) {

      return url.pathname
        .replace(
          "/",
          ""
        )
        .substring(
          0,
          11
        );

    }


    if (
      url.hostname.includes(
        "youtube.com"
      )
    ) {

      return url.searchParams.get(
        "v"
      );

    }

  } catch {}

  return null;

}


function loadYouTubeFromInput(
  index,
  input
) {

  const id =
    parseYouTubeId(
      input
    );


  if (!id) {

    setStatus(
      "URL YOUTUBE INVÁLIDA",
      false
    );

    return;

  }


  const pad =
    pads[index];


  pad.youtubeId =
    id;

  pad.sourceType =
    "youtube";


  createYouTubePlayer(
    pad
  );

}


function createYouTubePlayer(pad) {

  if (
    typeof YT === "undefined" ||
    !YT.Player
  ) {

    setStatus(
      "YOUTUBE API NO LISTA",
      false
    );

    return;

  }


  destroyYouTubePlayer(
    pad
  );


  const playerElement =
    document.createElement(
      "div"
    );


  playerElement.id =
    `yt-pad-${pad.id}`;


  dom.ytPlayersContainer.appendChild(
    playerElement
  );


  pad.youtubePlayer =
    new YT.Player(
      playerElement,
      {

        width: "1280",

        height: "720",

        videoId:
          pad.youtubeId,

        playerVars: {

          controls: 0,

          disablekb: 1,

          rel: 0,

          modestbranding: 1,

          playsinline: 1,

          autoplay: 0

        },

        events: {

          onReady: event => {

            const duration =
              event.target.getDuration();


            if (
              Number.isFinite(
                duration
              ) &&
              duration > 0
            ) {

              pad.maxDuration =
                duration;

              pad.duration =
                Math.min(
                  pad.duration,
                  duration
                );

            }


            setStatus(
              `YOUTUBE PAD ${pad.id + 1} READY`,
              false
            );

            renderPads();

          },


          onStateChange:
            event => {

              if (
                event.data ===
                YT.PlayerState.PLAYING
              ) {

                pad.playing =
                  true;

              }


              if (
                event.data ===
                YT.PlayerState.PAUSED ||
                event.data ===
                YT.PlayerState.ENDED
              ) {

                pad.playing =
                  false;

              }


              updatePadVisualState();

            }

        }

      }
    );

}


/* ============================================================
   YOUTUBE DESTROY
   ============================================================ */

function destroyYouTubePlayer(pad) {

  if (
    pad.youtubePlayer
  ) {

    try {

      pad.youtubePlayer.destroy();

    } catch {}

  }


  pad.youtubePlayer =
    null;

}


/* ============================================================
   CANVAS
   ============================================================ */

function drawStandby() {

  const ctx =
    dom.canvas.getContext(
      "2d"
    );


  ctx.fillStyle =
    "#050505";

  ctx.fillRect(
    0,
    0,
    dom.canvas.width,
    dom.canvas.height
  );


  ctx.fillStyle =
    "#8b92a2";

  ctx.font =
    "20px monospace";

  ctx.textAlign =
    "center";

  ctx.fillText(
    "AV SAMPLER — STANDBY",
    dom.canvas.width / 2,
    dom.canvas.height / 2
  );

}


function renderCanvas() {

  const pad =
    pads[state.visualPad];


  if (
    pad &&
    pad.sourceType === "local" &&
    pad.video &&
    pad.video.readyState >= 2
  ) {

    const ctx =
      dom.canvas.getContext(
        "2d"
      );


    drawVideoContain(
      ctx,
      pad.video,
      dom.canvas
    );

  }


  updateMeters();

  requestAnimationFrame(
    renderCanvas
  );

}


function drawVideoContain(
  ctx,
  media,
  canvas
) {

  const sourceWidth =
    media.videoWidth ||
    canvas.width;

  const sourceHeight =
    media.videoHeight ||
    canvas.height;


  if (
    !sourceWidth ||
    !sourceHeight
  ) {

    return;

  }


  const canvasRatio =
    canvas.width /
    canvas.height;

  const sourceRatio =
    sourceWidth /
    sourceHeight;


  let width =
    canvas.width;

  let height =
    canvas.height;

  let x = 0;

  let y = 0;


  if (
    sourceRatio >
    canvasRatio
  ) {

    height =
      canvas.width /
      sourceRatio;

    y =
      (
        canvas.height -
        height
      ) / 2;

  } else {

    width =
      canvas.height *
      sourceRatio;

    x =
      (
        canvas.width -
        width
      ) / 2;

  }


  ctx.fillStyle =
    "#000";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );


  ctx.drawImage(
    media,
    x,
    y,
    width,
    height
  );

}


/* ============================================================
   METERS
   ============================================================ */

function updateMeters() {

  pads.forEach(
    pad => {

      if (
        pad.playing
      ) {

        pad.meterValue =
          35 +
          Math.random() * 65;

      } else {

        pad.meterValue *=
          0.75;

      }

    }
  );


  const cards =
    dom.padsGrid.children;


  pads.forEach(
    (pad, index) => {

      const card =
        cards[index];

      if (!card) {
        return;
      }


      const meter =
        card.querySelector(
          ".pad-meter-progress"
        );


      if (meter) {

        meter.style.width =
          `${pad.meterValue}%`;

      }

    }
  );

}


/* ============================================================
   PAD VISUAL STATE
   ============================================================ */

function updatePadVisualState() {

  const cards =
    dom.padsGrid.children;


  pads.forEach(
    (pad, index) => {

      const card =
        cards[index];

      if (!card) {
        return;
      }


      card.classList.toggle(
        "selected",
        index === state.selectedPad
      );


      card.classList.toggle(
        "playing",
        pad.playing
      );


      const button =
        card.querySelector(
          ".pad-play-btn"
        );


      if (button) {

        button.textContent =
          pad.playing
            ? "STOP"
            : "PLAY";

        button.classList.toggle(
          "active",
          pad.playing
        );

      }

    }
  );


  updateCanvasStatus();

}


/* ============================================================
   CANVAS STATUS
   ============================================================ */

function updateCanvasStatus() {

  const pad =
    pads[state.visualPad];


  if (!pad) {
    return;
  }


  const source =
    pad.sourceType === "youtube"
      ? "YOUTUBE"
      : "LOCAL";


  dom.canvasOverlayTag.textContent =
    `VIDEO ${pad.id + 1} · ${source}`;


  dom.canvasContainer.classList.toggle(
    "on-air",
    pad.playing
  );

}


/* ============================================================
   STATUS
   ============================================================ */

function setStatus(
  text,
  active
) {

  dom.statusText.textContent =
    text;

  dom.statusDot.classList.toggle(
    "active",
    Boolean(active)
  );

}


/* ============================================================
   PROJECT EXPORT
   ============================================================ */

function exportProject() {

  const project = {

    version: 2,

    app: "AV Sampler",

    createdAt:
      new Date().toISOString(),

    globalBpm:
      state.globalBpm,

    masterVolume:
      state.masterVolume,

    selectedPad:
      state.selectedPad,

    visualPad:
      state.visualPad,

    pads:
      pads.map(
        pad => ({

          id:
            pad.id,

          key:
            pad.key,

          midiNote:
            pad.midiNote,

          sourceType:
            pad.sourceType,

          fileName:
            pad.fileName,

          youtubeId:
            pad.youtubeId,

          trimStart:
            pad.trimStart,

          duration:
            pad.duration,

          playbackRate:
            pad.playbackRate,

          loop:
            pad.loop,

          muted:
            pad.muted,

          solo:
            pad.solo,

          bpm:
            pad.bpm,

          sync:
            pad.sync,

          highpass:
            pad.highpass,

          lowpass:
            pad.lowpass

        })
      )

  };


  const blob =
    new Blob(
      [
        JSON.stringify(
          project,
          null,
          2
        )
      ],
      {
        type:
          "application/json"
      }
    );


  downloadBlob(
    blob,
    `AV_Project_${timestamp()}.json`
  );


  setStatus(
    "PROJECT SAVED",
    false
  );

}


/* ============================================================
   PROJECT IMPORT
   ============================================================ */

async function handleProjectFile(
  event
) {

  const file =
    event.target.files?.[0];

  event.target.value =
    "";

  if (!file) {
    return;
  }


  try {

    const text =
      await file.text();


    const project =
      JSON.parse(
        text
      );


    importProject(
      project,
      file.name
    );

  } catch (error) {

    console.error(
      error
    );

    setStatus(
      "PROJECT ERROR",
      false
    );

  }

}


function importProject(
  project,
  filename
) {

  if (
    !project ||
    !Array.isArray(
      project.pads
    )
  ) {

    throw new Error(
      "Proyecto inválido"
    );

  }


  stopAllPads();


  state.globalBpm =
    clamp(
      Number(
        project.globalBpm
      ) || CONFIG.DEFAULT_BPM,
      20,
      400
    );


  state.masterVolume =
    clamp(
      Number(
        project.masterVolume
      ) || CONFIG.DEFAULT_MASTER_VOLUME,
      0,
      1
    );


  state.selectedPad =
    clampIndex(
      Number(
        project.selectedPad
      )
    );


  state.visualPad =
    clampIndex(
      Number(
        project.visualPad
      )
    );


  dom.masterVolume.value =
    state.masterVolume;


  if (masterGainNode) {

    masterGainNode.gain.value =
      state.masterVolume;

  }


  project.pads.forEach(
    saved => {

      const pad =
        pads[saved.id];

      if (!pad) {
        return;
      }


      pad.sourceType =
        saved.sourceType === "youtube"
          ? "youtube"
          : "local";


      pad.fileName =
        saved.fileName ||
        "Vacío";


      pad.youtubeId =
        saved.youtubeId ||
        "";


      pad.trimStart =
        Number(
          saved.trimStart
        ) || 0;


      pad.duration =
        Number(
          saved.duration
        ) || CONFIG.DEFAULT_PAD_DURATION;


      pad.playbackRate =
        Number(
          saved.playbackRate
        ) || 1;


      pad.loop =
        saved.loop !== false;


      pad.muted =
        Boolean(
          saved.muted
        );


      pad.solo =
        Boolean(
          saved.solo
        );


      pad.bpm =
        Number(
          saved.bpm
        ) || CONFIG.DEFAULT_BPM;


      pad.sync =
        Boolean(
          saved.sync
        );


      pad.highpass =
        Number(
          saved.highpass
        ) || 20;


      pad.lowpass =
        Number(
          saved.lowpass
        ) || 20000;


      if (
        pad.sourceType === "youtube" &&
        pad.youtubeId
      ) {

        createYouTubePlayer(
          pad
        );

      }

    }
  );


  state.activeProjectName =
    filename;


  dom.projectInfo.textContent =
    filename;


  updateGlobalBpmUI();

  updateSelectedPadUI();

  updateAllPadGains();

  renderPads();

  setStatus(
    "PROJECT LOADED",
    false
  );

}


/* ============================================================
   CLEAR PROJECT
   ============================================================ */

function clearProject() {

  if (
    !confirm(
      "¿Limpiar todos los pads?"
    )
  ) {

    return;

  }


  stopAllPads();


  pads.forEach(
    pad => {

      destroyPadMedia(
        pad
      );

      destroyYouTubePlayer(
        pad
      );

      Object.assign(
        pad,
        createPad(
          pad.id
        )
      );

    }
  );


  state.selectedPad =
    0;

  state.visualPad =
    0;

  state.globalBpm =
    CONFIG.DEFAULT_BPM;


  updateGlobalBpmUI();

  updateSelectedPadUI();

  renderPads();

  drawStandby();

  setStatus(
    "PROJECT CLEARED",
    false
  );

}


/* ============================================================
   AUDIO OUTPUT
   ============================================================ */

async function refreshAudioOutputs() {

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.enumerateDevices
  ) {

    return;

  }


  try {

    const devices =
      await navigator.mediaDevices.enumerateDevices();


    const outputs =
      devices.filter(
        device =>
          device.kind ===
          "audiooutput"
      );


    dom.audioOutputSelect.innerHTML =
      `<option value="">
        Predeterminada
      </option>`;


    outputs.forEach(
      device => {

        const option =
          document.createElement(
            "option"
          );

        option.value =
          device.deviceId;

        option.textContent =
          device.label ||
          `Salida ${device.deviceId.substring(0, 6)}`;

        dom.audioOutputSelect.appendChild(
          option
        );

      }
    );

  } catch (error) {

    console.error(
      "No se pudieron enumerar salidas:",
      error
    );

  }

}


async function handleAudioOutputChange(
  event
) {

  const deviceId =
    event.target.value;


  state.audioOutputId =
    deviceId;


  if (
    !audioCtx ||
    typeof audioCtx.setSinkId !==
      "function"
  ) {

    setStatus(
      "SINK ID NO SOPORTADO",
      false
    );

    return;

  }


  try {

    await audioCtx.setSinkId(
      deviceId
    );

    setStatus(
      "AUDIO OUTPUT OK",
      false
    );

  } catch (error) {

    console.error(
      error
    );

    setStatus(
      "AUDIO OUTPUT ERROR",
      false
    );

  }

}


/* ============================================================
   RECORDING
   ============================================================ */

async function toggleRecording() {

  if (
    state.isRecording
  ) {

    stopRecording();

  } else {

    await startRecording();

  }

}


async function startRecording() {

  await resumeAudio();


  if (
    typeof MediaRecorder ===
      "undefined"
  ) {

    setStatus(
      "REC NO SOPORTADO",
      false
    );

    return;

  }


  if (
    !dom.canvas.captureStream
  ) {

    setStatus(
      "CANVAS REC NO SOPORTADO",
      false
    );

    return;

  }


  if (
    recordingDestination
  ) {

    try {

      masterGainNode.disconnect(
        recordingDestination
      );

    } catch {}

  }


  recordingDestination =
    audioCtx.createMediaStreamDestination();


  masterGainNode.connect(
    recordingDestination
  );


  const canvasStream =
    dom.canvas.captureStream(
      60
    );


  const audioTracks =
    recordingDestination
      .stream
      .getAudioTracks();


  const tracks = [
    ...canvasStream.getVideoTracks(),
    ...audioTracks
  ];


  state.recordingStream =
    new MediaStream(
      tracks
    );


  const mimeType =
    getSupportedRecordingMime();


  try {

    state.recorder =
      new MediaRecorder(
        state.recordingStream,
        {

          mimeType,

          videoBitsPerSecond:
            8000000

        }
      );

  } catch (error) {

    console.error(
      error
    );

    cleanupRecording();

    setStatus(
      "REC FORMAT ERROR",
      false
    );

    return;

  }


  state.recordingChunks =
    [];


  state.recorder.ondataavailable =
    event => {

      if (
        event.data &&
        event.data.size > 0
      ) {

        state.recordingChunks.push(
          event.data
        );

      }

    };


  state.recorder.onstop =
    finalizeRecording;


  state.recorder.onerror =
    event => {

      console.error(
        "MediaRecorder:",
        event.error
      );

      cleanupRecording();

      setStatus(
        "REC ERROR",
        false
      );

    };


  state.recorder.start(
    250
  );


  state.isRecording =
    true;

  state.recordingStartedAt =
    Date.now();


  dom.recordButton.textContent =
    "STOP REC";

  dom.recordButton.classList.add(
    "recording"
  );


  dom.recordingStatus.textContent =
    "Grabando";

  dom.recordingTimer.textContent =
    "00:00";


  state.recordingTimer =
    setInterval(
      updateRecordingTimer,
      250
    );


  setStatus(
    "RECORDING",
    true
  );

}


function getSupportedRecordingMime() {

  const formats = [

    "video/webm;codecs=vp9,opus",

    "video/webm;codecs=vp8,opus",

    "video/webm"

  ];


  return (
    formats.find(
      format =>
        MediaRecorder.isTypeSupported(
          format
        )
    ) ||
    ""
  );

}


function stopRecording() {

  if (
    !state.recorder ||
    state.recorder.state ===
      "inactive"
  ) {

    cleanupRecording();

    return;

  }


  state.recorder.stop();

}


function finalizeRecording() {

  const blob =
    new Blob(
      state.recordingChunks,
      {
        type:
          state.recorder.mimeType ||
          "video/webm"
      }
    );


  if (
    blob.size > 0
  ) {

    downloadBlob(
      blob,
      `AV_Session_${timestamp()}.webm`
    );

  }


  cleanupRecording();


  setStatus(
    "RECORDING SAVED",
    false
  );

}


function cleanupRecording() {

  if (
    state.recordingTimer
  ) {

    clearInterval(
      state.recordingTimer
    );

    state.recordingTimer =
      null;

  }


  if (
    recordingDestination &&
    masterGainNode
  ) {

    try {

      masterGainNode.disconnect(
        recordingDestination
      );

    } catch {}

  }


  if (
    state.recordingStream
  ) {

    state.recordingStream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );

  }


  state.recordingStream =
    null;

  recordingDestination =
    null;

  state.recorder =
    null;

  state.recordingChunks =
    [];

  state.isRecording =
    false;


  dom.recordButton.textContent =
    "REC";

  dom.recordButton.classList.remove(
    "recording"
  );


  dom.recordingStatus.textContent =
    "No grabando";

  dom.recordingTimer.textContent =
    "00:00";

}


function updateRecordingTimer() {

  if (
    !state.recordingStartedAt
  ) {
    return;
  }


  const elapsed =
    Math.floor(
      (
        Date.now() -
        state.recordingStartedAt
      ) / 1000
    );


  const minutes =
    Math.floor(
      elapsed / 60
    );


  const seconds =
    elapsed % 60;


  dom.recordingTimer.textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

}


/* ============================================================
   PROJECT / MEDIA UTILITIES
   ============================================================ */

function downloadBlob(
  blob,
  filename
) {

  const url =
    URL.createObjectURL(
      blob
    );


  const anchor =
    document.createElement(
      "a"
    );

  anchor.href =
    url;

  anchor.download =
    filename;


  document.body.appendChild(
    anchor
  );

  anchor.click();

  anchor.remove();


  setTimeout(
    () => {

      URL.revokeObjectURL(
        url
      );

    },
    1000
  );

}


function timestamp() {

  const now =
    new Date();


  const pad =
    value =>
      String(
        value
      ).padStart(
        2,
        "0"
      );


  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") +
  "_" +
  [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");

}


/* ============================================================
   PAD UTILITIES
   ============================================================ */

function clamp(
  value,
  min,
  max
) {

  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );

}


function clampIndex(
  index
) {

  return clamp(
    Number(index) || 0,
    0,
    CONFIG.PAD_COUNT - 1
  );

}


function clampPadTrim(pad) {

  pad.trimStart =
    clamp(
      pad.trimStart,
      0,
      Math.max(
        0,
        pad.maxDuration - 0.01
      )
    );


  const maxLoop =
    Math.max(
      CONFIG.MIN_LOOP_DURATION,
      pad.maxDuration -
      pad.trimStart
    );


  pad.duration =
    clamp(
      pad.duration,
      CONFIG.MIN_LOOP_DURATION,
      maxLoop
    );

}


function clampPadDuration(pad) {

  const max =
    Math.max(
      CONFIG.MIN_LOOP_DURATION,
      pad.maxDuration -
      pad.trimStart
    );


  pad.duration =
    clamp(
      pad.duration,
      CONFIG.MIN_LOOP_DURATION,
      max
    );

}


function updatePadMeter(pad) {

  if (
    !pad.video ||
    !pad.playing
  ) {

    pad.meterValue *=
      0.8;

    return;

  }


  const length =
    pad.duration || 1;


  const position =
    pad.video.currentTime -
    pad.trimStart;


  const normalized =
    clamp(
      position / length,
      0,
      1
    );


  pad.meterValue =
    Math.max(
      10,
      100 *
      (
        1 -
        normalized
      )
    );

}


/* ============================================================
   MEDIA CLEANUP
   ============================================================ */

window.addEventListener(
  "beforeunload",
  () => {

    pads.forEach(
      pad => {

        destroyPadMedia(
          pad
        );

        destroyYouTubePlayer(
          pad
        );

      }
    );


    if (
      state.recordingStream
    ) {

      state.recordingStream
        .getTracks()
        .forEach(
          track =>
            track.stop()
        );

    }

  }
);


/* ============================================================
   GENERAL HELPERS
   ============================================================ */

function isTypingTarget(
  element
) {

  if (!element) {
    return false;
  }


  const tag =
    element.tagName;


  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable
  );

}


/* ============================================================
   LOOP TOGGLE
   ============================================================ */

/*
   Event delegation opcional para futuras extensiones.
   El estado loop se puede modificar directamente desde
   una futura UI avanzada.
*/


/* ============================================================
   INITIAL VISUAL STATE
   ============================================================ */

updateCanvasStatus();
