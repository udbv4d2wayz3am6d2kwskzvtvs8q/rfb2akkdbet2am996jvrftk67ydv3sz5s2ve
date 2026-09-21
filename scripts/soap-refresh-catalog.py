#!/usr/bin/env python3
"""
Refresh the static SOAP movie catalog.

Credentials are read only from SOAP_LOGIN/SOAP_PASSWORD. The script prints no
passwords, cookies, account tokens, or media URLs. It writes the lean frontend
catalog directly to soap-movies.json; no authenticated HTML/session dump is kept.

Default refresh order prioritizes movies whose current or refreshed ladder is
above 1080p, then refreshes the rest so the full catalog remains available.
"""

from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "soap-movies.json"
BASE = "https://soap4youand.me"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name) or default)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name) or default)
    except ValueError:
        return default


def build_opener(with_cookies: bool) -> urllib.request.OpenerDirector:
    if with_cookies:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    else:
        opener = urllib.request.build_opener()
    opener.addheaders = [
        ("User-Agent", UA),
        ("Accept-Language", "en-US,en;q=0.9"),
        ("Referer", BASE + "/movies/"),
    ]
    return opener


AUTH = build_opener(with_cookies=True)
ANON = build_opener(with_cookies=False)


def get(
    opener: urllib.request.OpenerDirector,
    url: str,
    data: bytes | None = None,
    tries: int = 3,
    timeout: int = 30,
) -> tuple[int, str, str]:
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, data=data)
            with opener.open(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", "replace")
                return response.status, response.geturl(), body
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace") if error.fp else ""
            return error.code, url, body
        except Exception as error:
            if attempt == tries - 1:
                return -1, url, f"{type(error).__name__}: {error}"
            time.sleep(1.0 + attempt * 1.4)
    return -1, url, ""


def login() -> None:
    username = os.getenv("SOAP_LOGIN")
    password = os.getenv("SOAP_PASSWORD")
    if not username or not password:
        raise SystemExit("SOAP_LOGIN and SOAP_PASSWORD are required for refresh.")
    get(AUTH, BASE + "/")
    form = urllib.parse.urlencode({"login": username, "password": password}).encode()
    get(AUTH, BASE + "/login/", data=form)
    status, final_url, _ = get(AUTH, BASE + "/dashboard/")
    if status != 200 or "login" in final_url:
        raise SystemExit("SOAP login failed or session did not become authenticated.")


def load_current_catalog() -> dict[str, Any]:
    if not CATALOG_PATH.exists():
        return {"movies": []}
    with CATALOG_PATH.open() as file:
        return json.load(file)


def current_by_id(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(movie.get("id")): movie for movie in catalog.get("movies", []) if movie.get("id")}


def is_priority_movie(movie: dict[str, Any] | None) -> bool:
    if not movie:
        return False
    width = int(movie.get("w") or 0)
    height = int(movie.get("h") or 0)
    # User-facing "4K" shelf intentionally means every movie above 1080p,
    # including 1440p/1600p/wider UHD crops, not only exact 3840-wide masters.
    return movie.get("q") == "4K" or width > 1920 or height > 1080


def extract_movie_ids(listing: str) -> list[str]:
    ids = sorted(set(re.findall(r'href="/movies/(\d+)/"', listing)), key=lambda value: int(value))
    if not ids:
        raise SystemExit("No movie ids found on /movies/.")
    return ids


def clean_text(value: str) -> str:
    return html.unescape(re.sub(r"\s+", " ", value or "")).strip()


def absolute_url(value: str | None) -> str:
    if not value:
        return ""
    if value.startswith("//"):
        return "https:" + value
    if value.startswith("/"):
        return BASE + value
    return value


def parse_master(master_text: str) -> dict[str, Any] | None:
    if "#EXTM3U" not in master_text or "#EXT-X-STREAM-INF" not in master_text:
        return None
    resolutions = [(int(w), int(h)) for w, h in re.findall(r"RESOLUTION=(\d+)x(\d+)", master_text)]
    unique = sorted(set(resolutions))
    max_width = max((w for w, _ in unique), default=0)
    max_height = max((h for _, h in unique), default=0)
    if max_width > 1920 or max_height > 1080:
        quality = "4K"
    elif max_width >= 1700 or max_height >= 900:
        quality = "1080"
    elif max_width >= 1000 or max_height >= 540:
        quality = "720"
    else:
        quality = "SD" if max_width or max_height else "?"
    audio = sorted(set(re.findall(r'TYPE=AUDIO[^\n]*?NAME="([^"]+)"', master_text)))
    subtitles = sorted(set(re.findall(r'TYPE=SUBTITLES[^\n]*?NAME="([^"]+)"', master_text)))
    return {
        "q": quality,
        "w": max_width,
        "h": max_height,
        "res": [f"{w}x{h}" for w, h in unique],
        "a": audio,
        "s": subtitles,
    }


def scrape_movie(movie_id: str) -> tuple[dict[str, Any] | None, str]:
    status, _, page = get(AUTH, f"{BASE}/movies/{movie_id}/")
    if status != 200 or not page:
        return None, f"page_{status}"

    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    title = clean_text(re.sub(r"<[^>]+>", "", title_match.group(1))) if title_match else f"Movie {movie_id}"
    year_match = re.search(r"\b(19|20)\d{2}\b", title_match.group(1) if title_match else page[:2500])
    year = year_match.group(0) if year_match else ""
    poster_match = (
        re.search(r'<img[^>]*class="[^"]*poster[^"]*"[^>]*src="([^"]+)"', page)
        or re.search(r'poster:\s*["\']([^"\']+)["\']', page)
    )
    poster = absolute_url(poster_match.group(1)) if poster_match else ""
    file_match = re.search(r'file:\s*["\']([^"\']+)["\']', page)
    if not file_match:
        return None, "no_file"

    master = file_match.group(1).replace("\\/", "/")
    status, _, master_text = get(ANON, master, tries=2, timeout=18)
    parsed = parse_master(master_text) if status == 200 else None
    if not parsed:
        return None, f"m3u8_{status}"

    return {
        "id": str(movie_id),
        "t": title,
        "y": year,
        "q": parsed["q"],
        "w": parsed["w"],
        "h": parsed["h"],
        "m": master,
        "a": parsed["a"],
        "s": parsed["s"],
        "refreshed": int(time.time()),
        **({"p": poster} if poster else {}),
    }, ""


def ordered_ids(scope: str, ids: list[str], existing: dict[str, dict[str, Any]]) -> list[str]:
    priority = [movie_id for movie_id in ids if is_priority_movie(existing.get(movie_id))]
    rest = [movie_id for movie_id in ids if movie_id not in set(priority)]
    if scope == "priority":
        return priority
    return priority + rest


def write_catalog(movies_by_id: dict[str, dict[str, Any]], previous_generated: int | None = None) -> None:
    movies = sorted(movies_by_id.values(), key=lambda item: (str(item.get("t") or "").lower(), int(item.get("id") or 0)))
    now = int(time.time())
    doc = {
        "generated": now,
        "previousGenerated": previous_generated or None,
        "count": len(movies),
        "fourk": sum(1 for movie in movies if is_priority_movie(movie)),
        "movies": movies,
    }
    tmp = CATALOG_PATH.with_suffix(".json.tmp")
    with tmp.open("w") as file:
        json.dump(doc, file, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(CATALOG_PATH)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", choices=["full", "priority"], default=os.getenv("SOAP_REFRESH_SCOPE", "full"))
    parser.add_argument("--limit", type=int, default=env_int("SOAP_LIMIT", 0))
    parser.add_argument("--delay", type=float, default=env_float("SOAP_DELAY", 0.9))
    parser.add_argument("--save-every", type=int, default=env_int("SOAP_SAVE_EVERY", 50))
    args = parser.parse_args()

    current = load_current_catalog()
    existing = current_by_id(current)
    login()
    status, _, listing = get(AUTH, BASE + "/movies/")
    if status != 200:
        raise SystemExit(f"Failed to read /movies/: {status}")

    ids = extract_movie_ids(listing)
    plan = ordered_ids(args.scope, ids, existing)
    if args.limit:
        plan = plan[: args.limit]
    if not plan:
        raise SystemExit("Refresh plan is empty.")

    refreshed: dict[str, dict[str, Any]] = {}
    failed: list[tuple[str, str]] = []
    started = time.time()
    print(f"SOAP refresh: scope={args.scope} planned={len(plan)} total_ids={len(ids)} priority_known={sum(1 for m in existing.values() if is_priority_movie(m))}")

    for index, movie_id in enumerate(plan, 1):
        if index > 1 and index % 100 == 1:
            login()
        movie, error = scrape_movie(movie_id)
        if movie:
            refreshed[movie_id] = movie
        else:
            failed.append((movie_id, error))
        if index % args.save_every == 0 or index == len(plan):
            # Keep old entries for ids not covered by this run. Covered-but-failed
            # ids are excluded, so broken masters are not republished as fresh.
            merged = {mid: item for mid, item in existing.items() if mid not in set(plan)}
            merged.update(refreshed)
            write_catalog(merged, previous_generated=current.get("generated"))
            done = len(refreshed)
            eta = (time.time() - started) / index * (len(plan) - index) if index else 0
            print(f"[{index}/{len(plan)}] ok={done} failed={len(failed)} eta~{eta/60:.1f}m")
        time.sleep(args.delay + random.uniform(0, args.delay))

    merged = {mid: item for mid, item in existing.items() if mid not in set(plan)}
    merged.update(refreshed)
    write_catalog(merged, previous_generated=current.get("generated"))
    priority_count = sum(1 for movie in merged.values() if is_priority_movie(movie))
    print(f"SOAP refresh done: catalog={len(merged)} priority>1080p={priority_count} failed={len(failed)}")
    for movie_id, error in failed[:15]:
        print(f"refresh-fail id={movie_id} {error}")

    if args.scope == "priority" and not refreshed:
        raise SystemExit("Priority refresh produced no usable movies.")
    if args.scope == "full" and len(refreshed) < max(10, len(plan) * 0.85):
        raise SystemExit("Full refresh produced too few usable movies; refusing to treat it as healthy.")


if __name__ == "__main__":
    main()
