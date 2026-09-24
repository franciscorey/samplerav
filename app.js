/* ============================================================
   PAD PLAYBACK
   ============================================================ */

async function startPad(n) {
  const pad = getPad(n);

  if (
    !pad ||
    !pad.cueId
  ) {
    status(
      `PAD ${n}: SIN CUE`
    );
    return;
  }

  const cue =
    getCue(pad.cueId);

  const video =
    cueVideo(cue);

  if (
    !cue ||
    !video
  ) {
    status(
      `PAD ${n}: CUE INVÁLIDO`
    );
    return;
  }

  if (
    video.sourceType ===
      "local" &&
    !video.sourceUrl
  ) {
    status(
      "FUENTE LOCAL NO VINCULADA"
    );
    return;
  }

  try {
    await ensureAudio();
  } catch (e) {
    return;
  }

  const engine =
    ensurePadEngine(
      pad,
      video
    );

  const token =
    ++pad.token;

  if (
    video.sourceType ===
    "local"
  ) {
    const el =
      engine.videoEl;

    const begin = () => {
      if (
        token !== pad.token
      ) {
        return;
      }

      try {
        el.currentTime =
          clamp(
            cue.startTime,
            0,
            Math.max(
              0,
              el.duration ||
                cue.startTime
            )
          );

        el.playbackRate =
          effectiveRate(
            pad
          );

        el.preservesPitch =
          false;

      } catch (e) {}

      el.play()
        .then(() => {
          if (
            token !==
            pad.token
          ) {
            return;
          }

          pad.playing = true;

          activateVisual(
            pad
          );

          updatePadTile(
            pad
          );

          status(
            `PLAY PAD ${n}`,
            true
          );
        })
        .catch(() => {
          status(
            `PAD ${n}: PLAY BLOQUEADO`
          );
        });
    };

    if (
      el.readyState >= 1
    ) {
      begin();
    } else {
      el.addEventListener(
        "loadedmetadata",
        begin,
        { once: true }
      );
    }

  } else {
    const attempt =
      () => {
        if (
          token !==
          pad.token
        ) {
          return;
        }

        const player =
          engine.player;

        if (
          !engine.ready ||
          !player
        ) {
          setTimeout(
            attempt,
            100
          );

          return;
        }

        try {
          player.seekTo(
            cue.startTime,
            true
          );

          player.setPlaybackRate(
            Math.min(
              2,
              Math.max(
                0.25,
                effectiveRate(
                  pad
                )
              )
            )
          );

          updateYTVolume(
            pad
          );

          player.playVideo();

          pad.playing =
            true;

          activateVisual(
            pad
          );

          updatePadTile(
            pad
          );

          status(
            `PLAY PAD ${n}`,
            true
          );

        } catch (e) {
          status(
            `PAD ${n}: YOUTUBE ERROR`
          );
        }
      };

    attempt();
  }
}

function stopPad(n) {
  const p =
    getPad(n);

  if (!p) {
    return;
  }

  p.token++;

  if (
    p.engine?.videoEl
  ) {
    try {
      p.engine.videoEl.pause();
    } catch (e) {}
  }

  if (
    p.engine?.player
  ) {
    try {
      p.engine.player.pauseVideo();
    } catch (e) {}
  }

  p.playing = false;

  removeVisual(
    p.id
  );

  updatePadTile(
    p
  );

  renderCanvas();
}

function pressPad(n) {
  const p =
    getPad(n);

  if (!p) {
    return;
  }

  if (
    p.playMode ===
    "gate"
  ) {
    if (!p.playing) {
      startPad(n);
    }
  } else {
    if (p.playing) {
      stopPad(n);
    } else {
      startPad(n);
    }
  }
}

function releasePad(n) {
  const p =
    getPad(n);

  if (
    p &&
    p.playMode ===
      "gate"
  ) {
    stopPad(n);
  }
}

function effectiveRate(p) {
  return p.sync &&
    p.bpm > 0
    ? clamp(
        (state.bpm /
          p.bpm) *
          p.playbackRate,
        0.25,
        4
      )
    : p.playbackRate;
}

/* ============================================================
   VISUALIZER
   ============================================================ */

function activateVisual(pad) {
  if (
    pad.visualMode ===
    "hidden"
  ) {
    return;
  }

  let list =
    state.visualSources.filter(
      n => n !== pad.id
    );

  list.push(
    pad.id
  );

  const max =
    CONFIG.VIS_LIMIT[
      state.visualizerMode
    ] || 1;

  while (
    list.length >
    max
  ) {
    const auto =
      list.findIndex(
        n => {
          const p =
            getPad(n);

          return (
            p &&
            p.visualMode !==
              "visible"
          );
        }
      );

    list.splice(
      auto >= 0
        ? auto
        : 0,
      1
    );
  }

  state.visualSources =
    list;
}

