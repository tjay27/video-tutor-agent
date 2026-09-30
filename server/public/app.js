// Video Tutor: main web UI (vanilla JS, no build step).
// Sections: utils · toasts · library · add-video job · routing · player · transcript ·
// call (mic, playback, WebSocket protocol) · timeline · keyboard · debug hook.

const MIC_RATE = 16000; // what the server's STT expects
const TTS_RATE = 24000; // tutor audio from the server
const FRAME_SAMPLES = MIC_RATE / 20; // 50 ms
const ZERO_FRAME = new ArrayBuffer(FRAME_SAMPLES * 2);
const DUCK_GAIN = 0.25;
const RAMP = 0.15;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isYouTubeId = (id) => /^[A-Za-z0-9_-]{11}$/.test(id ?? "");
const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function parseTs(str) {
  const parts = str.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const LANGS = {
  "en-IN": "English", "hi-IN": "Hindi", "bn-IN": "Bengali", "ta-IN": "Tamil", "te-IN": "Telugu",
  "kn-IN": "Kannada", "ml-IN": "Malayalam", "mr-IN": "Marathi", "gu-IN": "Gujarati", "pa-IN": "Punjabi",
  "od-IN": "Odia", "or-IN": "Odia", en: "English", hi: "Hindi",
};
const langName = (code) => (code ? LANGS[code] ?? LANGS[code.split("-")[0]] ?? code : "");
function sourceBadge(source) {
  if (!source) return "";
  if (/sarvam|stt/i.test(source)) return `<span class="badge src-stt">Sarvam STT</span>`;
  if (/caption/i.test(source)) return `<span class="badge src-cap">Captions</span>`;
  return `<span class="badge">${esc(source === "manual" ? "Sample" : source)}</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json", ...(opts.headers ?? {}) } : opts.headers,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- toasts
function toast(message, kind = "error", ms = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "ok" ? "check" : "warn")}<div>${esc(message)}</div>`;
  $("toasts").append(el);
  const remove = () => { el.classList.add("out"); setTimeout(() => el.remove(), 250); };
  el.addEventListener("click", remove);
  setTimeout(remove, ms);
}

// ---------------------------------------------------------------- library
let library = [];
async function loadLibrary() {
  try {
    const { data } = await api("/api/transcripts");
    library = Array.isArray(data) ? data : [];
  } catch (e) {
    library = [];
    toast(`Couldn't load your library: ${e.message}`);
  }
  renderLibrary();
}
function thumbHtml(id, cls = "card-thumb") {
  return isYouTubeId(id)
    ? `<div class="${cls}"><img src="${thumbUrl(id)}" alt="" loading="lazy" /><span class="card-play">${icon("play")}</span></div>`
    : `<div class="${cls} placeholder-art">${icon("book")}<span class="card-play">${icon("play")}</span></div>`;
}
function renderLibrary() {
  const el = $("library");
  $("libCount").textContent = library.length ? `${library.length} video${library.length === 1 ? "" : "s"}` : "";
  if (!library.length) {
    el.innerHTML = `<div class="lib-empty">No videos yet. Paste a YouTube link above to get started.</div>`;
    return;
  }
  el.innerHTML = library.map((v) => `
    <button class="card" data-id="${esc(v.videoId)}" aria-label="Open ${esc(v.title ?? v.videoId)}">
      ${thumbHtml(v.videoId)}
      <div class="card-body">
        <div class="card-title">${esc(v.title ?? v.videoId)}</div>
        <div class="badges">
          ${v.language ? `<span class="badge lang">${esc(langName(v.language))}</span>` : ""}
          ${sourceBadge(v.source)}
          ${v.segmentCount ? `<span class="badge">${v.segmentCount} segments</span>` : ""}
        </div>
      </div>
    </button>`).join("");
}
$("library").addEventListener("click", (e) => {
  const card = e.target.closest(".card[data-id]");
  if (card) location.hash = `#/v/${encodeURIComponent(card.dataset.id)}`;
});

// ---------------------------------------------------------------- add video
const STAGE_INDEX = { queued: 0, fetching_info: 0, downloading: 1, transcribing: 2, building: 3, ready: 4 };
let jobTimer = null;
let jobRunning = false;

function setJobStep(stage, failed = false) {
  const idx = STAGE_INDEX[stage] ?? 0;
  document.querySelectorAll("#stepper li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx && !failed);
    li.classList.toggle("failed", i === idx && failed);
  });
  const pct = stage === "ready" ? 100 : Math.min(96, (idx + 0.5) * 25);
  $("jobBar").style.width = `${pct}%`;
}
function showJobInfo(job) {
  if (job.title) $("jobTitle").textContent = job.title;
  const id = job.videoId;
  if (isYouTubeId(id)) {
    const img = $("jobThumb");
    if (img.dataset.id !== id) { img.src = thumbUrl(id); img.dataset.id = id; }
    img.hidden = false;
    $("jobThumbPh").hidden = true;
  }
}
function showWarnings(el, warnings) {
  if (!warnings?.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = `${icon("warn")}<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
  el.hidden = false;
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (jobRunning) return;
  const url = $("urlInput").value.trim();
  const errEl = $("addError");
  errEl.hidden = true;
  if (!url) { errEl.textContent = "Paste a YouTube link first."; errEl.hidden = false; $("urlInput").focus(); return; }

  jobRunning = true;
  const btn = $("addBtn");
  btn.disabled = true;
  btn.classList.add("is-loading");
  const panel = $("jobPanel");
  panel.hidden = false;
  panel.classList.remove("is-done", "is-failed");
  $("jobTitle").textContent = "Getting ready…";
  $("jobSub").textContent = "This usually takes about 40 seconds.";
  $("jobThumb").hidden = true; $("jobThumb").dataset.id = "";
  $("jobThumbPh").hidden = false;
  showWarnings($("jobWarnings"), null);
  setJobStep("queued");

  const started = Date.now();
  clearInterval(jobTimer);
  const tick = () => ($("jobTimer").textContent = fmtTime((Date.now() - started) / 1000));
  tick();
  jobTimer = setInterval(tick, 250);

  const finish = () => {
    clearInterval(jobTimer);
    tick();
    jobRunning = false;
    btn.disabled = false;
    btn.classList.remove("is-loading");
  };

  try {
    let { data: job } = await api("/api/videos", { method: "POST", body: JSON.stringify({ url }) });
    let lastSeen = "queued";
    while (job.stage !== "ready" && job.stage !== "failed") {
      lastSeen = job.stage;
      showJobInfo(job);
      setJobStep(job.stage);
      $("jobSub").textContent = job.message || "Working…";
      await sleep(1500);
      ({ data: job } = await api(`/api/videos/${encodeURIComponent(job.videoId)}`));
    }
    showJobInfo(job);
    if (job.stage === "failed") {
      setJobStep(lastSeen, true);
      panel.classList.add("is-failed");
      $("jobSub").textContent = job.error || job.message || "Something went wrong.";
      errEl.textContent = job.error || "Couldn't prepare this video.";
      errEl.hidden = false;
      finish();
      return;
    }
    setJobStep("ready");
    panel.classList.add("is-done");
    const secs = Math.round((Date.now() - started) / 1000);
    $("jobSub").textContent = `Ready${secs > 1 ? ` in ${secs}s` : ""} · ${job.segmentCount ?? "?"} segments from ${job.source === "captions" ? "YouTube captions" : "Sarvam speech-to-text"}`;
    showWarnings($("jobWarnings"), job.warnings);
    finish();
    $("urlInput").value = "";
    pendingWarnings.set(job.videoId, job.warnings);
    loadLibrary();
    await sleep(job.warnings?.length ? 1400 : 700);
    location.hash = `#/v/${encodeURIComponent(job.videoId)}`;
  } catch (err) {
    finish();
    panel.hidden = true;
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
const pendingWarnings = new Map();

// ---------------------------------------------------------------- routing
let current = null; // { videoId, transcript }

function route() {
  const m = location.hash.match(/^#\/v\/(.+)$/);
  if (m) openVideo(decodeURIComponent(m[1]));
  else showHome();
}
window.addEventListener("hashchange", route);

function showHome() {
  if (call) endCall();
  $("videoView").hidden = true;
  $("homeView").hidden = false;
  window.scrollTo({ top: 0 });
  if (!jobRunning && $("jobPanel").classList.contains("is-done")) $("jobPanel").hidden = true;
  current = null;
  try { player?.pauseVideo?.(); } catch { /* ignore */ }
  document.title = "Video Tutor · Ask any YouTube lesson, out loud";
}

async function openVideo(videoId) {
  if (current?.videoId === videoId) return;
  if (call) endCall();
  $("homeView").hidden = true;
  $("videoView").hidden = false;
  window.scrollTo({ top: 0 });
  current = { videoId, transcript: null };
  $("videoTitle").textContent = library.find((v) => v.videoId === videoId)?.title ?? "Loading…";
  $("videoMeta").innerHTML = "";
  $("segments").innerHTML = `<li class="seg-empty">Loading transcript…</li>`;
  $("segCount").textContent = "";
  $("tSearch").value = "";
  $("tSearchCount").textContent = "";
  clearTimeline();
  showWarnings($("videoWarnings"), pendingWarnings.get(videoId));

  setupPlayer(videoId);
  try {
    const { data } = await api(`/api/transcripts/${encodeURIComponent(videoId)}`);
    if (current?.videoId !== videoId) return;
    current.transcript = data;
    document.title = `${data.title} · Video Tutor`;
    $("videoTitle").textContent = data.title ?? videoId;
    const bits = [];
    if (data.channel) bits.push(`<span>${esc(data.channel)}</span>`);
    if (data.durationSeconds) bits.push(`<span>${fmtTime(data.durationSeconds)}</span>`);
    $("videoMeta").innerHTML = bits.join(`<span aria-hidden="true">·</span>`) +
      (data.language ? ` <span class="badge lang">${esc(langName(data.language))}</span>` : "") + sourceBadge(data.source);
    if (data.warnings?.length) showWarnings($("videoWarnings"), data.warnings);
    renderSegments();
  } catch (e) {
    if (current?.videoId !== videoId) return;
    $("segments").innerHTML = `<li class="seg-empty">Couldn't load the transcript. ${esc(e.message)}</li>`;
    toast(e.status === 404 ? "That video isn't in your library yet." : `Transcript error: ${e.message}`);
  }
}

// ---------------------------------------------------------------- YouTube player
let player = null;
let playerReady = false;
let playerVideoId = null;
let ytPromise = null;
let videoPlaying = false;

function loadYT() {
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { ytPromise = null; reject(new Error("Couldn't load the YouTube player")); };
    document.head.append(s);
  });
  return ytPromise;
}

async function setupPlayer(videoId) {
  const hasVideo = isYouTubeId(videoId);
  $("playerHost").hidden = !hasVideo;
  $("playerPlaceholder").hidden = hasVideo;
  setVideoPlaying(false);
  if (!hasVideo) { try { player?.stopVideo?.(); } catch { /* ignore */ } return; }
  try {
    const YT = await loadYT();
    if (current?.videoId !== videoId) return;
    if (player && playerReady) {
      if (playerVideoId !== videoId) player.cueVideoById(videoId);
      playerVideoId = videoId;
      return;
    }
    if (player) { playerVideoId = videoId; return; } // still initialising
    playerVideoId = videoId;
    player = new YT.Player("player", {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          if (current?.videoId && isYouTubeId(current.videoId) && player.getVideoData?.().video_id !== current.videoId) {
            player.cueVideoById(current.videoId);
            playerVideoId = current.videoId;
          }
        },
        onStateChange: (e) => {
          // Our own jump to a cited moment: keep it paused and don't put the
          // call on hold (seeking a not-yet-started video briefly plays it).
          if (performance.now() < autoSeekUntil) {
            if (e.data === 1) { try { player.pauseVideo(); } catch { /* ignore */ } }
            if (e.data === 2 && !autoSeekWasMuted) { try { player.unMute(); } catch { /* ignore */ } }
            return;
          }
          // 1 = playing, 3 = buffering (usually while playing) → hold the call.
          setVideoPlaying(e.data === 1 || e.data === 3);
        },
        onError: () => toast("The YouTube player couldn't play this video."),
      },
    });
  } catch (e) {
    toast(e.message);
  }
}

