import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../app.js", import.meta.url), "utf8");

test("Collaps fullscreen starts on the stable host, never via migration", async () => {
  const app = await source();
  const create = app.slice(app.indexOf("function createCollapsVideo"), app.indexOf("function activeCollapsVideo"));
  assert.ok(create.includes('controlslist", "nofullscreen noremoteplayback'));
  assert.ok(create.includes("mountCollapsFullscreenButton"));
  assert.ok(create.includes("toggleFullscreen();"));
  assert.ok(!app.includes("function armFullscreenMigration"));
  assert.ok(app.includes("function armFullscreenGuard"));
});

test("automatic refresh defers while the replaceable video owns fullscreen", async () => {
  const app = await source();
  const refresh = app.slice(app.indexOf("async function refreshCollapsNow"), app.indexOf("function stopCollapsSchedule"));
  assert.ok(refresh.includes("isCollapsNativeFullscreen(current) && !emergency && !qualityKey"));
  assert.ok(refresh.includes("c.pendingRefresh = true"));
  assert.ok(refresh.includes("isCollapsNativeFullscreen(activeCollapsVideo())"));
  assert.ok(refresh.includes("hardReloadCollapsVideo(url)"));
  assert.ok(app.includes("onwebkitbeginfullscreen"));
  assert.ok(app.includes("onwebkitendfullscreen"));
});

test("handoff waits for a compositor frame after the final seek", async () => {
  const app = await source();
  const helper = app.slice(app.indexOf("function waitForPresentedCollapsFrame"), app.indexOf("function activeCollapsVideo"));
  const swap = app.slice(app.indexOf("function swapCollapsVideo"), app.indexOf("function hardReloadCollapsVideo"));
  assert.ok(helper.includes("requestVideoFrameCallback"));
  assert.ok(swap.includes("await waitForPresentedCollapsFrame(next)"));
  const correction = swap.indexOf("Math.abs(drift) > 0.35");
  const seek = swap.indexOf("waitForCollapsSeek(next", correction);
  const frame = swap.indexOf("waitForPresentedCollapsFrame(next)", seek);
  assert.ok(correction >= 0 && seek > correction && frame > seek);
});

test("old and new frames overlap during the visual handoff", async () => {
  const app = await source();
  const swap = app.slice(app.indexOf("function swapCollapsVideo"), app.indexOf("function hardReloadCollapsVideo"));
  const reveal = swap.indexOf("const reveal =");
  const activate = swap.indexOf('next.style.opacity = "1"', reveal);
  const pause = swap.indexOf("cur.pause()", reveal);
  assert.ok(activate >= 0 && pause > activate);
  assert.ok(swap.includes("raf(() => raf(() =>"));
  assert.ok(swap.includes("cur.muted = true"));
  assert.ok(swap.includes("next.muted = desiredMuted"));
});

test("the spare stays renderable instead of display:none", async () => {
  const app = await source();
  const mount = app.slice(app.indexOf("async function mountCollapsMp4"), app.indexOf("function createCollapsVideo"));
  assert.ok(!mount.includes('buffer.style.display = "none"'));
  assert.ok(mount.includes('buffer.dataset.collapsActive = "0"'));
});

test("session refresh remains invisible machinery", async () => {
  const app = await source();
  assert.ok(!app.includes('addTrackGroup("Сессия"'));
  assert.ok(!app.includes("авто вкл"));
  assert.ok(app.includes('refreshCollapsNow("таймер")'));
  assert.ok(app.includes('refreshCollapsNow("зависание")'));
});
