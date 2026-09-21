import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type, event = {}) {
    event.type = type;
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class Classes {
  constructor(...names) { this.values = new Set(names); }
  contains(name) { return this.values.has(name); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
}

class ElementStub {
  constructor(id) {
    this.id = id;
    this.childNodes = [];
    this.classList = new Classes();
  }
  appendChild(node) {
    this.childNodes.push(node);
    node.parent = this;
    return node;
  }
}

async function buildHarness() {
  const serialPanel = new ElementStub("serialPanel");
  const trackPanel = new ElementStub("trackPanel");
  const serialNode = { name: "serial" };
  const trackNode = { name: "tracks" };
  serialPanel.appendChild(serialNode);
  trackPanel.appendChild(trackNode);

  const serialButton = {
    disabled: false,
    classList: new Classes(),
    closest(selector) {
      if (selector === "#serialPanel button") return this;
      if (selector === "#serialPanel") return serialPanel;
      return null;
    },
  };

  const document = new Emitter();
  document.getElementById = (id) => (
    id === "serialPanel" ? serialPanel : id === "trackPanel" ? trackPanel : null
  );
  const window = new Emitter();
  window.window = window;

  const observers = [];
  class MutationObserverStub {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
  }

  class Player {
    constructor(texts = []) {
      this.texts = texts;
      this.visible = false;
      this.selected = null;
    }
    async load() { return "ok"; }
    async addTextTrackAsync() { return null; }
    selectTextTrack(track) {
      this.selected = track;
      for (const item of this.texts) item.active = item === track;
    }
    setTextTrackVisibility(visible) { this.visible = !!visible; }
    isTextTrackVisible() { return this.visible; }
    getTextTracks() { return this.texts; }
  }

  window.shaka = { Player };
  const source = await readFile(new URL("../shaka-smooth.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window, document, MutationObserver: MutationObserverStub, console });

  return { window, document, observers, serialPanel, trackPanel, serialNode, trackNode, serialButton };
}

test("Shaka controls stay mounted and subtitle choice follows only the episode switch", async () => {
  const h = await buildHarness();
  const first = { language: "en", label: "English CC", kind: "subtitles", roles: [], active: false };
  const player1 = new h.window.shaka.Player([first]);
  player1.selectTextTrack(first);
  player1.setTextTrackVisibility(true);

  h.document.emit("click", { target: h.serialButton });
  h.window.emit("alphy:player-ready", { detail: { ready: false } });
  h.serialPanel.childNodes = [];
  h.serialPanel.classList.add("hidden");
  h.trackPanel.childNodes = [];
  h.trackPanel.classList.add("hidden");
  for (const observer of h.observers) observer.callback();

  assert.equal(h.serialPanel.childNodes[0], h.serialNode);
  assert.equal(h.trackPanel.childNodes[0], h.trackNode);
  assert.equal(h.serialPanel.classList.contains("hidden"), false);
  assert.equal(h.trackPanel.classList.contains("hidden"), false);

  const same = { language: "en", label: "English CC", kind: "subtitles", roles: [], active: false };
  const other = { language: "ru", label: "Русские", kind: "subtitles", roles: [], active: false };
  const player2 = new h.window.shaka.Player([other, same]);
  await player2.load("episode-2");
  assert.equal(player2.selected, same);
  assert.equal(player2.visible, true);

  h.window.emit("alphy:player-ready", { detail: { ready: true } });
  const player3 = new h.window.shaka.Player([
    { language: "en", label: "English CC", kind: "subtitles", roles: [], active: false },
  ]);
  await player3.load("another-title");
  assert.equal(player3.selected, null, "subtitle preference must not leak to unrelated navigation");
});
