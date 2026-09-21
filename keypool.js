(() => {
  "use strict";

  const API_URL = "/api/admin/key-pool";
  const state = {
    pool: null,
    deno: null,
    setup: null,
    tests: new Map(),
    dirty: false,
    loading: false,
    saving: false,
    revealAll: false,
  };

  const el = {
    button: document.getElementById("keyPoolBtn"),
    dialog: document.getElementById("keyPoolDialog"),
    close: document.querySelector("[data-key-pool-close]"),
    summary: document.getElementById("keyPoolSummary"),
    sync: document.getElementById("keyPoolSync"),
    rows: document.getElementById("keyPoolRows"),
    add: document.getElementById("keyPoolAdd"),
    testAll: document.getElementById("keyPoolTestAll"),
    reveal: document.getElementById("keyPoolReveal"),
    reload: document.getElementById("keyPoolReload"),
    save: document.getElementById("keyPoolSave"),
    status: document.getElementById("keyPoolState"),
  };

  function uid() {
    return crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function showDialog() {
    if (typeof el.dialog?.showModal === "function") el.dialog.showModal();
    else el.dialog?.setAttribute("open", "");
  }

  function closeDialog() {
    if (typeof el.dialog?.close === "function") el.dialog.close();
    else el.dialog?.removeAttribute("open");
  }

  function setStatus(text, mode = "") {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.dataset.mode = mode;
  }

  async function fetchJson(options = {}) {
    const response = await fetch(API_URL, { cache: "no-store", ...options });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { ok: false, error: text.slice(0, 180) }; }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function copyPool(value) {
    return {
      schema: 1,
      revision: Number(value?.revision) || 0,
      updatedAt: value?.updatedAt || null,
      runtimeToken: String(value?.runtimeToken || ""),
      keys: (Array.isArray(value?.keys) ? value.keys : []).map((key) => ({
        id: String(key.id || uid()),
        provider: key.provider === "poiskkino" ? "poiskkino" : "unofficial",
        label: String(key.label || ""),
        value: String(key.value || ""),
        enabled: key.enabled !== false,
        scopes: {
          resolver: key.scopes?.resolver === true,
          recommendations: key.provider !== "poiskkino" && key.scopes?.recommendations === true,
          browser: key.provider !== "poiskkino" && key.scopes?.browser !== false,
        },
        createdAt: key.createdAt || null,
        updatedAt: key.updatedAt || null,
      })),
    };
  }

  function metricsById() {
    return new Map((state.deno?.metrics || []).map((entry) => [String(entry.id), entry]));
  }

  function number(value) {
    return new Intl.NumberFormat("ru-RU").format(Math.max(0, Number(value) || 0));
  }

  function summaryStat(label, value) {
    const item = document.createElement("div");
    item.className = "key-pool-stat";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    item.append(strong, span);
    return item;
  }

  function renderSummary() {
    if (!el.summary) return;
    const totals = state.deno?.totals || {};
    el.summary.replaceChildren(
      summaryStat("ключей", number(state.pool?.keys?.length)),
      summaryStat("Deno запросов", number(totals.requests)),
      summaryStat("Deno ошибок", number(totals.errors)),
      summaryStat("Deno среднее", totals.requests ? `${number(totals.averageLatencyMs)} мс` : "—"),
    );
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      const old = button.textContent;
      button.textContent = "Скопировано";
      setTimeout(() => { button.textContent = old; }, 1200);
    } catch {
      const input = button.previousElementSibling;
      input?.select?.();
      document.execCommand?.("copy");
    }
  }

  function renderSync() {
    if (!el.sync) return;
    el.sync.replaceChildren();
    const line = document.createElement("div");
    line.className = "key-pool-sync-line";
    const dot = document.createElement("span");
    dot.className = "key-pool-sync-dot";
    dot.dataset.ok = state.deno?.linked ? "1" : "0";
    const text = document.createElement("span");
    if (state.deno?.linked) {
      const revision = Number(state.deno.revision) || 0;
      text.textContent = `Deno подключён · ревизия ${revision}`;
    } else {
      text.textContent = "Deno не подключён · старые env-ключи работают, но появятся здесь только после привязки";
    }
    line.append(dot, text);
    el.sync.appendChild(line);

    if (!state.deno?.linked && state.setup?.addCommand) {
      const setup = document.createElement("div");
      setup.className = "key-pool-setup";
      const input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.value = state.setup.addCommand;
      input.setAttribute("aria-label", "Команда подключения Deno");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Копировать";
      copy.addEventListener("click", () => copyText(input.value, copy));
      setup.append(input, copy);
      el.sync.appendChild(setup);
    }
  }

  function quotaText(result) {
    const quota = result?.quota;
    if (!quota) return "";
    const daily = quota.dailyLimit
      ? `сегодня ${number(quota.dailyUsed)} / ${number(quota.dailyLimit)}`
      : "";
    const total = quota.totalLimit
      ? `всего ${number(quota.totalUsed)} / ${number(quota.totalLimit)}`
      : "";
    return [daily, total, quota.accountType].filter(Boolean).join(" · ");
  }

  function statusText(key, metric, test) {
    if (test?.testing) return { text: "проверка…", mode: "pending" };
    if (test?.result) {
      if (test.result.ok) return { text: quotaText(test.result) || `OK · ${number(test.result.latencyMs)} мс`, mode: "ok" };
      return { text: `${test.result.status || "ERR"} · ${test.result.error || "ошибка"}`, mode: "error" };
    }
    if (!key.enabled) return { text: "отключён", mode: "off" };
    const denoActive = key.scopes.resolver || key.scopes.recommendations;
    if (!denoActive && !key.scopes.browser) return { text: "только хранение", mode: "off" };
    if (!denoActive && key.scopes.browser) {
      return { text: "общий кэш · квота через «Проверить»", mode: "idle" };
    }
    if (!metric?.requests) return { text: "ещё не использовался", mode: "idle" };
    const average = metric.averageLatencyMs || Math.round((metric.totalLatencyMs || 0) / metric.requests);
    const suffix = `${number(metric.requests)} запр. · ${number(average)} мс`;
    return metric.lastStatus >= 400 || metric.lastError
      ? { text: `${metric.lastStatus || "ERR"} · ${suffix}`, mode: "error" }
      : { text: `OK · ${suffix}`, mode: "ok" };
  }

  function checkbox(labelText, checked, onChange, { disabled = false } = {}) {
    const label = document.createElement("label");
    label.className = "key-pool-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener("change", () => onChange(input.checked));
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(input, span);
    return label;
  }

  function markDirty() {
    state.dirty = true;
    setStatus("не сохранено", "dirty");
    if (el.save) el.save.disabled = false;
  }

  function renderRows() {
    if (!el.rows) return;
    el.rows.replaceChildren();
    const metrics = metricsById();
    for (const [index, key] of state.pool.keys.entries()) {
      const row = document.createElement("section");
      row.className = "key-pool-row";

      const provider = document.createElement("select");
      provider.className = "key-pool-provider";
      for (const [value, label] of [["poiskkino", "PoiskKino"], ["unofficial", "Unofficial"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = key.provider === value;
        provider.appendChild(option);
      }
      provider.addEventListener("change", () => {
        key.provider = provider.value;
        if (key.provider === "poiskkino") {
          key.scopes.recommendations = false;
          key.scopes.browser = false;
        } else {
          key.scopes.browser = true;
        }
        markDirty();
        renderRows();
      });

      const label = document.createElement("input");
      label.className = "key-pool-label";
      label.type = "text";
      label.maxLength = 80;
      label.placeholder = "Название";
      label.value = key.label;
      label.addEventListener("input", () => { key.label = label.value; markDirty(); });

      const secretWrap = document.createElement("div");
      secretWrap.className = "key-pool-secret";
      const secret = document.createElement("input");
      secret.type = state.revealAll ? "text" : "password";
      secret.autocomplete = "off";
      secret.spellcheck = false;
      secret.value = key.value;
      secret.placeholder = "API key";
      secret.addEventListener("input", () => { key.value = secret.value.trim(); markDirty(); });
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = state.revealAll ? "скрыть" : "показать";
      reveal.addEventListener("click", () => {
        secret.type = secret.type === "password" ? "text" : "password";
        reveal.textContent = secret.type === "password" ? "показать" : "скрыть";
      });
      secretWrap.append(secret, reveal);

      const scopes = document.createElement("div");
      scopes.className = "key-pool-scopes";
      scopes.append(
        checkbox("включён", key.enabled, (checked) => { key.enabled = checked; markDirty(); }),
        checkbox("Deno: поиск / мета", key.scopes.resolver, (checked) => { key.scopes.resolver = checked; markDirty(); }),
        checkbox("Deno: для вас", key.scopes.recommendations, (checked) => {
          key.scopes.recommendations = checked;
          markDirty();
        }, { disabled: key.provider === "poiskkino" }),
        checkbox("общий кэш метаданных", key.scopes.browser, (checked) => {
          key.scopes.browser = checked;
          markDirty();
        }, { disabled: key.provider === "poiskkino" }),
      );

      const testState = state.tests.get(key.id);
      const status = statusText(key, metrics.get(key.id), testState);
      const statusNode = document.createElement("div");
      statusNode.className = "key-pool-key-status";
      statusNode.dataset.mode = status.mode;
      statusNode.textContent = status.text;

      const actions = document.createElement("div");
      actions.className = "key-pool-row-actions";
      const test = document.createElement("button");
      test.type = "button";
      test.textContent = "Проверить";
      test.disabled = !key.value || testState?.testing;
      test.addEventListener("click", () => testKey(index));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Удалить";
      remove.addEventListener("click", () => {
        state.pool.keys.splice(index, 1);
        state.tests.delete(key.id);
        markDirty();
        render();
      });
      actions.append(test, remove);

      row.append(provider, label, secretWrap, scopes, statusNode, actions);
      el.rows.appendChild(row);
    }
    if (!state.pool.keys.length) {
      const empty = document.createElement("div");
      empty.className = "key-pool-empty";
      empty.textContent = "Ключей нет";
      el.rows.appendChild(empty);
    }
  }

  function render() {
    if (!state.pool) return;
    renderSummary();
    renderSync();
    renderRows();
    if (el.reveal) el.reveal.textContent = state.revealAll ? "Скрыть все" : "Показать все";
    if (el.save) el.save.disabled = !state.dirty || state.saving;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    setStatus("загрузка…", "saving");
    try {
      const payload = await fetchJson();
      state.pool = copyPool(payload.pool);
      state.deno = payload.deno || null;
      state.setup = payload.setup || null;
      state.dirty = false;
      setStatus("синхронизировано", "ok");
      render();
    } catch (error) {
      setStatus(error.status === 401 ? "нужен вход admin" : "ошибка загрузки", "error");
    } finally {
      state.loading = false;
    }
  }

  async function save() {
    if (!state.pool || state.saving || !state.dirty) return;
    state.saving = true;
    setStatus("сохранение…", "saving");
    render();
    try {
      const payload = await fetchJson({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool: state.pool, baseRevision: state.pool.revision }),
      });
      state.pool = copyPool(payload.pool);
      state.deno = payload.deno || null;
      state.setup = payload.setup || state.setup;
      state.dirty = false;
      setStatus(state.deno?.linked ? "сохранено в Deno" : "сохранено", "ok");
    } catch (error) {
      if (error.status === 409) {
        setStatus("реестр изменился, обновляю…", "error");
        await load();
      } else {
        setStatus("ошибка сохранения", "error");
      }
    } finally {
      state.saving = false;
      render();
    }
  }

  async function testKey(index) {
    const key = state.pool?.keys?.[index];
    if (!key?.value) return;
    state.tests.set(key.id, { testing: true });
    renderRows();
    try {
      const payload = await fetchJson({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", provider: key.provider, value: key.value }),
      });
      state.tests.set(key.id, { result: payload.result });
    } catch (error) {
      state.tests.set(key.id, { result: { ok: false, error: error.message } });
    }
    renderRows();
  }

  async function testAll() {
    if (!state.pool || el.testAll.disabled) return;
    el.testAll.disabled = true;
    for (let index = 0; index < state.pool.keys.length; index += 1) {
      if (state.pool.keys[index].value) await testKey(index);
    }
    el.testAll.disabled = false;
  }

  function addKey() {
    if (!state.pool) return;
    state.pool.keys.push({
      id: uid(),
      provider: "unofficial",
      label: "Kinopoisk Unofficial",
      value: "",
      enabled: true,
      scopes: { resolver: false, recommendations: false, browser: true },
    });
    markDirty();
    render();
    el.rows?.lastElementChild?.querySelector(".key-pool-secret input")?.focus();
  }

  el.button?.addEventListener("click", () => {
    showDialog();
    load();
  });
  // Closing or reloading drops rows that were never saved, and said nothing:
  // a key added and then "Обновить" never reached the server (2026-09-14).
  const discardUnsaved = () => !state.dirty || window.confirm("Есть несохранённые изменения. Выбросить их?");
  el.close?.addEventListener("click", () => {
    if (!discardUnsaved()) return;
    state.dirty = false;
    closeDialog();
  });
  el.add?.addEventListener("click", addKey);
  el.testAll?.addEventListener("click", testAll);
  el.reveal?.addEventListener("click", () => { state.revealAll = !state.revealAll; render(); });
  el.reload?.addEventListener("click", () => {
    if (!discardUnsaved()) return;
    state.dirty = false;
    load();
  });
  el.save?.addEventListener("click", save);
  el.dialog?.addEventListener("cancel", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    setStatus("сначала сохраните или обновите", "dirty");
  });
  window.addEventListener("alphy:admin", (event) => {
    if (!event.detail?.active) closeDialog();
  });
})();
