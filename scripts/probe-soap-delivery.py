#!/usr/bin/env python3
"""Probe SOAP HLS delivery without printing signed URLs.

The regular catalog check answers a narrow yes/no question: can alphy.tv fetch a
stored master playlist anonymously? This diagnostic script goes deeper and
checks master -> variant -> first media segment under several HTTP contexts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "soap-movies.json"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)
ALPHY = "https://alphy.tv/"
SOAP_MOVIES = "https://soap4youand.me/movies/"


@dataclass
class ProbeResult:
    label: str
    status: int
    ok: bool
    bytes_read: int
    content_type: str
    acao: str
    body: str
    error: str


CONTEXTS: list[tuple[str, dict[str, str | None]]] = [
    ("extractor", {"Referer": SOAP_MOVIES, "Accept": None}),
    ("bare", {}),
    ("browser", {"Origin": "https://alphy.tv", "Referer": ALPHY}),
    ("alphy-ref", {"Referer": ALPHY}),
    ("soap-ref", {"Referer": SOAP_MOVIES}),
]


def is_priority(movie: dict[str, Any]) -> bool:
    return movie.get("q") == "4K" or int(movie.get("w") or 0) > 1920 or int(movie.get("h") or 0) > 1080


def load_movies(scope: str, limit: int) -> list[dict[str, Any]]:
    with CATALOG_PATH.open() as file:
        catalog = json.load(file)
    movies = [movie for movie in catalog.get("movies", []) if movie.get("m")]
    priority = [movie for movie in movies if is_priority(movie)]
    rest = [movie for movie in movies if not is_priority(movie)]
    if os.getenv("SOAP_PROBE_RECENT") == "1":
        priority.sort(key=lambda movie: int(movie.get("refreshed") or 0), reverse=True)
        rest.sort(key=lambda movie: int(movie.get("refreshed") or 0), reverse=True)
    ordered = priority if scope == "priority" else priority + rest
    return ordered[:limit] if limit > 0 else ordered


def fetch_probe(url: str, label: str, headers: dict[str, str | None], *, is_segment: bool = False, timeout: float = 12.0) -> ProbeResult:
    request_headers = {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*",
    }
    for key, value in headers.items():
        if value is None:
            request_headers.pop(key, None)
        else:
            request_headers[key] = value
    if is_segment:
        request_headers["Accept"] = "*/*"
        request_headers["Range"] = "bytes=0-1023"

    request = urllib.request.Request(url, headers=request_headers)
    status = 0
    body = b""
    content_type = ""
    acao = ""
    error = ""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            content_type = response.headers.get("content-type", "")
            acao = response.headers.get("access-control-allow-origin", "")
            body = response.read(65536 if not is_segment else 2048)
    except urllib.error.HTTPError as exc:
        status = exc.code
        content_type = exc.headers.get("content-type", "") if exc.headers else ""
        acao = exc.headers.get("access-control-allow-origin", "") if exc.headers else ""
        body = exc.read(512) if exc.fp else b""
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"

    text = body.decode("utf-8", "replace") if not is_segment else ""
    ok = status in (200, 206) and bool(body) if is_segment else status == 200 and "#EXTM3U" in text
    return ProbeResult(label, status, ok, len(body), content_type, acao, text, error)


def compact(result: ProbeResult) -> str:
    status = result.status or "ERR"
    ok = "ok" if result.ok else "fail"
    type_part = f" type={result.content_type}" if result.content_type else ""
    acao_part = f" acao={result.acao}" if result.acao else ""
    error_part = f" err={result.error}" if result.error else ""
    return f"{result.label}:{status}/{ok} bytes={result.bytes_read}{type_part}{acao_part}{error_part}"


def first_ok_text(results: list[ProbeResult]) -> str:
    for preferred in ("browser", "bare", "alphy-ref", "soap-ref"):
        for result in results:
            if result.label == preferred and result.ok:
                return result.body
    return ""


def first_variant(master_url: str, master_text: str) -> str:
    lines = [line.strip() for line in master_text.splitlines()]
    for index, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            for candidate in lines[index + 1 :]:
                if candidate and not candidate.startswith("#"):
                    return urllib.parse.urljoin(master_url, candidate)
    return ""


def first_segment(variant_url: str, variant_text: str) -> str:
    map_match = re.search(r'#EXT-X-MAP:[^\n]*URI="([^"]+)"', variant_text)
    if map_match:
        return urllib.parse.urljoin(variant_url, map_match.group(1))
    for line in variant_text.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#"):
            return urllib.parse.urljoin(variant_url, candidate)
    return ""


def probe_url(url: str, *, is_segment: bool = False) -> list[ProbeResult]:
    return [fetch_probe(url, label, headers, is_segment=is_segment) for label, headers in CONTEXTS]


def probe_movie(movie: dict[str, Any]) -> bool:
    title = str(movie.get("t") or "")
    print(f"SOAP PROBE id={movie.get('id')} q={movie.get('q')} title={title[:80]!r}")

    master_results = probe_url(movie["m"])
    print("  master  " + " | ".join(compact(result) for result in master_results))
    master_text = first_ok_text(master_results)
    if not master_text:
        print("  verdict master-unreadable")
        return False

    variant_url = first_variant(movie["m"], master_text)
    if not variant_url:
        print("  verdict no-variant-in-master")
        return False

    variant_results = probe_url(variant_url)
    print("  variant " + " | ".join(compact(result) for result in variant_results))
    variant_text = first_ok_text(variant_results)
    if not variant_text:
        print("  verdict variant-unreadable")
        return False

    segment_url = first_segment(variant_url, variant_text)
    if not segment_url:
        print("  verdict no-segment-in-variant")
        return False

    segment_results = probe_url(segment_url, is_segment=True)
    print("  segment " + " | ".join(compact(result) for result in segment_results))
    browser_ok = next((result.ok for result in segment_results if result.label == "browser"), False)
    verdict = "browser-playable" if browser_ok else "browser-blocked"
    print(f"  verdict {verdict}")
    return browser_ok


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", choices=["sample", "priority", "all"], default=os.getenv("SOAP_PROBE_SCOPE", "priority"))
    parser.add_argument("--limit", type=int, default=int(os.getenv("SOAP_PROBE_LIMIT") or "3"))
    args = parser.parse_args()

    movies = load_movies(args.scope, args.limit)
    if not movies:
        print(f"No SOAP movies to probe for scope={args.scope}", file=sys.stderr)
        raise SystemExit(1)

    ok = 0
    for movie in movies:
        if probe_movie(movie):
            ok += 1
    print(f"SOAP PROBE SUMMARY browser_playable={ok}/{len(movies)} scope={args.scope} limit={args.limit}")


if __name__ == "__main__":
    main()
