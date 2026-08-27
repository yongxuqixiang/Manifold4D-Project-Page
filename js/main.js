/* Manifold4D project page - interactive video comparisons */
"use strict";

/* ------------------------------------------------------------------ utils */
const METHOD_LABELS = {
  source: "Source video",
  render: "Point cloud render",
  ours: "Manifold4D (Ours)",
  vista4d: "Vista4D",
  recammaster: "ReCamMaster",
  trajectorycrafter: "TrajectoryCrafter",
  gen3c: "GEN3C",
  render_corrupt: "Corrupted render",
  ours_corrupt: "Manifold4D (corrupted render)",
  ours_clean: "Manifold4D (clean render)",
  gen3c_corrupt: "GEN3C (corrupted render)",
  trajcrafter_corrupt: "TrajectoryCrafter (corrupted render)",
};

const ROBUST_ORDER = [
  "source",
  "render_corrupt",
  "gen3c_corrupt",
  "trajcrafter_corrupt",
  "ours_corrupt",
  "ours_clean",
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/* --------------------------------------------------- synchronized playback */
class SyncGroup {
  constructor() {
    this.videos = [];
    this.leader = null;
    this.onStateChange = null;
    this._boundTick = () => this._tick();
    this._boundEnded = () => this._onEnded();
  }

  attach(videos) {
    this.destroy();
    this.videos = videos;
    this.leader = videos[0] || null;
    if (!this.leader) return;
    this.leader.addEventListener("timeupdate", this._boundTick);
    this.leader.addEventListener("ended", this._boundEnded);
  }

  destroy() {
    if (this.leader) {
      this.leader.removeEventListener("timeupdate", this._boundTick);
      this.leader.removeEventListener("ended", this._boundEnded);
    }
    this.videos.forEach((v) => v.pause());
    this.videos = [];
    this.leader = null;
  }

  play() {
    if (!this.videos.length) return;
    const t = this.leader.currentTime;
    for (const v of this.videos) {
      if (Math.abs(v.currentTime - t) > 0.25) v.currentTime = t;
      v.play().catch(() => {});
    }
    this._notify();
  }

  pause() {
    this.videos.forEach((v) => v.pause());
    this._notify();
  }

  seek(frac) {
    if (!this.leader || !isFinite(this.leader.duration)) return;
    const t = frac * this.leader.duration;
    this.videos.forEach((v) => {
      try { v.currentTime = Math.min(t, (v.duration || t) - 0.02); } catch (e) { /* noop */ }
    });
  }

  get playing() {
    return !!(this.leader && !this.leader.paused && !this.leader.ended);
  }

  _notify() {
    if (this.onStateChange) this.onStateChange(this.playing);
  }

  _tick() {
    // drift correction: followers trail the leader
    const t = this.leader.currentTime;
    for (let i = 1; i < this.videos.length; i++) {
      const v = this.videos[i];
      if (!v.paused && Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
    }
  }

  _onEnded() {
    // manual loop: restart the whole reel together
    this.videos.forEach((v) => {
      try { v.currentTime = 0; } catch (e) { /* noop */ }
    });
    this.play();
  }
}

/* ------------------------------------------------------- player bar widget */
function makePlayerBar(group, onUserAction) {
  const playBtn = el("button", { class: "play-btn", "aria-label": "play/pause" });
  const slider = el("input", { type: "range", min: "0", max: "1000", value: "0" });
  const timeLabel = el("span", { class: "time", text: "0.0 / 0.0 s" });
  const bar = el("div", { class: "player-bar" }, playBtn, slider, timeLabel);

  const setIcon = (playing) => {
    playBtn.textContent = playing ? "❚❚" : "▶";
  };
  setIcon(group.playing);
  group.onStateChange = setIcon;

  playBtn.addEventListener("click", () => {
    const wantsPlay = !group.playing;
    wantsPlay ? group.play() : group.pause();
    // report explicit user intent so autoplay logic can respect it
    if (onUserAction) onUserAction(wantsPlay);
  });
  slider.addEventListener("input", () => {
    group.seek(slider.value / 1000);
  });

  // update slider & time from the group leader
  const timer = setInterval(() => {
    const l = group.leader;
    if (!l) return;
    const dur = isFinite(l.duration) ? l.duration : 0;
    const cur = isFinite(l.currentTime) ? l.currentTime : 0;
    if (dur > 0 && !slider.matches(":active")) {
      slider.value = Math.round((cur / dur) * 1000);
    }
    timeLabel.textContent = `${cur.toFixed(1)} / ${dur.toFixed(1)} s`;
  }, 120);

  // expose cleanup so the section can drop the interval on re-render
  bar._dispose = () => clearInterval(timer);
  return bar;
}

/* --------------------------------------------------------- video card grid */
function makeVideoCard(src, label, kind) {
  const video = el("video", {
    src,
    muted: "",
    playsinline: "",
    preload: "auto",
    disablepictureinpicture: "",
  });
  // retry once on transient load failures (dev servers can hiccup on
  // concurrent range requests); a genuine 404 stops after the first retry
  video.addEventListener("error", () => {
    if (video.dataset.retried) return;
    video.dataset.retried = "1";
    video.load();
  });
  const card = el("div", { class: `video-card ${kind || ""}` }, video, el("span", { class: "tag", text: label }));
  card._video = video;
  return card;
}

/* ----------------------------------------------------- section stage helper */
class Section {
  constructor(stageEl, buildCards) {
    this.stage = stageEl;
    this.buildCards = buildCards; // (data) -> [{card, kind}]
    this.group = new SyncGroup();
    this.bar = null;
    // userPaused is touched ONLY by explicit user actions (the play button);
    // viewport-driven pauses never set it, so autoplay intent survives both
    // scrolling away and switching scenes.
    this.userPaused = false;
    this.inView = false;
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          this.inView = e.isIntersecting;
          if (e.isIntersecting) {
            this.autoPlayIfReady();
          } else if (this.group.playing) {
            this.group.pause();
          }
        }
      },
      { threshold: 0.35 }
    );
  }

  autoPlayIfReady() {
    if (this.userPaused || this.group.playing) return;
    const first = this.group.videos[0];
    if (!first) return;
    if (first.readyState >= 2) {
      this.group.play();
    } else {
      first.addEventListener(
        "canplay",
        () => {
          if (!this.userPaused && this.inView) this.group.play();
        },
        { once: true }
      );
    }
  }

  render(data) {
    this.group.destroy();
    if (this.bar && this.bar._dispose) this.bar._dispose();
    this.stage.innerHTML = "";

    const cards = this.buildCards(data);
    const grid = el("div", { class: "video-grid " + (this.gridClass(cards.length) || "") });
    cards.forEach((c) => grid.appendChild(c.card));
    const videos = cards.map((c) => c.card._video);
    this.group.attach(videos);
    this.bar = makePlayerBar(this.group, (wantsPlay) => {
      this.userPaused = !wantsPlay;
    });

    this.stage.appendChild(grid);
    this.stage.appendChild(this.bar);
    this.stage.appendChild(
      el("p", { class: "scene-hint", text: "Videos are synchronized — use the timeline or click ▶ to play the reel." })
    );

    // re-observing fires a fresh callback with the current intersection state,
    // which either autoplays (visible) or pauses (hidden)
    this._observer.disconnect();
    this._observer.observe(this.stage);
    // if already visible the callback may arrive async; also kick directly
    if (this.inView) this.autoPlayIfReady();
  }

  gridClass(n) {
    if (n === 5) return "cols-5";
    if (n === 6) return "cols-3";
    if (n <= 2) return "cols-2";
    return "";
  }
}

