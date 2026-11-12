# -*- coding: utf-8 -*-
"""End-to-end backend tests: translations, streaming ASR, media range, web."""

from __future__ import annotations

import functools
import http.server
import base64
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
import wave
from http.server import ThreadingHTTPServer

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("LILAC_DATA_DIR", os.path.join(ROOT, "tests", "test_data"))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import server as backend  # noqa: E402


def post(base, path, payload=None, raw=None):
    data = raw if raw is not None else json.dumps(payload or {}).encode("utf-8")
    headers = {"Content-Type": "application/octet-stream" if raw is not None else "application/json"}
    req = urllib.request.Request(base + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def load_16k(path):
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        target = int(len(data) / rate * 16000)
        data = np.interp(
            np.linspace(0, 1, target, dtype=np.float32),
            np.linspace(0, 1, len(data), dtype=np.float32),
            data,
        ).astype(np.float32)
    return (np.clip(data, -1, 1) * 32767).astype(np.int16).tobytes()


def main():
    os.environ.setdefault("LILAC_DATA_DIR", os.path.join(ROOT, "tests", "test_data"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), backend.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    fixture = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "tests"))
    fixture_server = ThreadingHTTPServer(("127.0.0.1", 0), fixture)
    fixture_port = fixture_server.server_address[1]
    threading.Thread(target=fixture_server.serve_forever, daemon=True).start()
    fixture_url = f"http://127.0.0.1:{fixture_port}/web_fixture.html"

    results = {}
    health = get(base, "/api/health")
    assert health["ok"] and health["local_model"]
    results["health"] = "ok"

    translated = post(base, "/api/translate", {
        "text": "Artificial intelligence is transforming the way we understand human languages.",
        "source": "auto",
        "target": "zh",
        "mode": "online",
    })
    assert translated["ok"] and "人工智能" in translated["translated"]
    results["translate_online"] = translated["provider"]

    offline = post(base, "/api/translate", {
        "text": "Hello, how are you today?",
        "source": "en",
        "target": "zh",
        "mode": "offline",
    })
    assert offline["ok"] and offline["translated"]
    results["translate_offline"] = offline["provider"]

    session = post(base, "/api/asr/start", {"language": "en"})
    sid = session["session_id"]
    pcm = load_16k(os.path.join(ROOT, "tests", "speech_en.wav"))
    finals = []
    for offset in range(0, len(pcm), 6400):
        data = post(base, f"/api/asr/feed?session={sid}", raw=pcm[offset : offset + 6400])
        finals.extend(data.get("finals") or [])
    stop = post(base, f"/api/asr/stop?session={sid}", {})
    finals.extend(stop.get("finals") or [])
    text = " ".join(item["text"] for item in finals).lower()
    assert "hello everyone" in text and "weather" in text
    results["asr_stream"] = text

    asr_translation = post(base, "/api/translate", {
        "texts": [item["text"] for item in finals],
        "source": "en",
        "target": "zh",
        "mode": "online",
    })
    assert asr_translation["ok"] and all(asr_translation["translations"])
    results["asr_translate"] = asr_translation["translations"][0]

    web = post(base, "/api/web/translate", {
        "url": fixture_url,
        "source": "auto",
        "target": "en",
        "mode": "online",
    })
    assert web["ok"] and web["paragraphs"]
    assert any("Artificial intelligence" in (p["translated"] or "") for p in web["paragraphs"])
    results["web"] = {
        "title": web["title"],
        "translated_title": web["translated_title"],
        "paragraphs": len(web["paragraphs"]),
        "detected": web["detected_source"],
    }

    ocr_image = os.path.join(ROOT, "tests", "ocr_test.png")
    if os.path.exists(ocr_image):
        encoded = base64.b64encode(open(ocr_image, "rb").read()).decode("ascii")
        ocr = post(base, "/api/ocr/translate", {
            "image": "data:image/png;base64," + encoded,
            "source": "en",
            "target": "zh",
            "mode": "online",
        })
        assert ocr["ok"] and not ocr["empty"] and "HELLO" in ocr["original"].upper()
        results["ocr"] = {"original": ocr["original"], "translated": ocr["translated"]}

    video_path = os.path.join(ROOT, "tests", "test_video.mp4")
    if os.path.exists(video_path):
        start = post(base, "/api/asr/file", {
            "path": video_path,
            "language": "en",
            "target": "zh",
            "mode": "online",
        })
        job_id = start["job_id"]
        result = None
        for _ in range(120):
            job = get(base, f"/api/jobs/{job_id}")["job"]
            if job["status"] == "done":
                result = job["result"]
                break
            if job["status"] == "error":
                raise AssertionError(job["error"])
            time.sleep(0.4)
        assert result and result["segments"] and result["target"] == "zh"
        results["video"] = {"duration": result["duration"], "segments": len(result["segments"])}

    req = urllib.request.Request(
        f"{base}/media?path={urllib.parse.quote(video_path)}",
        headers={"Range": "bytes=0-1023"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        assert response.status == 206
        assert len(response.read()) == 1024
        assert response.headers["Accept-Ranges"] == "bytes"
    results["media_range"] = "206/1024"

    print(json.dumps(results, ensure_ascii=False, indent=2))
    print("BACKEND TESTS PASSED")


if __name__ == "__main__":
    main()