function seekTo(seconds, play = true) {
  if (!current) return;
  flashSegmentAt(seconds, false);
  if (!isYouTubeId(current.videoId)) return;
  if (!player || !playerReady) { toast("The player is still loading.", "info", 2500); return; }
  player.seekTo(seconds, true);
  if (play) player.playVideo();
  highlightCurrent(seconds, true);
}

// ---------------------------------------------------------------- auto-cue
// While the tutor talks about a moment in the video, the matching transcript
// line lights up exactly when that sentence starts playing.
let autoSeekUntil = 0;
let autoSeekWasMuted = false;
const cueTimers = new Set();
const pendingCues = new Map(); // turn -> [{ at, offset }] until its first audio is scheduled

function scheduleCue(turn, at, offset) {
  const info = turnAudio.get(turn);
  if (!info || !call?.playCtx) {
    const list = pendingCues.get(turn) ?? [];
    list.push({ at, offset });
    pendingCues.set(turn, list);
    return;
  }
  const delayMs = (info.firstStart + offset - call.playCtx.currentTime) * 1000;
  const timer = setTimeout(() => {
    cueTimers.delete(timer);
    // Paused (student talking / video on hold): the audio clock stopped, so re-time it.
    if (call?.playCtx?.state === "suspended") return scheduleCue(turn, at, offset);
    if (call && playingTurn() === turn) cueVideo(at);
  }, Math.max(0, delayMs));
  cueTimers.add(timer);
}
function flushPendingCues(turn) {
  const list = pendingCues.get(turn);
  if (!list) return;
  pendingCues.delete(turn);
  for (const c of list) scheduleCue(turn, c.at, c.offset);
}
function clearCues() {
  for (const t of cueTimers) clearTimeout(t);
  cueTimers.clear();
  pendingCues.clear();
}
function cueVideo(at) {
  // Transcript only: highlight the line being talked about. (Moving the video
  // player itself felt flickery, so the player is left alone.)
  if (!current) return;
  flashSegmentAt(at, true);
}

