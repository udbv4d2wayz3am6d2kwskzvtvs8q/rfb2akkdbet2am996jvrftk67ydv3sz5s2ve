// Mirrors the upstream catalogue so search can be answered from our own edge.
//
// Why this exists: reaching any server and coming back costs ~560ms before any
// work is done, so a suggestion list backed by a network call can be fast but
// never instant. A local index makes it instant, and takes the metered search
// quota out of the typing path entirely.
//
// How it behaves toward the source, which matters more than how fast it runs:
//  - one request at a time, spaced SPACING_MS apart, ~25 a minute. That is less
//    traffic than one person browsing, and it is sustained rather than bursty.
//  - any error at all, and especially 429, stops the batch and backs off for
//    longer each time. It never retries into a wall.
//  - the User-Agent says who we are and how to reach us. If they want this to
//    stop, they should be able to say so without guessing who to ask.
//  - the catalogue is read through its own paging API, not scraped from pages.
//
// Everything is resumable: cursors live in D1, so an invocation killed halfway
// loses at most its current batch.

const UA = "AlphyTVIndexer/1.0 (+https://alphy.tv; contact: info@alphy.tv)";
const CATALOG = "https://api.zombie-film.live/v2/franchise/search/";
// NOT api.liftw.ws/info: the catalogue's `id` is a franchise id, and /info
// expects the player id from `video.embedUrl` — a different number entirely
// (Морок is 123800 in the catalogue and 92750 to the player). Asking /info with
// a franchise id answers 500 for every single title, which is exactly what it
// did. The catalogue's own view endpoint takes the slug and returns both the
// Kinopoisk id and the player id in one request, so it is also cheaper.
const VIEW = "https://api.zombie-film.live/v2/franchise/view/";
const PER_PAGE = 100;
// Cron fires every two minutes, so a batch should fill that window rather than
// work for fifty seconds and idle for seventy — that idling was costing half the
// throughput. Overrunning is safe: every page and every kpId is committed as it
// lands, so an invocation killed at any point loses nothing but its place in the
// current sleep, and the lease expires on its own.
const BUDGET_MS = 105_000;
const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000, 3_600_000];
// Where browsers actually read the index from. Cloudflare Workers are throttled
// from Russia, which is the audience, so the crawler builds here and publishes
// there; Supabase is already proven reachable from RU by the other relays.
const PUBLISH_URL = "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/titles";
const PUBLISH_BATCH = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SQLite's lower() is ASCII-only, so folding has to happen here or every
// Cyrillic shard comes back empty. ё is folded to е the same way the client's
// matcher does, or the two would disagree about shards.
//
// Leading punctuation is dropped for the same reason: the client strips it
// before it picks a letter, so «Авария» – дочь мента filed under « was in a
// shard no viewer can ever ask for. 101 titles were invisible that way.
const initialOf = (name) =>
  (String(name || "").replace(/[^\p{L}\p{N}]+/gu, "").trim()[0] || "").toLowerCase().replace(/ё/, "е");
const nowSec = () => Math.floor(Date.now() / 1000);

async function getMeta(db, key, fallback = null) {
  const row = await db.prepare("select value from meta where key = ?").bind(key).first();
  return row?.value ?? fallback;
}

async function setMeta(db, key, value) {
  await db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .bind(key, String(value)).run();
}

// A failure is the source telling us something. Back off further each time and
// only clear it after a clean batch, so a bad night cannot turn into a hammer.
async function noteFailure(db, reason) {
  const streak = Number(await getMeta(db, "fail_streak", "0")) + 1;
  const wait = BACKOFF_STEPS_MS[Math.min(streak - 1, BACKOFF_STEPS_MS.length - 1)];
  await setMeta(db, "fail_streak", streak);
  await setMeta(db, "paused_until", Date.now() + wait);
  await setMeta(db, "last_error", `${new Date().toISOString()} ${String(reason).slice(0, 200)}`);
}

async function noteSuccess(db) {
  if (Number(await getMeta(db, "fail_streak", "0")) > 0) await setMeta(db, "fail_streak", "0");
}

class SoftError extends Error {}

