(() => {
  "use strict";

  // Smooth Shaka episode transitions without reaching into app.js's private state.
  // Episode switches intentionally rebuild the Shaka Player, but the surrounding
  // season/episode/track controls should stay mounted while the new manifest loads.
  const serialPanel = document.getElementById("serialPanel");
  const trackPanel = document.getElementById("trackPanel");
  if (!serialPanel || !trackPanel) return;

  let switchIntent = false;
  let preservingControls = false;
  let carryTextPreference = false;
  let textPreference = null;
  let restoringTextPreference = false;
  const savedPanels = new Map();

  const rememberPanel = (panel) => {
    if (!panel?.childNodes?.length) return;
    savedPanels.set(panel, {
      nodes: Array.from(panel.childNodes),
      wasHidden: panel.classList.contains("hidden"),
    });
  };

  const beginControlPreservation = () => {
    preservingControls = true;
    rememberPanel(serialPanel);
    rememberPanel(trackPanel);
  };

  const endControlPreservation = () => {
    preservingControls = false;
    switchIntent = false;
    carryTextPreference = false;
    savedPanels.clear();
  };

  // Capture before app.js's button listener runs. A non-active serial control is
  // the one reliable public signal that this teardown is an in-place episode
  // switch rather than navigation to another title.
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("#serialPanel button");
    if (button && !button.disabled && !button.classList.contains("active")) {
      switchIntent = true;
      carryTextPreference = true;
      return;
    }
    if (!event.target?.closest?.("#serialPanel") && !preservingControls) {
      switchIntent = false;
      carryTextPreference = false;
    }
  }, true);

  // teardownPlayer dispatches ready=false before it clears serialPanel/trackPanel,
  // so this event lets us retain the *actual* nodes (and therefore their existing
  // click listeners). MutationObserver puts those nodes back only when teardown
  // leaves a panel empty; a real renderTracks() rebuild finishes non-empty and is
  // left completely alone.
  window.addEventListener("alphy:player-ready", (event) => {
    if (event.detail?.ready === false) {
      if (switchIntent || preservingControls) beginControlPreservation();
      return;
    }
    if (event.detail?.ready === true && preservingControls) endControlPreservation();
  });

  const controlsObserver = new MutationObserver(() => {
    if (!preservingControls) return;
    for (const panel of [serialPanel, trackPanel]) {
      const saved = savedPanels.get(panel);
      if (!saved) {
        rememberPanel(panel);
        continue;
      }
      if (panel.childNodes.length) {
        // A synchronous renderTracks() completed: keep the fresh nodes as the
        // next fallback in case playShaka's second teardown runs immediately.
        rememberPanel(panel);
        continue;
      }
      for (const node of saved.nodes) panel.appendChild(node);
      if (!saved.wasHidden) panel.classList.remove("hidden");
    }
  });
  controlsObserver.observe(serialPanel, { childList: true, attributes: true, attributeFilter: ["class"] });
  controlsObserver.observe(trackPanel, { childList: true, attributes: true, attributeFilter: ["class"] });

  const textIdentity = (track) => ({
    language: String(track?.language || ""),
    label: String(track?.label || ""),
    kind: String(track?.kind || ""),
    roles: Array.isArray(track?.roles) ? track.roles.map(String).sort() : [],
  });

  const sameRoles = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

  const scoreTextTrack = (track, wanted) => {
    if (!track || !wanted) return -1;
    const candidate = textIdentity(track);
    let score = 0;
    if (wanted.language && candidate.language === wanted.language) score += 4;
    if (wanted.label && candidate.label === wanted.label) score += 8;
    if (wanted.kind && candidate.kind === wanted.kind) score += 1;
    if (wanted.roles.length && sameRoles(candidate.roles, wanted.roles)) score += 2;
    // A different explicit label is a different subtitle release; do not select
    // it just because the language happens to match when a labelled choice exists.
    if (wanted.label && candidate.label && candidate.label !== wanted.label) score -= 8;
    return score;
  };

  const bestMatchingTextTrack = (player, wanted) => {
    const tracks = player?.getTextTracks?.() || [];
    return [...tracks]
      .map((track) => ({ track, score: scoreTextTrack(track, wanted) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.track || null;
  };

  const patchShaka = (shaka) => {
    const proto = shaka?.Player?.prototype;
    if (!proto || proto.__alphySmoothPatched) return;
    Object.defineProperty(proto, "__alphySmoothPatched", { value: true, configurable: true });

    const originalLoad = proto.load;
    const originalAddTextTrackAsync = proto.addTextTrackAsync;
    const originalSelectTextTrack = proto.selectTextTrack;
    const originalSetTextTrackVisibility = proto.setTextTrackVisibility;

    const restore = (player) => {
      if (!carryTextPreference || !textPreference || restoringTextPreference) return;
      restoringTextPreference = true;
      try {
        if (textPreference.visible === false) {
          originalSetTextTrackVisibility?.call(player, false);
          return;
        }
        const match = bestMatchingTextTrack(player, textPreference.track);
        if (!match) return;
        originalSelectTextTrack?.call(player, match);
        originalSetTextTrackVisibility?.call(player, true);
      } catch {
        // A provider may publish text tracks later; addTextTrackAsync retries.
      } finally {
        restoringTextPreference = false;
      }
    };

    if (typeof originalSelectTextTrack === "function") {
      proto.selectTextTrack = function alphySelectTextTrack(track) {
        const result = originalSelectTextTrack.call(this, track);
        if (!restoringTextPreference && track) {
          textPreference = {
            visible: this.isTextTrackVisible?.() !== false,
            track: textIdentity(track),
          };
        }
        return result;
      };
    }

    if (typeof originalSetTextTrackVisibility === "function") {
      proto.setTextTrackVisibility = function alphySetTextTrackVisibility(visible) {
        const result = originalSetTextTrackVisibility.call(this, visible);
        if (!restoringTextPreference) {
          const active = this.getTextTracks?.().find((track) => track.active);
          textPreference = {
            visible: !!visible,
            track: active ? textIdentity(active) : textPreference?.track || null,
          };
        }
        return result;
      };
    }

    if (typeof originalLoad === "function") {
      proto.load = async function alphyLoad(...args) {
        const result = await originalLoad.apply(this, args);
        restore(this);
        return result;
      };
    }

    if (typeof originalAddTextTrackAsync === "function") {
      proto.addTextTrackAsync = async function alphyAddTextTrackAsync(...args) {
        const result = await originalAddTextTrackAsync.apply(this, args);
        restore(this);
        return result;
      };
    }
  };

  // Shaka is injected dynamically by app.js. A capturing load listener runs before
  // that script element's onload handler resolves ensureShaka(), so Player is
  // patched before app.js can construct the first instance.
  document.addEventListener("load", (event) => {
    const script = event.target;
    if (script?.tagName === "SCRIPT" && /shaka-player/i.test(String(script.src || ""))) {
      patchShaka(window.shaka);
    }
  }, true);
  patchShaka(window.shaka);
})();
