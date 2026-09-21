// Paste into the browser console on https://alphy.tv to time one Lift open end
// to end, on the viewer's own network and browser: the /info relay, the player
// page, every media request (host, status, time), then a muted 12-second play
// to see how fast the picture starts and how many frames the decoder drops.
// Opens /l/<id> of the current page (or X-Men 3, 314) with its cached parse
// dropped. The result appears in a box at the top of the page, selected, ready
// to copy — a console filtered to errors would hide a console.log.
(async () => {
  const id = (location.pathname.match(/^\/l\/(\d+)/) || [])[1] || "314";
  for (const key of Object.keys(localStorage)) {
    if (new RegExp(`liftw(title|ladder)[^:]*:${id}$|curatedmeta:lift:${id}$`).test(key)) localStorage.removeItem(key);
  }
  history.pushState({}, "", "/");
  dispatchEvent(new PopStateEvent("popstate"));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const rows = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const host = (url) => { try { return new URL(url).host; } catch { return ""; } };
  const file = (url) => { try { return new URL(url).pathname.split("/").slice(-2).join("/"); } catch { return ""; } };
  const mark = (step, detail = "") => rows.push([at(), step, detail]);

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = String(input?.url || input);
    const started = at();
    try {
      const response = await originalFetch.call(this, input, init);
      mark(`fetch ${response.status}`, `${host(url)} ${file(url)} ${at() - started}ms`);
      return response;
    } catch (error) {
      mark("fetch FAILED", `${host(url)} ${file(url)} ${error.name} ${at() - started}ms`);
      throw error;
    }
  };
  // When Shaka asks for a file, so a slow answer is told apart from a late question.
  const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ""; } };
  const asked = new Map();
  let shakaPatch = null;
  const patchShaka = () => {
    const proto = window.shaka?.net?.NetworkingEngine?.prototype;
    if (!proto || shakaPatch) return;
    const original = proto.request;
    proto.request = function (type, request, ...rest) {
      for (const uri of request?.uris || []) asked.set(pathOf(uri), at());
      return original.call(this, type, request, ...rest);
    };
    shakaPatch = { proto, original };
  };
  patchShaka();
  const shakaTimer = setInterval(patchShaka, 50);
  const media = new Map();
  const onMessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.alphyFetch) mark(`page ${data.ok ? data.status : "FAILED"}`, `${(data.text || "").length}ch`);
    if (!data.alphyLiftwMedia) return;
    const entry = media.get(data.id) || {};
    media.set(data.id, entry);
    if (data.responseUrl) entry.url = data.responseUrl;
    if (data.phase === "headers") entry.headers = at();
    if (data.ok === true || data.ok === false) {
      mark(`media ${data.ok ? data.status : "FAILED"}`,
        `${host(entry.url || "")} ${file(entry.url || "")} ${data.error || ""} asked@${asked.get(pathOf(entry.url || "")) ?? "-"} hdr@${entry.headers ?? "-"}`);
    }
  };
  addEventListener("message", onMessage);
  const videoEvents = ["loadedmetadata", "canplay", "playing", "waiting", "stalled", "error"];
  const onVideo = (event) => { if (event.target.tagName === "VIDEO") mark(`video ${event.type}`); };
  videoEvents.forEach((type) => document.addEventListener(type, onVideo, true));

  mark("open", `/l/${id}`);
  history.pushState({}, "", `/l/${id}`);
  dispatchEvent(new PopStateEvent("popstate"));
  let deadline = performance.now() + 40000;
  while (performance.now() < deadline && !rows.some((row) => row[1] === "video canplay")) await sleep(100);
  const readyMs = rows.find((row) => row[1] === "video canplay")?.[0] ?? null;

  // A muted play, so no click is needed: when does the picture really move,
  // and does the decoder keep up?
  const playback = {};
  const video = document.querySelector("video");
  if (video && readyMs !== null) {
    const wasMuted = video.muted;
    video.muted = true;
    const playAt = at();
    // The player may resume from history, so the two seconds count from here.
    const from = video.currentTime;
    try { await video.play(); } catch (error) { playback.playError = error.name; }
    deadline = performance.now() + 15000;
    while (performance.now() < deadline && video.currentTime < from + 2) await sleep(50);
    playback.toTwoSecondsMs = video.currentTime >= from + 2 ? at() - playAt : null;
    await sleep(10000);
    const quality = video.getVideoPlaybackQuality?.();
    playback.frames = quality ? `${quality.droppedVideoFrames}/${quality.totalVideoFrames} dropped` : "n/a";
    playback.size = `${video.videoWidth}x${video.videoHeight}`;
    playback.position = Math.round(video.currentTime * 10) / 10;
    video.pause();
    video.muted = wasMuted;
  }

  window.fetch = originalFetch;
  clearInterval(shakaTimer);
  if (shakaPatch) shakaPatch.proto.request = shakaPatch.original;
  removeEventListener("message", onMessage);
  videoEvents.forEach((type) => document.removeEventListener(type, onVideo, true));
  const kinds = [...new Set([...media.values()].map((entry) => (file(entry.url || "").match(/\.(\w+)$/) || [])[1]).filter(Boolean))];
  const supports = (type) => {
    try { return (window.ManagedMediaSource || window.MediaSource)?.isTypeSupported(type) ?? false; } catch { return false; }
  };
  const result = {
    id, readyMs, playback, mediaKinds: kinds,
    mse: { managed: !!window.ManagedMediaSource, av1: supports('video/webm; codecs="av01.0.08M.08"'),
      vp9: supports('video/webm; codecs="vp09.00.40.08"'), h264: supports('video/mp4; codecs="avc1.640028"') },
    ua: navigator.userAgent, rows,
  };
  const text = "ALPHY_LIFT_TIMELINE " + JSON.stringify(result);
  console.log(text);
  const box = document.createElement("textarea");
  box.value = text;
  box.style.cssText = "position:fixed;z-index:2147483647;top:8px;left:8px;right:8px;height:40vh;font:12px monospace;background:#fff;color:#000";
  box.addEventListener("dblclick", () => box.remove());
  document.body.append(box);
  box.focus();
  box.select();
  return "Результат в поле вверху страницы: ⌘C, чтобы скопировать; двойной клик по полю закроет его.";
})();
