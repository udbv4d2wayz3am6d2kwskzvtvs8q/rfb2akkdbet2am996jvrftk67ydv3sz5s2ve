import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Reordering used to be two arrows that moved a card one slot per click. These
// pin the drag replacement's arithmetic, which is where this kind of feature
// usually goes wrong: the index shift after removing from the same list.

function reorder(lists, from, to) {
  const source = lists[from.list];
  const destination = lists[to.list];
  const [item] = source.splice(from.index, 1);
  let at = to.index;
  if (from.list === to.list && to.index > from.index) at -= 1;
  destination.splice(Math.max(0, Math.min(at, destination.length)), 0, item);
  return lists;
}

test("dragging right lands where the marker was, not one short", () => {
  // Removing the card first shifts every later index down by one. Without the
  // correction, dragging A between C and D puts it between B and C.
  assert.deepEqual(reorder([["A", "B", "C", "D"]], { list: 0, index: 0 }, { list: 0, index: 3 })[0],
    ["B", "C", "A", "D"]);
  assert.deepEqual(reorder([["A", "B", "C", "D"]], { list: 0, index: 0 }, { list: 0, index: 4 })[0],
    ["B", "C", "D", "A"]);
});

test("dragging left inserts before the marked card", () => {
  assert.deepEqual(reorder([["A", "B", "C", "D"]], { list: 0, index: 3 }, { list: 0, index: 1 })[0],
    ["A", "D", "B", "C"]);
  assert.deepEqual(reorder([["A", "B", "C", "D"]], { list: 0, index: 2 }, { list: 0, index: 0 })[0],
    ["C", "A", "B", "D"]);
});

test("dropping a card back on itself changes nothing", () => {
  assert.deepEqual(reorder([["A", "B", "C"]], { list: 0, index: 1 }, { list: 0, index: 1 })[0],
    ["A", "B", "C"]);
  assert.deepEqual(reorder([["A", "B", "C"]], { list: 0, index: 1 }, { list: 0, index: 2 })[0],
    ["A", "B", "C"]);
});

test("dragging across lists moves the card, and no index correction applies", () => {
  const lists = reorder([["A", "B"], ["X", "Y"]], { list: 0, index: 0 }, { list: 1, index: 1 });
  assert.deepEqual(lists[0], ["B"]);
  assert.deepEqual(lists[1], ["X", "A", "Y"]);
});

test("the source keeps the arrows' guarantees: nothing lost, nothing duplicated", async () => {
  const source = await readFile(new URL("../catalog.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("function reorderItem"), source.indexOf("function dropIndexFor"));
  // A cross-list drop onto a list that already holds the title must put the card
  // back rather than splice it out of existence.
  assert.match(block, /source\.items\.splice\(from\.index, 0, item\)/);
  assert.match(block, /from\.list === to\.list && to\.index > from\.index/);

  // The one-slot arrows are gone; dragging is the only way to reorder.
  assert.doesNotMatch(source, /Сдвинуть влево|Сдвинуть вправо/);
  assert.doesNotMatch(source, /function moveItem\(/);
  // Drop targets are armed on the row, so they survive cards being re-created
  // and cover the gaps between them.
  assert.match(source, /function armRowDrop\(row, listIndex\)/);
  assert.match(source, /if \(state\.admin\) armRowDrop\(row, listIndex\)/);
});