function setVideoPlaying(on) {
  if (videoPlaying === on) return;
  videoPlaying = on;
  applyHold();
}

// ---------------------------------------------------------------- transcript
let segEls = [];
let currentSegIdx = -1;
let userScrolledAt = 0;

function renderSegments() {
  const segs = current?.transcript?.segments ?? [];
  $("segCount").textContent = segs.length ? `· ${segs.length}` : "";
  const q = $("tSearch").value.trim().toLowerCase();
  const list = $("segments");
  if (!segs.length) { list.innerHTML = `<li class="seg-empty">No transcript segments.</li>`; segEls = []; return; }
  let shown = 0;
  list.innerHTML = segs.map((s, i) => {
    const hit = !q || s.text.toLowerCase().includes(q);
    if (hit) shown++;
    const text = q && hit ? highlightText(s.text, q) : esc(s.text);
    return `<li class="seg" data-i="${i}"${hit ? "" : " hidden"}><button class="ts" data-t="${s.start}" aria-label="Play from ${fmtTime(s.start)}">${fmtTime(s.start)}</button><span class="seg-text">${text}</span></li>`;
  }).join("") + (q && !shown ? `<li class="seg-empty">No matches for “${esc(q)}”</li>` : "");
  segEls = [...list.querySelectorAll(".seg")];
  $("tSearchCount").textContent = q ? `${shown} match${shown === 1 ? "" : "es"}` : "";
  currentSegIdx = -1;
}
function highlightText(text, q) {
  const lower = text.toLowerCase();
  let out = "", i = 0;
  for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
    out += esc(text.slice(i, j)) + `<mark>${esc(text.slice(j, j + q.length))}</mark>`;
    i = j + q.length;
  }
  return out + esc(text.slice(i));
}
function segIndexAt(t) {
  const segs = current?.transcript?.segments ?? [];
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function scrollSegIntoView(el) {
  const list = $("segments");
  if (!el || el.hidden) return;
  const top = el.offsetTop - list.offsetTop - list.clientHeight / 3;
  list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}
function highlightCurrent(t, force = false) {
  const idx = segIndexAt(t);
  if (idx === currentSegIdx && !force) return;
  segEls[currentSegIdx]?.classList.remove("current");
  currentSegIdx = idx;
  const el = segEls[idx];
  if (!el) return;
  el.classList.add("current");
  if (force || Date.now() - userScrolledAt > 4000) scrollSegIntoView(el);
}
function flashSegmentAt(t, scroll = true) {
  const el = segEls[segIndexAt(t)];
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth; // restart animation
  el.classList.add("flash");
  if (scroll) scrollSegIntoView(el);
}

$("segments").addEventListener("click", (e) => {
  const b = e.target.closest(".ts");
  if (b) seekTo(Number(b.dataset.t));
});
["wheel", "touchmove"].forEach((ev) => $("segments").addEventListener(ev, () => (userScrolledAt = Date.now()), { passive: true }));
$("tSearch").addEventListener("input", () => renderSegments());
$("transcriptToggle").addEventListener("click", () => {
  const btn = $("transcriptToggle");
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  $("transcriptBody").hidden = !open;
});
setInterval(() => {
  if (!player || !playerReady || !current || !isYouTubeId(current.videoId)) return;
  try {
    const t = player.getCurrentTime?.();
    if (typeof t === "number" && !Number.isNaN(t)) highlightCurrent(t);
  } catch { /* ignore */ }
}, 500);

// ---------------------------------------------------------------- mic worklet (from call.html)
const workletCode = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${MIC_RATE};
    this.pos = 0;
    this.frame = new Int16Array(${FRAME_SAMPLES});
    this.len = 0;
  }
  process([input]) {
    const ch = input[0];
    if (!ch) return true;
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
      this.frame[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.len === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.len = 0;
      }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("mic-processor", MicProcessor);`;

// ---------------------------------------------------------------- call state
// call = { ws, micCtx, playCtx, gain, analyser, stream, node, startedAt, userEnded, connected }
let call = null;
const ui = {
  ptt: false,        // hold-to-talk mode
  pttHeld: false,    // button / Space currently held
  ducked: false,
  userPaused: false,
  thinking: false,   // a question is in flight and no audio yet
  lastPartialAt: 0,
  micLevel: 0,       // smoothed 0..1
  lastVoiceAt: 0,
  noisyDismissed: false,
};

// Playback bookkeeping
let playhead = 0;
const sources = new Set(); // { src, turn }
let audioTurn = null; // turn id for incoming binary frames
const turnAudio = new Map(); // turn -> { firstStart, total }
let playbackReported = false;

function micMuted() {
  return !call || videoPlaying || (ui.ptt && !ui.pttHeld);
}

// ---------------------------------------------------------------- talk-over
// The moment the mic hears the student while the tutor is playing, the tutor
// goes quiet (paused exactly where it was, no fade), so the mic hears the
// student clearly instead of a mix of both voices. The server then decides:
// a real question → "interrupt" (drop the answer); anything else →
// "carry_on"/"ignored" → the tutor continues from where it paused.
const TALK_RMS = 0.03; // mic level that counts as speech (after echo cancellation)
const TALK_FRAMES = 4; // ~200 ms of sustained speech
const RESUME_AFTER_MS = 1500; // resume if the server heard no words
const MAX_PAUSE_MS = 10000; // long questions shouldn't be talked over
// After a pause that turned out to have no words (background sound), don't
// pause again for a while, to avoid stop-start stutter.
const NO_WORDS_COOLDOWN_MS = 3000;
let noPauseUntil = 0;
let talkFrames = 0;
let peakWhileTutor = 0;
let resumeTimer = null;
let pausedAt = 0;

function detectTalkOver(loud) {
  talkFrames = loud ? talkFrames + 1 : 0;
  if (talkFrames < TALK_FRAMES || ui.userPaused || videoPlaying) return;
  if (performance.now() < noPauseUntil) return;
  if (!call?.playCtx || call.playCtx.state !== "running" || !sources.size) return;
  ui.userPaused = true;
  pausedAt = performance.now();
  call.playCtx.suspend();
  armResume(RESUME_AFTER_MS);
  send({ type: "client_event", name: "talkover_pause" });
  updateState();
}
function armResume(ms) {
  if (resumeTimer) clearTimeout(resumeTimer);
  const left = MAX_PAUSE_MS - (performance.now() - pausedAt);
  resumeTimer = setTimeout(() => resumeTutor("timeout"), Math.max(0, Math.min(ms, left)));
}
function resumeTutor(reason = "server") {
  if (ui.userPaused && reason === "timeout") noPauseUntil = performance.now() + NO_WORDS_COOLDOWN_MS;
  if (ui.userPaused) send({ type: "client_event", name: "talkover_resume", reason, pausedMs: Math.round(performance.now() - pausedAt) });
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  if (!ui.userPaused) return;
  ui.userPaused = false;
  if (!videoPlaying && call?.playCtx?.state === "suspended") call.playCtx.resume().then(reportPlayback);
  updateState();
}

function onMicFrame(buf) {
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / pcm.length);
  const muted = micMuted();
  const level = muted ? 0 : Math.min(1, rms * 9);
  ui.micLevel = level > ui.micLevel ? level * 0.7 + ui.micLevel * 0.3 : level * 0.25 + ui.micLevel * 0.75;
  if (!muted && rms > 0.02) ui.lastVoiceAt = performance.now();
  if (!muted) detectTalkOver(rms > TALK_RMS);
  if (!muted && sources.size && rms > peakWhileTutor) peakWhileTutor = rms;
  const ws = call?.ws;
  if (ws?.readyState === WebSocket.OPEN) ws.send(muted ? ZERO_FRAME : buf);
}

function send(obj) {
  const log = window.__tutorDebug?.sent;
  if (log) { log.push(obj); if (log.length > 50) log.shift(); }
  const ws = call?.ws;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function reportPlayback() {
  const playing = !!call && sources.size > 0 && (call.playCtx?.state === "running" || ui.userPaused);
  if (playing !== playbackReported) {
    playbackReported = playing;
    send({ type: "playback", playing });
    if (!playing) {
      send({ type: "client_event", name: "mic_peak_while_tutor", rms: Math.round(peakWhileTutor * 1000) / 1000, threshold: TALK_RMS });
      peakWhileTutor = 0;
    }
  }
  updateState();
}

function playPcm(arrayBuffer) {
  const ctx = call?.playCtx;
  if (!ctx) return;
  const pcm = new Int16Array(arrayBuffer);
  if (!pcm.length) return;
  const buf = ctx.createBuffer(1, pcm.length, TTS_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(call.gain);
  playhead = Math.max(playhead, ctx.currentTime + 0.05);
  src.start(playhead);
  const turn = audioTurn;
  let info = turnAudio.get(turn);
  if (!info) { info = { firstStart: playhead, total: 0 }; turnAudio.set(turn, info); flushPendingCues(turn); }
  info.total += buf.duration;
  playhead += buf.duration;
  const entry = { src, turn };
  sources.add(entry);
  ui.thinking = false;
  src.onended = () => { sources.delete(entry); reportPlayback(); };
  reportPlayback();
}

function stopPlayback() {
  for (const { src } of sources) { src.onended = null; try { src.stop(); } catch { /* ignore */ } }
  sources.clear();
  playhead = 0;
}

function setGain(value, ramp = RAMP) {
  const g = call?.gain?.gain;
  if (!g) return;
  const now = call.playCtx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  if (ramp > 0) g.linearRampToValueAtTime(value, now + ramp);
  else g.setValueAtTime(value, now);
}

function playingTurn() {
  // The turn whose audio is audible right now (oldest scheduled source).
  for (const { turn } of sources) return turn;
  return null;
}

function interruptPlayback() {
  clearCues();
  const turn = playingTurn();
  if (turn != null && call?.playCtx) {
    const info = turnAudio.get(turn);
    if (info) {
      const heard = Math.max(0, Math.min(info.total, call.playCtx.currentTime - info.firstStart));
      send({ type: "heard", turn, seconds: Math.round(heard * 100) / 100 });
    }
  }
  stopPlayback();
  ui.ducked = false;
  setGain(1, 0);
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  if (ui.userPaused) {
    ui.userPaused = false;
    if (!videoPlaying && call?.playCtx?.state === "suspended") call.playCtx.resume();
  }
  reportPlayback();
}

// Call on hold while the video plays: zeros go out, tutor audio is suspended.
function applyHold() {
  if (call?.playCtx && call.connected) {
    if (videoPlaying && call.playCtx.state === "running") call.playCtx.suspend().then(reportPlayback);
    else if (!videoPlaying && !ui.userPaused && call.playCtx.state === "suspended") call.playCtx.resume().then(reportPlayback);
  }
  updateState();
}

// ---------------------------------------------------------------- call lifecycle
async function startCall() {
  if (call || !current) return;
  const videoId = current.videoId;
  // The server numbers turns from 1 in every session. Forget the previous
  // session's turn ids (its messages stay in the chat) so new messages don't
  // get written into old bubbles.
  turns.clear();
  turnAudio.clear();
  call = { connected: false, userEnded: false, startedAt: 0 };
  const mine = call;
  updateState();
  $("callBtn").disabled = true;
  $("callBtnLabel").textContent = "Connecting…";
  $("callPanel").classList.add("live");

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("This browser can't access the microphone (needs HTTPS or localhost)."), { name: "NotSupported" });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (call !== mine) { stream.getTracks().forEach((t) => t.stop()); return; }
    mine.stream = stream;
    mine.micCtx = new AudioContext();
    mine.playCtx = new AudioContext();
    mine.gain = mine.playCtx.createGain();
    mine.analyser = mine.playCtx.createAnalyser();
    mine.analyser.fftSize = 512;
    mine.gain.connect(mine.analyser).connect(mine.playCtx.destination);
    mine.playCtx.onstatechange = () => reportPlayback();

    const url = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await mine.micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    if (call !== mine) return;
    mine.node = new AudioWorkletNode(mine.micCtx, "mic-processor");
    mine.micCtx.createMediaStreamSource(stream).connect(mine.node);
    const mute = mine.micCtx.createGain();
    mute.gain.value = 0;
    mine.node.connect(mute).connect(mine.micCtx.destination);
    mine.node.port.onmessage = (e) => { if (call === mine) onMicFrame(e.data); };
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (call === mine) { toast("Your microphone was disconnected."); endCall(); }
    });

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/call`);
    ws.binaryType = "arraybuffer";
    mine.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", videoId }));
    ws.onmessage = (e) => {
      if (call !== mine) return;
      if (typeof e.data === "string") {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        handleEvent(m);
      } else playPcm(e.data);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      if (call !== mine) return;
      if (!mine.userEnded) {
        toast(mine.connected ? "Lost the connection to the tutor." : `Couldn't connect to the tutor${e.reason ? `: ${e.reason}` : "."}`);
        addSys(mine.connected ? "Connection lost" : "Couldn't connect", "error");
      }
      endCall(false);
    };
  } catch (e) {
    if (call !== mine) return;
    const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    const noMic = e?.name === "NotFoundError" || e?.name === "OverconstrainedError";
    toast(denied ? "Microphone access is blocked. Allow it in your browser's site settings, then try again."
      : noMic ? "No microphone found. Plug one in and try again." : "Couldn't reach the tutor. Please try again.");
    endCall(false);
  }
}

