import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("no code path reads frames back off the GPU", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // drawImage(video) + toDataURL is a synchronous GPU readback. It used to run
  // on loadeddata/playing/pause/seeked, so on a weak device every rebuffer fired
  // a capture and the capture caused the next rebuffer — a stutter per second on
  // a projector. A thumbnail is not worth that; cards fall back to the poster.
  // Call sites, not the words: the comment explaining the removal names them.
  assert.doesNotMatch(app, /\.toDataURL\s*\(/);
  assert.doesNotMatch(app, /\.drawImage\s*\(/);
  assert.doesNotMatch(app, /captureVideoSnapshot\s*\(/);
  assert.doesNotMatch(app, /getContext\s*\(\s*["']2d["']/);
  // The position report injected into the Ortified iframe stays — it is cheap
  // and it is what keeps the continue card working.
  assert.match(app, /alphyOrtProgress: true, position: v\.currentTime/);
});

test("history still renders without a snapshot", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // Entries written before the capture was removed keep theirs; everything else
  // shows the poster, which every entry already carries.
  assert.match(app, /entry\.poster \|\| entry\.snapshot/);
});