/* ------------------------------------------------------------- chip helpers */
function makeChipRow(container, items, onPick) {
  container.innerHTML = "";
  const chips = items.map((item, idx) => {
    const chip = el("button", {
      class: "chip" + (idx === 0 ? " active" : ""),
      text: item.label,
      type: "button",
    });
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      onPick(item);
    });
    container.appendChild(chip);
    return chip;
  });
}

/* ------------------------------------------------------------------- main */
async function main() {
  let data;
  try {
    const res = await fetch("data/videos.json");
    data = await res.json();
  } catch (err) {
    console.error("Failed to load videos.json", err);
    return;
  }

  buildGallery(data);
  buildYawSweep(data);
  buildRobustness(data);
  setupBibtex();
}

/* ----------------------------------------------------------------- gallery */
function buildGallery(data) {
  const filterRow = document.getElementById("gallery-filters");
  const sceneRow = document.getElementById("gallery-scenes");
  const stage = document.getElementById("gallery-stage");
  const section = new Section(stage, (scene) => {
    const order = ["source", "render", "ours", "vista4d", "recammaster", "trajectorycrafter", "gen3c"];
    return order
      .filter((m) => scene.files[m])
      .map((m) => {
        const kind = m === "ours" ? "ours" : m === "source" || m === "render" ? "ref" : "";
        return { card: makeVideoCard(scene.files[m], METHOD_LABELS[m], kind) };
      });
  });

  let currentScenes = data.gallery;

  makeChipRow(
    filterRow,
    [
      { label: "All", bench: "All" },
      { label: "DAVIS-Traj", bench: "DAVIS-Traj" },
      { label: "Vista4D-Eval", bench: "Vista4D-Eval" },
    ],
    (item) => {
      currentScenes = item.bench === "All"
        ? data.gallery
        : data.gallery.filter((s) => s.benchmark === item.bench);
      renderSceneChips();
    }
  );

  function renderSceneChips() {
    makeChipRow(
      sceneRow,
      currentScenes.map((s) => ({
        label: `${s.label} · ${s.benchmark === "DAVIS-Traj" ? "DAVIS" : "Vista4D"}`,
        scene: s,
      })),
      (item) => section.render(item.scene)
    );
    if (currentScenes.length) section.render(currentScenes[0]);
  }
  renderSceneChips();
}