function endCall(sendHangup = true) {
  const c = call;
  if (!c) return;
  c.userEnded = true;
  if (sendHangup && c.connected) {
    if (playbackReported) send({ type: "playback", playing: false });
    send({ type: "hangup" });
  }
  stopPlayback();
  call = null;
  try { c.ws?.close(); } catch { /* ignore */ }
  c.stream?.getTracks().forEach((t) => t.stop());
  c.micCtx?.close().catch(() => {});
  c.playCtx?.close().catch(() => {});
  if (c.connected) addSys(`Session ended · ${fmtTime((Date.now() - c.startedAt) / 1000)}`);
  playbackReported = false;
  audioTurn = null;
  turnAudio.clear();
  clearCues();
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  clearLive();
  Object.assign(ui, { ducked: false, userPaused: false, thinking: false, micLevel: 0, pttHeld: false, lastPartialAt: 0 });
  $("pttBtn").setAttribute("aria-pressed", "false");
  $("caption").textContent = "";
  $("noisyBanner").hidden = true;
  $("callPanel").classList.remove("live");
  $("callBtn").disabled = false;
  $("callBtnLabel").textContent = "Ask a question";
  $("callTimer").textContent = "Hands-free · headphones recommended";
  // Drop half-streamed bubbles' cursors.
  for (const t of turns.values()) t.tutor?.classList.remove("streaming", "pending");
  updateState();
}