function removeVisual(n) {
  state.visualSources =
    state.visualSources.filter(
      x => x !== n
    );
}

function setVisualMode(mode) {
  if (
    !CONFIG.VIS_LIMIT[
      mode
    ]
  ) {
    return;
  }

  state.visualizerMode =
    mode;

  state.visualSources =
    state.visualSources.slice(
      -CONFIG.VIS_LIMIT[
        mode
      ]
    );

  renderVisualButtons();
  renderCanvas();
}

function visualCells(
  mode,
  w,
  h
) {
  if (
    mode ===
    "split2"
  ) {
    return [
      {
        x: 0,
        y: 0,
        w: w / 2,
        h
      },
      {
        x: w / 2,
        y: 0,
        w: w / 2,
        h
      }
    ];
  }

  if (
    mode ===
    "split4"
  ) {
    return [
      {
        x: 0,
        y: 0,
        w: w / 2,
        h: h / 2
      },
      {
        x: w / 2,
        y: 0,
        w: w / 2,
        h: h / 2
      },
      {
        x: 0,
        y: h / 2,
        w: w / 2,
        h: h / 2
      },
      {
        x: w / 2,
        y: h / 2,
        w: w / 2,
        h: h / 2
      }
    ];
  }

  return [
    {
      x: 0,
      y: 0,
      w,
      h
    }
  ];
}

function drawCellLabel(
  ctx,
  c,
  t
) {
  ctx.fillStyle =
    "rgba(0,0,0,.65)";

  ctx.fillRect(
    c.x + 7,
    c.y + 7,
    100,
    19
  );

  ctx.fillStyle =
    "#00ffcc";

  ctx.font =
    "11px JetBrains Mono,monospace";

  ctx.fillText(
    t,
    c.x + 12,
    c.y + 20
  );
}

function renderCanvas() {
  const c =
    dom.canvas;

  if (!c) {
    return;
  }

  const ctx =
    c.getContext(
      "2d"
    );

  const w =
    c.width;

  const h =
    c.height;

  ctx.fillStyle =
    "#08090b";

  ctx.fillRect(
    0,
    0,
    w,
    h
  );

  /*
    Cue preview has priority and always
    uses the single visor.
  */

  if (
    state.preview.playing
  ) {
    if (
      dom.placeholder
    ) {
      dom.placeholder.hidden =
        true;
    }

    const v =
      getVideo(
        state.preview.videoId
      );

    if (
      v?.sourceType ===
        "local" &&
      v.editorEl?.readyState >=
        2
    ) {
      ctx.drawImage(
        v.editorEl,
        0,
        0,
        w,
        h
      );

      drawCellLabel(
        ctx,
        {
          x: 0,
          y: 0
        },
        `PREVIEW · ${v.name}`
      );

      return;
    }

    if (
      v?.sourceType ===
      "youtube"
    ) {
      drawYTCanvasNotice(
        ctx,
        w,
        h,
        v
      );

      return;
    }
  }

  const active =
    state.visualSources
      .map(getPad)
      .filter(
        p => p?.playing
      );

  if (
    dom.placeholder
  ) {
    dom.placeholder.hidden =
      active.length === 0;
  }

  if (
    !active.length
  ) {
    ctx.fillStyle =
      "#111318";

    ctx.fillRect(
      0,
      0,
      w,
      h
    );

    ctx.fillStyle =
      "#555";

    ctx.font =
      "14px JetBrains Mono,monospace";

    ctx.textAlign =
      "center";

    ctx.fillText(
      "VISOR EN ESPERA",
      w / 2,
      h / 2
    );

    ctx.textAlign =
      "left";

    return;
  }

  const cells =
    visualCells(
      state.visualizerMode,
      w,
      h
    );

  active.forEach(
    (p, i) => {
      const cell =
        cells[i];

      if (!cell) {
        return;
      }

      const cue =
        getCue(
          p.cueId
        );

      const v =
        cueVideo(cue);

      if (
        v?.sourceType ===
          "local" &&
        p.engine?.videoEl
          ?.readyState >= 2
      ) {
        ctx.drawImage(
          p.engine.videoEl,
          cell.x,
          cell.y,
          cell.w,
          cell.h
        );
      } else {
        drawYTCanvasNotice(
          ctx,
          cell.w,
          cell.h,
          v,
          cell.x,
          cell.y
        );
      }

      drawCellLabel(
        ctx,
        cell,
        `PAD ${p.id} · ${v?.name || ""}`
      );
    }
  );
}