/* --------------------------------------------------------------- yaw sweep */
function buildYawSweep(data) {
  const sceneRow = document.getElementById("yaw-scenes");
  const stage = document.getElementById("yaw-stage");
  const slider = document.getElementById("yaw-slider");
  const valueLabel = document.getElementById("yaw-value");

  const section = new Section(stage, (payload) => {
    const order = ["render", "ours", "gen3c", "vista4d", "trajectorycrafter"];
    return order
      .filter((m) => payload.methods[m] && payload.methods[m][String(payload.angle)])
      .map((m) => {
        const src = payload.methods[m][String(payload.angle)];
        const kind = m === "ours" ? "ours" : m === "render" ? "ref" : "";
        return { card: makeVideoCard(src, METHOD_LABELS[m], kind) };
      });
  });

  let state = { sceneIdx: 0, angle: 10 };

  function render() {
    const scene = data.yaw_sweep.scenes[state.sceneIdx];
    section.render({ methods: scene.methods, angle: state.angle });
    valueLabel.textContent = `±${state.angle}°`;
  }

  makeChipRow(
    sceneRow,
    data.yaw_sweep.scenes.map((s, i) => ({ label: s.label, idx: i })),
    (item) => {
      state.sceneIdx = item.idx;
      render();
    }
  );

  slider.addEventListener("input", () => {
    state.angle = parseInt(slider.value, 10);
    render();
  });

  render();
}

/* -------------------------------------------------------------- robustness */
function buildRobustness(data) {
  const sceneRow = document.getElementById("robust-scenes");
  const stage = document.getElementById("robust-stage");

  const section = new Section(stage, (scene) => {
    return ROBUST_ORDER
      .filter((m) => scene.files[m])
      .map((m) => {
        const kind = m.startsWith("ours") ? "ours" : m === "source" || m === "render_corrupt" ? "ref" : "";
        return { card: makeVideoCard(scene.files[m], METHOD_LABELS[m], kind) };
      });
  });

  makeChipRow(
    sceneRow,
    data.robustness.map((s) => ({ label: s.label, scene: s })),
    (item) => section.render(item.scene)
  );
  if (data.robustness.length) section.render(data.robustness[0]);
}

/* ----------------------------------------------------------------- bibtex */
function setupBibtex() {
  const btn = document.getElementById("bibtex-copy");
  const text = document.getElementById("bibtex-text").textContent;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    btn.textContent = "Copied!";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("done");
    }, 1600);
  });
}

main();