$("callBtn").addEventListener("click", () => (call ? endCall() : startCall()));

// ---------------------------------------------------------------- protocol
function handleEvent(m) {
  switch (m.type) {
    case "ready":
      call.connected = true;
      call.startedAt = Date.now();
      $("callBtn").disabled = false;
      $("callBtnLabel").textContent = "I'm done";
      if (ui.ptt) send({ type: "mode", ptt: true });
      addSys("Tutor is listening · just start talking");
      applyHold();
      break;
    case "partial":
      ui.lastPartialAt = performance.now();
      showLive(m.text ?? "");
      // Words are coming in: keep the tutor paused until the server decides.
      noPauseUntil = 0;
      if (ui.userPaused) armResume(RESUME_AFTER_MS);
      break;
    // The tutor no longer changes volume when interrupted (it stops cleanly
    // and opens the next answer with a short filler instead), so the old
    // duck/unduck messages are ignored.
    case "duck":
    case "unduck":
    case "pause":
    case "resume":
      break;
    case "interrupt":
      interruptPlayback();
      break;
    case "audio_start":
      audioTurn = m.turn;
      break;
    case "cue":
      scheduleCue(m.turn, m.at, m.offset ?? 0);
      break;
    case "user":
      onUser(m);
      break;
    case "assistant_delta":
      onDelta(m);
      break;
    case "assistant_done":
      onDone(m);
      break;
    case "ignored":
      clearLive();
      addIgnored(m.text, m.reason);
      resumeTutor();
      break;
    case "carry_on":
      // It wasn't for the tutor: continue from where it paused.
      resumeTutor();
      break;
    case "stopped":
      clearLive();
      addSys(m.text ? `Tutor stopped · “${m.text}”` : "Tutor stopped", "stopped");
      ui.thinking = false;
      break;
    case "noisy":
      if (!ui.ptt && !ui.noisyDismissed) $("noisyBanner").hidden = false;
      break;
    case "error":
      toast(m.message || "Server error");
      addSys(m.message || "Server error", "error");
      ui.thinking = false;
      break;
    case "limit":
      // Hosted demo limits (session length, quiet timeout, busy, daily cap).
      toast(m.message, "info", 6000);
      addSys(m.message);
      break;
    default:
      break; // unknown types are fine
  }
  updateState();
}