function drawYTCanvasNotice(
  ctx,
  w,
  h,
  v,
  x = 0,
  y = 0
) {
  ctx.fillStyle =
    "#17131c";

  ctx.fillRect(
    x,
    y,
    w,
    h
  );

  ctx.fillStyle =
    "#ff4d5e";

  ctx.font =
    "bold 15px JetBrains Mono,monospace";

  ctx.textAlign =
    "center";

  ctx.fillText(
    "YOUTUBE",
    x + w / 2,
    y + h / 2 - 5
  );

  ctx.fillStyle =
    "#aaa";

  ctx.font =
    "11px JetBrains Mono,monospace";

  ctx.fillText(
    "no puede entrar al canvas",
    x + w / 2,
    y + h / 2 + 18
  );

  ctx.textAlign =
    "left";
}

/* ============================================================
   EDITOR PREVIEW
   ============================================================ */

function ensureEditor(video) {
  if (
    video.sourceType !==
    "local"
  ) {
    return null;
  }

  if (
    video.editorEl
  ) {
    return video.editorEl;
  }

  const el =
    document.createElement(
      "video"
    );

  el.src =
    video.sourceUrl || "";

  el.preload =
    "auto";

  el.playsInline =
    true;

  el.muted =
    false;

  el.controls =
    false;

  el.crossOrigin =
    "anonymous";

  video.editorEl =
    el;

  dom.videoBank.appendChild(
    el
  );

  el.addEventListener(
    "loadedmetadata",
    () => {
      video.duration =
        el.duration ||
        video.duration;

      renderAll();
    }
  );

  if (audioCtx) {
    connectEditorAudio(
      video,
      el
    );
  }

  return el;
}

function previewCue(cue) {
  if (!cue) {
    return;
  }

  const v =
    cueVideo(cue);

  if (!v) {
    return;
  }

  stopPreview();

  state.preview = {
    videoId: v.id,
    playing: true,
    end: cue.endTime
  };

  if (
    v.sourceType ===
    "local"
  ) {
    const el =
      ensureEditor(v);

    if (!el) {
      return;
    }

    ensureAudio()
      .then(() => {
        connectEditorAudio(
          v,
          el
        );

        el.currentTime =
          cue.startTime;

        el.play().catch(
          () => {}
        );
      });

  } else {
    state.preview.playing =
      true;

    dom.ytMonitor.innerHTML =
      "";

    const iframe =
      document.createElement(
        "iframe"
      );

    iframe.className =
      "yt-preview-frame";

    iframe.src =
      `https://www.youtube.com/embed/${v.youtubeId}?autoplay=1&start=${Math.floor(
        cue.startTime
      )}&controls=1&playsinline=1`;

    iframe.allow =
      "autoplay; encrypted-media";

    dom.ytMonitor.appendChild(
      iframe
    );

    dom.ytMonitor.classList.add(
      "preview-active"
    );
  }

  renderCanvas();
}

function stopPreview() {
  const v =
    getVideo(
      state.preview.videoId
    );

  if (
    v?.editorEl
  ) {
    try {
      v.editorEl.pause();
    } catch (e) {}
  }

  state.preview = {
    videoId: null,
    playing: false,
    end: 0
  };

  dom.ytMonitor?.classList.remove(
    "preview-active"
  );

  if (dom.ytMonitor) {
    dom.ytMonitor.innerHTML =
      "";
  }
}

/* ============================================================
   PLAYLIST
   ============================================================ */

function selectVideo(vid) {
  stopPreview();

  state.selectedVideoId =
    vid;

  state.selectedCueId =
    null;

  state.playhead =
    0;

  const v =
    getVideo(vid);

  if (
    v &&
    v.sourceType ===
      "local"
  ) {
    ensureEditor(v);
  }

  renderAll();
}

function addLocalFile(file) {
  if (
    !file ||
    (
      !file.type.startsWith(
        "video/"
      ) &&
      !file.type.startsWith(
        "audio/"
      )
    )
  ) {
    toast(
      "Selecciona un video o audio compatible"
    );

    return;
  }

  const v =
    makeVideo({
      name: file.name,
      sourceType: "local",
      sourceUrl:
        URL.createObjectURL(
          file
        ),
      fileName:
        file.name
    });

  videos.push(v);

  state.selectedVideoId =
    v.id;

  state.selectedCueId =
    null;

  ensureEditor(v);

  toast(
    "Video agregado"
  );

  renderAll();
}

function handleLocal(e) {
  const f =
    e.target.files?.[0];

  e.target.value =
    "";

  if (f) {
    addLocalFile(f);
  }
}

function addYouTube() {
  const raw =
    dom.ytUrl.value.trim();

  const yt =
    extractYT(raw);

  if (!yt) {
    toast(
      "URL de YouTube no válida"
    );

    return;
  }

  const v =
    makeVideo({
      name:
        `YouTube · ${yt}`,
      sourceType:
        "youtube",
      youtubeId:
        yt
    });

  videos.push(v);

  state.selectedVideoId =
    v.id;

  state.selectedCueId =
    null;

  dom.ytUrl.value =
    "";

  toast(
    "YouTube agregado"
  );

  renderAll();
}

