import test from "node:test";
import assert from "node:assert/strict";

import {
  createKinoPubResolver,
  decodeSignedMediaToken,
  selectMediaFile,
} from "../resolver-deno/kinopub-core.js";

const NOW_MS = 1_784_293_500_000;

function signedUrl(mediaId = "1130533", file = "1130533.m3u8") {
  const issued = Math.floor(NOW_MS / 1000);
  const decoded =
    `id=1461895;760572371;46626577;${mediaId};${issued}&h=TsJlmX9HWaxyTKjfjlHwXQ&e=${
      issued + 86400
    }`;
  const token = Buffer.from(decoded).toString("base64url");
  return `https://api.srvkp.com/manifest/hls4/${token}/${file}`;
}

function itemPayload(mediaId = "1130533", url = signedUrl(mediaId)) {
  return {
    status: 200,
    item: {
      id: 121792,
      title: "Avatar",
      type: "movie",
      videos: [{
        id: Number(mediaId),
        files: [
          {
            quality: "1080p",
            codec: "h265",
            w: 1920,
            h: 1032,
            url: { hls4: url.replace("1130533.m3u8", "1080.m3u8") },
          },
          {
            quality: "2160p",
            codec: "h265",
            w: 3840,
            h: 2064,
            url: { hls4: url },
          },
        ],
      }],
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    KINOPUB_ACCESS_TOKEN: "access-old",
    KINOPUB_REFRESH_TOKEN: "refresh-old",
    KINOPUB_ACCESS_EXPIRES_AT: String(Math.floor(NOW_MS / 1000) + 3600),
    KINOPUB_CLIENT_ID: "client",
    KINOPUB_CLIENT_SECRET: "secret",
    KINOPUB_RESOLVER_KEY: "resolver-secret",
    KINOPUB_ALLOWED_ORIGINS: "https://tv.example",
    ...overrides,
  };
}

test("decodes the signed media capability without exposing h", () => {
  assert.deepEqual(decodeSignedMediaToken(signedUrl()), {
    accountId: "1461895",
    ipUint32: "760572371",
    deviceId: "46626577",
    mediaId: "1130533",
    issuedAt: Math.floor(NOW_MS / 1000),
    expiresAt: Math.floor(NOW_MS / 1000) + 86400,
    ttlSeconds: 86400,
  });
});

test("selects an exact requested quality or the best rendition", () => {
  const item = itemPayload().item;
  assert.equal(
    selectMediaFile(item, { quality: "2160p", stream: "hls4" }).file.w,
    3840,
  );
  assert.equal(
    selectMediaFile(item, { quality: "best", stream: "hls4" }).file.w,
    3840,
  );
});

test("requires the private resolver bearer key", async () => {
  const handler = createKinoPubResolver({
    env: baseEnv(),
    now: () => NOW_MS,
    fetchImpl: async () => assert.fail("upstream must not be called"),
  });
  const response = await handler(
    new Request("https://resolver.test/v1/kinopub/resolve?item=121792"),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("returns a real 2160p URL without proxying media bytes", async () => {
  let authorization = "";
  const handler = createKinoPubResolver({
    env: baseEnv(),
    now: () => NOW_MS,
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return Response.json(itemPayload());
    },
  });
  const request = new Request(
    "https://resolver.test/v1/kinopub/resolve?item=121792&quality=2160p",
    {
      headers: {
        authorization: "Bearer resolver-secret",
        origin: "https://tv.example",
      },
    },
  );
  const response = await handler(request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://tv.example",
  );
  assert.equal(authorization, "Bearer access-old");
  assert.equal(body.media.quality, "2160p");
  assert.equal(body.media.width, 3840);
  assert.equal(body.signed.ttlSeconds, 86400);
  assert.match(body.manifestUrl, /^https:\/\//);
});

test("searches the catalog and returns only frontend-safe metadata", async () => {
  let upstreamUrl = "";
  const handler = createKinoPubResolver({
    env: baseEnv(),
    now: () => NOW_MS,
    fetchImpl: async (url, init) => {
      upstreamUrl = String(url);
      assert.equal(init.headers.authorization, "Bearer access-old");
      return Response.json({
        status: 200,
        pagination: { total: 2, current: 1, perpage: 50, total_items: 51 },
        items: [{
          id: 121792,
          type: "movie",
          subtype: "",
          title: "Avatar",
          year: 2025,
          quality: 2160,
          poor_quality: 0,
          duration: 11520,
          plot: "Plot",
          posters: {
            small: "https://img/s.jpg",
            medium: "https://img/m.jpg",
            wide: "https://img/w.jpg",
          },
          genres: [{ id: 6, title: "Science fiction" }],
          countries: [{ id: 1, title: "USA" }],
          kinopoisk_rating: "7.8",
          imdb_rating: 7.5,
          files: [{ url: { hls4: "must-not-leak" } }],
          private_upstream_field: "must-not-leak",
        }],
      });
    },
  });
  const response = await handler(
    new Request(
      "https://resolver.test/v1/kinopub/search?q=%D0%90%D0%B2%D0%B0%D1%82%D0%B0%D1%80&type=movie&page=1",
      {
        headers: {
          authorization: "Bearer resolver-secret",
          origin: "https://tv.example",
        },
      },
    ),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(
    upstreamUrl,
    /\/items\?title=%D0%90%D0%B2%D0%B0%D1%82%D0%B0%D1%80&page=1&type=movie$/,
  );
  assert.equal(body.items[0].id, 121792);
  assert.equal(body.items[0].quality, 2160);
  assert.equal(body.items[0].poster, "https://img/m.jpg");
  assert.deepEqual(body.items[0].ratings, { kinopoisk: 7.8, imdb: 7.5 });
  assert.equal(body.pagination.totalItems, 51);
  assert.equal(body.items[0].files, undefined);
  assert.equal(body.items[0].private_upstream_field, undefined);
});

test("validates search input before calling the upstream API", async () => {
  const handler = createKinoPubResolver({
    env: baseEnv(),
    now: () => NOW_MS,
    fetchImpl: async () => assert.fail("upstream must not be called"),
  });
  const authorized = { headers: { authorization: "Bearer resolver-secret" } };
  const shortQuery = await handler(
    new Request(
      "https://resolver.test/v1/kinopub/search?q=a",
      authorized,
    ),
  );
  assert.equal(shortQuery.status, 400);
  assert.equal((await shortQuery.json()).error, "invalid_query");

  const badType = await handler(
    new Request(
      "https://resolver.test/v1/kinopub/search?q=avatar&type=unknown",
      authorized,
    ),
  );
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).error, "invalid_type");
});

test("rejects never-Pro demo URLs even when item metadata says 2160p", async () => {
  const demoUrl = signedUrl("-1", "demo.m3u8");
  const handler = createKinoPubResolver({
    env: baseEnv(),
    now: () => NOW_MS,
    fetchImpl: async () => Response.json(itemPayload("-1", demoUrl)),
  });
  const response = await handler(
    new Request(
      "https://resolver.test/v1/kinopub/resolve?item=121792&quality=2160p",
      { headers: { authorization: "Bearer resolver-secret" } },
    ),
  );
  const body = await response.json();
  assert.equal(response.status, 402);
  assert.equal(body.error, "subscription_inactive");
});

test("rotates an expired refresh token before calling the media API", async () => {
  const calls = [];
  const handler = createKinoPubResolver({
    env: baseEnv({
      KINOPUB_ACCESS_EXPIRES_AT: String(Math.floor(NOW_MS / 1000) - 1),
    }),
    now: () => NOW_MS,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth2/token")) {
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 86400,
        });
      }
      assert.equal(init.headers.authorization, "Bearer access-new");
      return Response.json(itemPayload());
    },
  });
  const response = await handler(
    new Request(
      "https://resolver.test/v1/kinopub/resolve?item=121792",
      { headers: { authorization: "Bearer resolver-secret" } },
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /oauth2\/token/);
  assert.match(String(calls[0].init.body), /refresh_token=refresh-old/);
});