// ---------------------------------------------------------------- timeline
const turns = new Map(); // turn -> { user, tutor, text }

function clearTimeline() {
  $("timeline").innerHTML = "";
  turns.clear();
}
function stickToBottom(fn) {
  const tl = $("timeline");
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
  fn();
  if (atBottom) tl.scrollTop = tl.scrollHeight;
}
function appendItem(el) {
  stickToBottom(() => $("timeline").append(el));
  const tl = $("timeline");
  tl.scrollTop = tl.scrollHeight;
  return el;
}
function addSys(text, kind = "") {
  const li = document.createElement("li");
  li.className = `sys ${kind}`;
  li.textContent = text;
  return appendItem(li);
}
const IGNORE_REASONS = {
  other: "talking to someone else",
  noise: "background noise",
  backchannel: "just acknowledging",
  echo: "tutor's own voice",
};
function addIgnored(text, reason) {
  const li = document.createElement("li");
  li.className = "ignored";
  li.innerHTML = `<details><summary>Ignored · ${esc(IGNORE_REASONS[reason] ?? reason ?? "not for the tutor")}${text ? icon("chevron") : ""}</summary>${text ? `<div class="ignored-text">“${esc(text)}”</div>` : ""}</details>`;
  $("caption").textContent = "";
  return appendItem(li);
}