function extractYT(url) {
  const m =
    String(url).match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{11})/
    );

  return m
    ? m[1]
    : /^[\w-]{11}$/.test(
        url
      )
      ? url
      : "";
}

function relinkSelectedFile(
  file
) {
  const v =
    selectedVideo();

  if (
    !v ||
    v.sourceType !==
      "local" ||
    !file
  ) {
    return;
  }

  if (
    v.sourceUrl
  ) {
    URL.revokeObjectURL(
      v.sourceUrl
    );
  }

  v.sourceUrl =
    URL.createObjectURL(
      file
    );

  v.fileName =
    file.name;

  v.name =
    v.name ||
    file.name;

  v.linked =
    true;

  if (v.editorEl) {
    try {
      v.editorEl.pause();
      v.editorEl.remove();
    } catch (e) {}
  }

  v.editorEl =
    null;

  v.editorSource =
    null;

  v.editorGain =
    null;

  ensureEditor(v);

  toast(
    "Fuente local vinculada"
  );

  renderAll();
}

function relinkFileHandler(e) {
  const f =
    e.target.files?.[0];

  e.target.value =
    "";

  if (f) {
    relinkSelectedFile(
      f
    );
  }
}

function removeVideo() {
  const v =
    selectedVideo();

  if (!v) {
    return;
  }

  const assigned =
    pads.filter(
      p =>
        v.cues.some(
          c =>
            c.id ===
            p.cueId
        )
    );

  assigned.forEach(
    p => {
      stopPad(p.id);
      p.cueId = null;
    }
  );

  if (
    v.sourceUrl
  ) {
    URL.revokeObjectURL(
      v.sourceUrl
    );
  }

  if (
    v.editorEl
  ) {
    try {
      v.editorEl.pause();
      v.editorEl.remove();
    } catch (e) {}
  }

  const i =
    videos.indexOf(v);

  if (i >= 0) {
    videos.splice(
      i,
      1
    );
  }

  state.selectedVideoId =
    videos[0]?.id ||
    null;

  state.selectedCueId =
    null;

  renderAll();
}

function renameVideo() {
  const v =
    selectedVideo();

  if (!v) {
    return;
  }

  const n =
    prompt(
      "Nombre del video:",
      v.name
    );

  if (
    n?.trim()
  ) {
    v.name =
      n.trim();

    renderAll();
  }
}

function renderPlaylist() {
  const sv =
    selectedVideo();

  if (
    dom.selectedVideoName
  ) {
    dom.selectedVideoName.textContent =
      sv
        ? sv.name
        : "Ningún video seleccionado";
  }

  if (
    dom.selectedVideoMeta
  ) {
    dom.selectedVideoMeta.textContent =
      sv
        ? sv.sourceType ===
          "youtube"
          ? "YOUTUBE"
          : fmt(sv.duration)
        : "—";
  }

  if (dom.relink) {
    dom.relink.hidden = !(
      sv &&
      sv.sourceType ===
        "local" &&
      !sv.linked
    );
  }

  if (
    !dom.playlist
  ) {
    return;
  }

  dom.playlist.innerHTML =
    "";

  dom.playlistCount.textContent =
    `${videos.length} VIDEO${
      videos.length === 1
        ? ""
        : "S"
    }`;

  videos.forEach(
    v => {
      const row =
        document.createElement(
          "div"
        );

      row.className =
        "playlist-item";

      if (
        v.id ===
        state.selectedVideoId
      ) {
        row.classList.add(
          "selected"
        );
      }

      const main =
        document.createElement(
          "button"
        );

      main.type =
        "button";

      main.className =
        "playlist-main";

      main.innerHTML =
        `<span class="source-dot ${v.sourceType}"></span>` +
        `<span class="playlist-name">${escapeHTML(
          v.name
        )}</span>` +
        `<span class="playlist-meta">${
          v.sourceType ===
          "youtube"
            ? "YT"
            : fmt(v.duration)
        }</span>`;

      main.onclick =
        () =>
          selectVideo(
            v.id
          );

      const x =
        document.createElement(
          "button"
        );

      x.type =
        "button";

      x.className =
        "playlist-delete";

      x.textContent =
        "×";

      x.title =
        "Eliminar";

      x.onclick =
        e => {
          e.stopPropagation();

          state.selectedVideoId =
            v.id;

          removeVideo();
        };

      row.append(
        main,
        x
      );

      dom.playlist.appendChild(
        row
      );
    }
  );
}

function escapeHTML(s) {
  return String(
    s
  ).replace(
    /[&<>"']/g,
    c =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[c])
  );
}