async function fetchJson(url, { soft = false } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  // 429 is always about us, never about the row, so it always backs off.
  if (response.status === 429) throw new Error("429 rate limited");
  if (!response.ok) {
    // One title answering 500 is that title's problem. Treating it as the
    // service refusing us stopped the batch and slept a minute for a single bad
    // row, which over a night of them means nothing gets indexed at all.
    if (soft) throw new SoftError(`http ${response.status}`);
    throw new Error(`http ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------- phase 1
// The catalogue, page by page. `sortBy=priority` puts what people actually
// watch first, which is also the order phase 2 then fills kpIds in.
async function crawlCatalog(env, db, deadline) {
  let page = Number(await getMeta(db, "catalog_page", "1"));
  const spacing = Number(env.SPACING_MS || 2000);
  let done = 0;

  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      findBy: "filter", all: "false", page: String(page),
      "per-page": String(PER_PAGE), sortBy: "priority", _format: "json",
    });
    let payload;
    try {
      payload = await fetchJson(`${CATALOG}?${query}`);
    } catch (error) {
      await noteFailure(db, `catalog p${page}: ${error.message}`);
      return done;
    }
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const total = Number(payload?.totalCount) || 0;
    if (total) await setMeta(db, "total_count", total);

    // The end of the catalogue does NOT look like an empty page: this API clamps
    // an out-of-range page and serves the last one again, forever. Waiting for
    // items.length === 0 spun past page 1278 re-fetching the same 100 titles —
    // hundreds of pointless requests at the source. Two independent stops now,
    // because either alone can be defeated by the catalogue growing mid-crawl.
    const firstId = String(items[0]?.id ?? "");
    const repeated = firstId && firstId === await getMeta(db, "last_first_id");
    const pastEnd = total > 0 && (page - 1) * PER_PAGE >= total;
    if (!items.length || repeated || pastEnd) {
      await setMeta(db, "catalog_page", "1");
      await setMeta(db, "last_first_id", "");
      await setMeta(db, "catalog_done_at", Date.now());
      return done;
    }
    await setMeta(db, "last_first_id", firstId);

    const seen = nowSec();
    const base = (page - 1) * PER_PAGE;
    // Insert leaves kp alone on conflict: phase 2's work must survive a re-crawl.
    const statement = db.prepare(
      `insert into titles (id, name, year, type, slug, rank, seen, initial, rate_kp, rate_imdb)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         name = excluded.name, year = excluded.year, type = excluded.type,
         slug = excluded.slug, rank = excluded.rank, seen = excluded.seen,
         initial = excluded.initial, rate_kp = excluded.rate_kp,
         rate_imdb = excluded.rate_imdb, dirty = 1`,
    );
    await db.batch(items.map((item, index) => statement.bind(
      Number(item.id), String(item.name || "").trim(),
      Number(item.year) || null, Number(item.type) || null,
      String(item.slug || ""), base + index, seen, initialOf(item.name),
      Number(item.rate?.kinopoisk) || null, Number(item.rate?.imdb) || null,
    )));

    page += 1;
    done += 1;
    await setMeta(db, "catalog_page", page);
    await noteSuccess(db);
    if (Date.now() + spacing >= deadline) break;
    await sleep(spacing);
  }
  return done;
}

// ---------------------------------------------------------------- phase 2
// One /info per title for its Kinopoisk id, which is the join key the rest of
// the site runs on. 81k requests is the expensive half, so it goes in priority
// order: the first few thousand cover nearly all real traffic, and the long
// tail can take days without anyone noticing.
async function fillKpIds(env, db, deadline) {
  const spacing = Number(env.SPACING_MS || 2000);
  const batch = Number(env.BATCH || 25);
  // NOT the catalogue's own order. `sortBy` is ignored upstream — every value
  // returns newest-first — so following it spent the first five thousand
  // requests on 2026 announcements, a third of which have no player at all and
  // most of which are not on Kinopoisk yet. A title that already carries a
  // Kinopoisk rating is one that exists and is worth resolving first.
  //
  // The ordering is bare `rate_kp desc` and must stay that way: SQLite sorts
  // NULL below every value, so DESC already puts unrated titles last, and the
  // explicit `(rate_kp is null)` term that used to lead it was both redundant
  // and the reason no index could serve the sort. Without one this full-scanned
  // all 81,702 rows every two minutes and exhausted D1's daily read limit in
  // under a day. `titles_pending` is a partial index whose predicate matches
  // this WHERE exactly — change either and the index silently stops being used.
  // `kp is null` alone permanently skipped 10,827 rows: origin_name was added to
  // this write after the crawl was already thousands of titles deep, and a row
  // that had its kp by then was never asked again. Those are the earliest rows,
  // which — because phase 2 runs in rating order — are the most-watched titles
  // on the site: Интерстеллар and Оппенгеймер both carry a kp and a player id
  // and no original name at all, so neither can be found by typing its English
  // title. Anything still missing either field is pending.
  const pending = await db.prepare(
    `select id, slug from titles
     where (kp is null or origin_name is null) and tries < 3 and slug <> ''
     order by rate_kp desc, year desc
     limit ?`,
  ).bind(batch).all();
  const rows = pending?.results ?? [];
  let done = 0;
  // Consecutive, not total: scattered bad rows are normal, a run of them means
  // the service itself is unhappy and we should stop asking.
  let softStreak = 0;

  for (const row of rows) {
    if (Date.now() >= deadline) break;
    let payload;
    try {
      const ask = (season) => fetchJson(`${VIEW}?${new URLSearchParams({
        slug: row.slug, findBy: "init", all: "false", season, _format: "json",
      })}`, { soft: true });
      payload = await ask("");
      // A series answers video:null until a season is named — the episodes hold
      // the player, not the title. Without this every series was recorded as
      // having no player and refused to open from a suggestion.
      if (!payload?.view?.video) payload = (await ask("1")) ?? payload;
      softStreak = 0;
    } catch (error) {
      if (error instanceof SoftError) {
        await db.prepare("update titles set tries = tries + 1 where id = ?").bind(row.id).run();
        softStreak += 1;
        await setMeta(db, "last_soft_error", `${new Date().toISOString()} info ${row.id}: ${error.message}`);
        if (softStreak >= 5) {
          await noteFailure(db, `five in a row, last ${row.id}: ${error.message}`);
          return done;
        }
        if (Date.now() + spacing >= deadline) break;
        await sleep(spacing);
        continue;
      }
      await noteFailure(db, `info ${row.id}: ${error.message}`);
      return done;
    }
    // "" rather than null: a title genuinely without a Kinopoisk id must not be
    // asked again every single run. A brand new release legitimately has kpId 0.
    const view = payload?.view ?? {};
    const raw = String(view.kpId ?? "");
    const kp = /^\d+$/.test(raw) && raw !== "0" ? raw : "";
    // The id the player actually needs, which is not the one the catalogue lists.
    const embed = Number(String(view.video?.embedUrl || "").match(/\/(\d+)/)?.[1]) || null;
    // The original title is only in the per-title view, so it rides along here
    // rather than costing a request of its own. seasonLast is the honest series
    // signal: the type codes do not separate them (1,2 are films; 3,4,5 all have
    // seasons), which is why half the suggestions were mislabelled.
    const isSeries = (view.season || view.seasonLast) ? 1 : 0;
    // "" rather than null for the same reason as kp: a Russian film has no
    // original title, and null now means "never asked". Leaving it null would
    // put every such row back in the pending set on every single run, forever.
    await db.prepare(
      "update titles set kp = ?, embed_id = ?, origin_name = ?, is_series = ?, dirty = 1 where id = ?",
    ).bind(kp, embed, String(view.originName || ""), isSeries, row.id).run();
    done += 1;
    await noteSuccess(db);
    if (Date.now() + spacing >= deadline) break;
    await sleep(spacing);
  }
  return done;
}

// Rows are published as they change rather than in a nightly dump: a dump would
// mean the index is stale for a day after every crawl, and this costs nothing —
// it is our own server, not the source's.
async function publish(env, db, deadline) {
  if (!env.PUSH_TOKEN) return 0;
  let sent = 0;
  while (Date.now() < deadline) {
    const rows = await db.prepare(
      `select id, name, year, type, slug, initial, embed_id, kp, rate_kp,
              origin_name, is_series
       from titles where dirty = 1 limit ?`,
    ).bind(PUBLISH_BATCH).all();
    const list = rows?.results ?? [];
    if (!list.length) break;
    const response = await fetch(PUBLISH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-push-token": env.PUSH_TOKEN },
      body: JSON.stringify(list.map((r) => ({
        id: r.id, name: r.name, year: r.year, type: r.type, slug: r.slug,
        initial: r.initial, embed_id: r.embed_id, kp: r.kp, rate_kp: r.rate_kp,
        origin_name: r.origin_name, is_series: r.is_series === null ? null : !!r.is_series,
      }))),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await setMeta(db, "last_publish_error", `${new Date().toISOString()} ${response.status}`);
      break;
    }
    // Only cleared after the write is confirmed, so a failed push is simply
    // retried next run rather than silently losing rows.
    const ids = list.map((r) => r.id).join(",");
    await db.prepare(`update titles set dirty = 0 where id in (${ids})`).run();
    sent += list.length;
  }
  if (sent) await setMeta(db, "published_at", Date.now());
  return sent;
}

// Turn the rows just published into static shards. Viewers read those objects
// from a CDN and never reach a function or the database, so this is what makes
// a push visible. Bounded on the far side — it rebuilds a few letters per call —
// and it is simply asked again on the next tick until nothing is left dirty.
async function rebuildShards(env, db) {
  if (!env.PUSH_TOKEN) return null;
  try {
    const response = await fetch(`${PUBLISH_URL}/build?max=6`, {
      method: "POST",
      headers: { "x-push-token": env.PUSH_TOKEN },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const body = await response.json();
    if (body?.failed?.length) {
      await setMeta(db, "last_build_error", `${new Date().toISOString()} ${body.failed[0]}`);
    }
    return body;
  } catch (error) {
    // A build that did not happen is not a reason to stop crawling: the letters
    // stay queued and the next tick tries again.
    await setMeta(db, "last_build_error", `${new Date().toISOString()} ${String(error).slice(0, 160)}`);
    return null;
  }
}

async function runOnce(env) {
  const db = env.DB;
  const pausedUntil = Number(await getMeta(db, "paused_until", "0"));
  if (Date.now() < pausedUntil) return { skipped: "backoff" };

  // Two tick sources drive this (Cloudflare cron and an external heartbeat), so
  // overlapping runs are expected. A lease keeps the pace honest: without it two
  // runners would double the request rate at the source, which is the one thing
  // this crawler must not do. It expires on its own so a killed run cannot wedge
  // the pipeline shut.
  const lease = Number(await getMeta(db, "running_until", "0"));
  if (Date.now() < lease) return { skipped: "locked" };
  await setMeta(db, "running_until", Date.now() + BUDGET_MS + 10_000);
  await setMeta(db, "ticks", Number(await getMeta(db, "ticks", "0")) + 1);
  await setMeta(db, "last_tick", new Date().toISOString());

  const deadline = Date.now() + BUDGET_MS;
  const catalogDone = await getMeta(db, "catalog_done_at");
  // The catalogue comes first: it is only 817 requests and it is what makes the
  // index usable at all. kpIds enrich an index that already works.
  try {
    // Rows written before `initial` existed have to be folded too, or they are
    // invisible to every shard query. Done a chunk at a time inside the normal
    // run so it needs no second scheduler, and it touches nobody's server.
    const stale = await db.prepare(
      "select id, name from titles where initial is null limit 900",
    ).all();
    const staleRows = stale?.results ?? [];
    if (staleRows.length) {
      const fix = db.prepare("update titles set initial = ? where id = ?");
      await db.batch(staleRows.map((row) => fix.bind(initialOf(row.name), row.id)));
    }

    if (!catalogDone) {
      const pages = await crawlCatalog(env, db, deadline);
      if (Date.now() < deadline && (await getMeta(db, "catalog_done_at"))) {
        const filled = await fillKpIds(env, db, deadline);
        return { pages, filled };
      }
      return { pages };
    }
    // Publish what earlier ticks filled before filling more. The free plan
    // kills an invocation the moment it has used 10 ms of CPU, wherever it
    // stands, and publishing last meant a killed tick stranded its fills in D1:
    // from 16:17 on 11 September every scheduled tick was killed mid-fill
    // (`exceededCpu` at ~7 s) and nothing reached Supabase at all.
    const published = await publish(env, db, Date.now() + 20_000);
    const shards = await rebuildShards(env, db);
    const filled = await fillKpIds(env, db, deadline);
    return { published, shards, filled };
  } finally {
    await setMeta(db, "running_until", "0");
  }
}

async function status(db) {
  const totals = await db.prepare(
    `select count(*) as titles,
            sum(case when kp is null then 0 else 1 end) as with_kp,
            sum(case when kp = '' then 1 else 0 end) as no_kp_upstream
     from titles`,
  ).first();
  const meta = await db.prepare("select key, value from meta").all();
  const bag = Object.fromEntries((meta?.results ?? []).map((r) => [r.key, r.value]));
  const total = Number(bag.total_count || 0);
  const withKp = Number(totals?.with_kp || 0);
  const pending = Math.max(0, Number(totals?.titles || 0) - withKp);
  // 25 a minute is the configured pace; this is the honest remaining wall time.
  const hoursLeft = pending / 25 / 60;

  return {
    каталог: {
      собрано: Number(totals?.titles || 0),
      всего_у_источника: total || null,
      готов: !!bag.catalog_done_at,
      страница_курсора: Number(bag.catalog_page || 1),
    },
    kpid: {
      заполнено: withKp,
      с_id_плеера: Number((await db.prepare(
        "select count(*) as n from titles where embed_id is not null").first())?.n || 0),
      осталось: pending,
      без_kpid_у_источника: Number(totals?.no_kp_upstream || 0),
      осталось_часов: Number(hoursLeft.toFixed(1)),
    },
    состояние: {
      пауза_до: Number(bag.paused_until || 0) > Date.now()
        ? new Date(Number(bag.paused_until)).toISOString() : null,
      неудач_подряд: Number(bag.fail_streak || 0),
      без_первой_буквы: Number((await db.prepare(
        "select count(*) as n from titles where initial is null").first())?.n || 0),
      последний_тик: bag.last_tick || null,
      ждут_публикации: Number((await db.prepare(
        "select count(*) as n from titles where dirty = 1").first())?.n || 0),
      ошибка_публикации: bag.last_publish_error || null,
      последняя_ошибка: bag.last_error || null,
      последняя_мелкая_ошибка: bag.last_soft_error || null,
      пропущено_битых: Number((await db.prepare(
        "select count(*) as n from titles where kp is null and tries >= 3").first())?.n || 0),
    },
    темп: "по одному запросу, интервал 2 с, окно 105 с из каждых 120",
  };
}

export default {
  async scheduled(_event, env, ctx) {
    // Record the failure rather than swallowing it: a cron that dies silently
    // looks exactly like a cron that is not firing, and the two need different
    // fixes at three in the morning.
    ctx.waitUntil(runOnce(env).catch((error) => setMeta(env.DB, "last_error",
      `${new Date().toISOString()} scheduled: ${String(error?.stack || error).slice(0, 300)}`)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const json = (body, code = 200) => new Response(JSON.stringify(body, null, 1), {
      status: code,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });

    // Manual kick, for when something needs looking at without waiting a minute.
    if (url.pathname === "/run") {
      try {
        return json({ ok: true, ...(await runOnce(env)) });
      } catch (error) {
        return json({ ok: false, error: String(error?.stack || error).slice(0, 600) }, 500);
      }
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return json(await status(env.DB));
    }

    // A shard of the index: every title whose name starts with one letter.
    // This is what the browser downloads once and then matches locally.
    if (url.pathname.startsWith("/index/")) {
      const letter = decodeURIComponent(url.pathname.slice("/index/".length)).replace(/\.json$/, "");
      if ([...letter].length !== 1) return json({ error: "one letter" }, 400);
      const rows = await env.DB.prepare(
        // Announcements with no player are excluded once we know that: offering
        // one is a dead end. Rows not yet resolved stay in — they are probably
        // playable and cost only a resolve when opened.
        `select id, embed_id, slug, name, year, type, kp from titles
         where initial = ? and not (kp is not null and embed_id is null)
         order by year desc, name asc`,
      ).bind(initialOf(letter)).all();
      return new Response(
        // The slug is what makes a suggestion openable without phase 2 having
        // reached it: one /franchise/view/ on click returns both the player id
        // and the kpId, which is what opening any title costs anyway. That is
        // why the index is usable in full today while the backfill is at 6%.
        JSON.stringify((rows?.results ?? []).map((r) => [
          r.name, r.year, r.slug, r.type, r.embed_id || null, r.kp || "",
        ])),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        },
      );
    }

    return json({ error: "not found" }, 404);
  },
};