// "[4:12]", "[1:02:03]", "[4:12–4:30]" → clickable chips
const TS_RE = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*[-–—]\s*((?:\d{1,2}:)?\d{1,2}:\d{2}))?\]/g;
function renderRich(text) {
  let out = "", last = 0;
  for (const m of text.matchAll(TS_RE)) {
    out += esc(text.slice(last, m.index));
    out += `<button class="chip" data-t="${parseTs(m[1])}" title="Jump to ${m[1]}">${m[1]}</button>`;
    if (m[2]) out += `–<button class="chip" data-t="${parseTs(m[2])}" title="Jump to ${m[2]}">${m[2]}</button>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
function citedTimes(text) {
  return [...text.matchAll(TS_RE)].map((m) => parseTs(m[1]));
}

// Live transcript of the student's speech: a faded "You" bubble at the bottom
// of the chat that is replaced by the real message (or removed if ignored).
let liveBubble = null;
function showLive(text) {
  if (!text) return;
  if (!liveBubble || !liveBubble.isConnected) {
    liveBubble = makeMsg("user");
    liveBubble.classList.add("live");
    liveBubble.querySelector(".meta").textContent = "listening…";
    appendItem(liveBubble);
  }
  stickToBottom(() => (liveBubble.querySelector(".bubble").textContent = text));
}
function clearLive() {
  liveBubble?.remove();
  liveBubble = null;
}

function makeMsg(kind) {
  const li = document.createElement("li");
  li.className = `msg ${kind}`;
  li.innerHTML = `<div class="who">${kind === "user" ? "You" : "Tutor"}</div><div class="bubble"></div><div class="meta"></div>`;
  return li;
}
function onUser(m) {
  $("caption").textContent = "";
  clearLive();
  let t = turns.get(m.turn);
  if (!t) { t = { text: "" }; turns.set(m.turn, t); }
  if (!t.user) {
    t.user = makeMsg("user");
    appendItem(t.user);
  }
  t.user.querySelector(".bubble").textContent = m.text ?? "";
  t.user.querySelector(".meta").innerHTML = m.language ? `<span class="tag lang">${esc(langName(m.language))}</span>` : "";
  if (!t.tutor) {
    t.tutor = makeMsg("tutor");
    t.tutor.classList.add("pending");
    t.tutor.querySelector(".bubble").innerHTML = `<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>`;
    appendItem(t.tutor);
  }
  ui.thinking = true;
}
function ensureTutor(turn) {
  let t = turns.get(turn);
  if (!t) { t = { text: "" }; turns.set(turn, t); }
  if (!t.tutor) { t.tutor = makeMsg("tutor"); appendItem(t.tutor); }
  return t;
}
function onDelta(m) {
  const t = ensureTutor(m.turn);
  t.text += m.text ?? "";
  t.tutor.classList.remove("pending");
  t.tutor.classList.add("streaming");
  stickToBottom(() => (t.tutor.querySelector(".bubble").innerHTML = renderRich(t.text)));
}
function removeEl(el) {
  if (!el) return;
  el.classList.add("removing");
  setTimeout(() => el.remove(), 260);
}
function onDone(m) {
  const t = turns.get(m.turn) ?? ensureTutor(m.turn);
  ui.thinking = false;
  turnAudio.delete(m.turn);
  if (m.retracted) {
    removeEl(t.user); removeEl(t.tutor);
    turns.delete(m.turn);
    return;
  }
  if (m.ignored) { // legacy: silent decision reported via assistant_done
    removeEl(t.tutor);
    if (t.user) {
      const li = addIgnored(t.user.querySelector(".bubble").textContent, "other");
      t.user.replaceWith(li);
    }
    turns.delete(m.turn);
    return;
  }
  const text = (m.text ?? t.text ?? "").trim();
  if (!t.tutor) ensureTutor(m.turn);
  t.tutor.classList.remove("streaming", "pending");
  if (!text) {
    if (m.interrupted) t.tutor.querySelector(".bubble").innerHTML = `<span class="muted">(interrupted before answering)</span>`;
    else { removeEl(t.tutor); t.tutor = null; }
  } else {
    t.text = text;
    stickToBottom(() => (t.tutor.querySelector(".bubble").innerHTML = renderRich(text)));
  }
  if (t.tutor) {
    const meta = [];
    if (m.interrupted) meta.push(`<span class="tag">Interrupted</span>`);
    const v2v = m.timings?.voiceToVoiceMs;
    if (v2v != null) meta.push(`<span title="From when you stopped talking to the tutor's first audio">Voice-to-voice ${(v2v / 1000).toFixed(2)} s</span>`);
    t.tutor.querySelector(".meta").innerHTML = meta.join("<span aria-hidden='true'>·</span>");
  }
  // Flash the cited segments in the transcript.
  const cites = (Array.isArray(m.citations) && m.citations.length ? m.citations : citedTimes(text)).slice(0, 4);
  cites.forEach((sec, i) => setTimeout(() => flashSegmentAt(sec, i === 0), i * 300));
}

$("timeline").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) seekTo(Number(chip.dataset.t));
});

// ---------------------------------------------------------------- hold to talk
function setPtt(on) {
  ui.ptt = on;
  $("pttToggle").checked = on;
  $("pttBtn").hidden = !on;
  if (on) $("noisyBanner").hidden = true;
  if (!on) { ui.pttHeld = false; $("pttBtn").setAttribute("aria-pressed", "false"); }
  if (call?.connected) send({ type: "mode", ptt: on });
  updateState();
}
function setHeld(on) {
  if (!ui.ptt || ui.pttHeld === on) return;
  ui.pttHeld = on;
  $("pttBtn").setAttribute("aria-pressed", String(on));
  updateState();
}
$("pttToggle").addEventListener("change", (e) => setPtt(e.target.checked));
const pttBtn = $("pttBtn");
pttBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); pttBtn.setPointerCapture?.(e.pointerId); setHeld(true); });
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => pttBtn.addEventListener(ev, () => setHeld(false)));
pttBtn.addEventListener("contextmenu", (e) => e.preventDefault());
$("noisyEnable").addEventListener("click", () => { setPtt(true); toast("Hold-to-talk is on. Hold the button or Space while you speak.", "ok", 3500); });
$("noisyDismiss").addEventListener("click", () => { ui.noisyDismissed = true; $("noisyBanner").hidden = true; });

// ---------------------------------------------------------------- keyboard
const typingTarget = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && el.type !== "checkbox";
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && ui.ptt && !typingTarget(document.activeElement) && !$("videoView").hidden) {
    e.preventDefault();
    if (!e.repeat) setHeld(true);
  } else if (e.key === "Escape" && call) {
    endCall();
  }
});
document.addEventListener("keyup", (e) => { if (e.code === "Space") setHeld(false); });
window.addEventListener("blur", () => setHeld(false));

// ---------------------------------------------------------------- state + animation loop
const STATUS = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  listening: "Listening · ask anything about the video",
  ptt: "Hold to talk",
  user: "You're speaking…",
  thinking: "Thinking…",
  tutor: "Tutor speaking · just talk to interrupt",
  ducked: "Tutor paused for you…",
  hold: "On hold · video playing",
};
let lastState = "";
function computeState() {
  if (!call) return "idle";
  if (!call.connected) return "connecting";
  if (videoPlaying) return "hold";
  const now = performance.now();
  if (ui.ducked && sources.size) return "ducked";
  if (ui.userPaused) return "user"; // tutor paused mid-answer to listen to the student
  if (sources.size && call.playCtx?.state === "running") return "tutor";
  const talking = !micMuted() && (now - ui.lastVoiceAt < 350 || now - ui.lastPartialAt < 700);
  if (talking) return "user";
  if (ui.thinking) return "thinking";
  if (ui.ptt && !ui.pttHeld) return "ptt";
  return "listening";
}
function updateState() {
  const s = computeState();
  if (s === lastState) return;
  lastState = s;
  $("callPanel").dataset.state = s === "ptt" ? "listening" : s;
  $("statusText").textContent = STATUS[s];
}

const meterBars = [...document.querySelectorAll("#meter i")];
const orbWrap = document.querySelector(".orb-wrap");
let tutorBuf = null;
let displayLevel = 0;
function frame() {
  updateState();
  let level = 0;
  if (call?.connected) {
    if (lastState === "tutor" || lastState === "ducked") {
      const a = call.analyser;
      if (a) {
        tutorBuf ??= new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(tutorBuf);
        let sum = 0;
        for (let i = 0; i < tutorBuf.length; i++) sum += tutorBuf[i] * tutorBuf[i];
        level = Math.min(1, Math.sqrt(sum / tutorBuf.length) * 5);
      }
    } else if (lastState !== "hold") level = ui.micLevel;
    const tl = call.startedAt ? fmtTime((Date.now() - call.startedAt) / 1000) : "";
    const label = call.connected ? `${tl}${ui.ptt ? " · hold to talk" : " · hands-free"}` : "";
    if ($("callTimer").textContent !== label) $("callTimer").textContent = label;
  }
  displayLevel += (level - displayLevel) * 0.35;
  orbWrap.style.setProperty("--level", displayLevel.toFixed(3));
  const t = performance.now() / 1000;
  meterBars.forEach((b, i) => {
    const shape = 0.55 + 0.45 * Math.sin(t * 7 + i * 1.3);
    const center = 1 - Math.abs(i - 3) / 4;
    b.style.height = `${4 + displayLevel * 18 * shape * (0.5 + center * 0.5)}px`;
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- debug hook
// Simulate server messages from the console, e.g.
//   __tutorDebug.handle({type:"user",turn:1,text:"What is an agent?",language:"en-IN"})
window.__tutorDebug = {
  handle(m) {
    if (!call) {
      call = { connected: false, userEnded: false, startedAt: 0, fake: true };
      $("callPanel").classList.add("live");
      if (m.type !== "ready") handleEvent({ type: "ready" });
    }
    handleEvent(m);
    return computeState();
  },
  fakeCall() { return this.handle({ type: "ready" }); },
  // Feed `seconds` of a quiet 220 Hz tone as tutor audio for `turn` (tests duck/interrupt/heard).
  async fakeAudio(seconds = 3, turn = 99) {
    if (!call) this.fakeCall();
    if (!call.playCtx) {
      call.playCtx = new AudioContext();
      call.gain = call.playCtx.createGain();
      call.analyser = call.playCtx.createAnalyser();
      call.analyser.fftSize = 512;
      call.gain.connect(call.analyser).connect(call.playCtx.destination);
    }
    await call.playCtx.resume().catch(() => {});
    this.handle({ type: "audio_start", turn });
    const n = Math.round(TTS_RATE * 0.25);
    for (let c = 0; c < seconds * 4; c++) {
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = Math.sin(((c * n + i) / TTS_RATE) * 2 * Math.PI * 220) * 3000;
      playPcm(pcm.buffer);
    }
    return { ctx: call.playCtx.state, state: computeState() };
  },
  sent: [],
  end() { endCall(false); },
  setVideoPlaying,
  seekTo,
  openVideo: (id) => (location.hash = `#/v/${encodeURIComponent(id)}`),
  state: () => ({ state: computeState(), ui: { ...ui }, videoPlaying, sources: sources.size, call: !!call }),
  demo() {
    const h = (m) => this.handle(m);
    h({ type: "ready" });
    h({ type: "partial", text: "agentic AI kya hota hai" });
    h({ type: "user", turn: 1, text: "Agentic AI kya hota hai?", language: "hi-IN" });
    h({ type: "assistant_delta", turn: 1, text: "Agentic AI ek aisa system hai jo khud decide karta hai [0:45] " });
    h({ type: "assistant_delta", turn: 1, text: "aur tools use karta hai [2:10–2:30]." });
    h({ type: "assistant_done", turn: 1, text: "Agentic AI ek aisa system hai jo khud decide karta hai [0:45] aur tools use karta hai [2:10–2:30].", citations: [45, 130], interrupted: false, retracted: false, timings: { voiceToVoiceMs: 840 } });
    h({ type: "ignored", text: "haan mummy abhi aata hoon", reason: "other" });
    h({ type: "ignored", text: "hmm", reason: "backchannel" });
    h({ type: "user", turn: 2, text: "Example kya tha", language: "en-IN" });
    h({ type: "assistant_delta", turn: 2, text: "Real-life example travel booking ka tha [3:05]" });
    h({ type: "assistant_done", turn: 2, text: "Real-life example travel booking ka tha [3:05]", citations: [185], interrupted: true, retracted: false, timings: { voiceToVoiceMs: 910 } });
    h({ type: "stopped", text: "ruko ek second" });
    h({ type: "noisy" });
    h({ type: "user", turn: 3, text: "aur" });
    h({ type: "assistant_done", turn: 3, text: "", retracted: true });
    return this.state();
  },
};

// ---------------------------------------------------------------- boot
// Hosted demo: no adding videos (YouTube blocks cloud servers), so show the
// bundled ones instead of the link box.
fetch("/api/config").then((r) => (r.ok ? r.json() : null)).then((cfg) => {
  if (!cfg || cfg.canAddVideos) return;
  $("addForm").hidden = true;
  const sub = document.querySelector(".hero-sub");
  if (sub) sub.innerHTML = "Pick a video below and just talk: your tutor answers from the video, in English, Hindi, Hinglish or your own language, and points you to the exact moment.";
  const note = document.createElement("p");
  note.className = "hero-note";
  note.textContent = "This demo includes a few ready videos. To add any YouTube video, run it locally (see the GitHub repo).";
  $("addForm").after(note);
}).catch(() => {});

loadLibrary().then(() => {
  if (current && $("videoTitle").textContent === "Loading…") {
    const v = library.find((x) => x.videoId === current.videoId);
    if (v?.title) $("videoTitle").textContent = v.title;
  }
});
route();
