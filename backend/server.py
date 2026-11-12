# -*- coding: utf-8 -*-
"""LilacLingua AI local service.

Includes:
- Translation & language detection API
- Streaming Vosk ASR with real-time simultaneous translation
- Screen OCR recognition & translation endpoint (/api/ocr/translate)
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "model"))

from languages import ASR_LANGUAGES, LANGUAGES, display_name, normalize_lang  # noqa: E402
from translator import Translator  # noqa: E402
from asr_service import AsrError, AsrService  # noqa: E402
from web_reader import extract_article, translate_article  # noqa: E402

APP_NAME = "LilacLingua AI"
VERSION = "3.2.0"
DATA_DIR = os.environ.get("LILAC_DATA_DIR") or os.path.join(ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)

UI_DIR = os.path.join(ROOT, "ui")


def _prepare_models_dir() -> str:
    configured = os.environ.get("LILAC_MODELS_DIR") or os.path.join(ROOT, "models")
    if configured and all(ord(ch) < 128 for ch in configured):
        return configured
    local_app = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    ascii_dir = os.path.join(local_app, "LilacLinguaAI", "models")
    try:
        valid = os.path.isdir(os.path.join(ascii_dir, "vosk-model-small-cn-0.22"))
        if os.path.isdir(ascii_dir) and not valid:
            try:
                os.rmdir(ascii_dir)
            except OSError:
                pass
        if not os.path.isdir(ascii_dir):
            os.makedirs(os.path.dirname(ascii_dir), exist_ok=True)
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", ascii_dir, configured],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=20,
            )
            if result.returncode != 0:
                return configured
        return ascii_dir
    except Exception:
        return configured


MODELS_DIR = _prepare_models_dir()

local_model = None
local_model_error = ""
try:
    from lilac_model import LilacLinguaModel  # noqa: E402

    weights = os.path.join(ROOT, "model", "weights", "lilac_lang_nmt_v1.npz")
    lexicon = os.path.join(ROOT, "model", "weights", "lexicon_graph.json")
    if os.path.exists(weights) and os.path.exists(lexicon):
        started = time.perf_counter()
        local_model = LilacLinguaModel(weights_path=weights, lexicon_path=lexicon)
        print(f"[model] local Lilac model ready in {(time.perf_counter()-started)*1000:.0f} ms", flush=True)
except Exception as exc:
    local_model_error = repr(exc)
    print(f"[model] local model unavailable: {local_model_error}", flush=True)

translator = Translator(
    DATA_DIR,
    local_model=local_model,
    nllb_model_dir=os.path.join(MODELS_DIR, "nllb-200-distilled-600M-ct2-int8"),
)
if translator.nllb.available:
    threading.Thread(target=translator.preload_nllb, daemon=True, name="nllb-preload").start()
asr = AsrService(MODELS_DIR)


def run_windows_ocr(image_path: str) -> str:
    """Use Windows 10/11 built-in WinRT Windows.Media.Ocr engine via PowerShell."""
    if sys.platform != "win32":
        return ""
    ps_script = f"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]

function Await($WinRtTask, $ResultType) {{
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{image_path.replace("'", "''")}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {{
    $lang = New-Object Windows.Globalization.Language('zh-Hans-CN')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}}
if ($null -eq $engine) {{
    $lang = New-Object Windows.Globalization.Language('en-US')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {{
    $lines += $line.Text
}}
$stream.Dispose()
Write-Output ($lines -join "`n")
"""
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            startupinfo=startupinfo,
        )
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", "replace").strip()
    except Exception as exc:
        print(f"[ocr] Windows OCR error: {exc}", flush=True)
    return ""


class JobManager:
    def __init__(self) -> None:
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.lock = threading.Lock()

    def create(self, name: str) -> str:
        job_id = uuid.uuid4().hex[:10]
        with self.lock:
            self.jobs[job_id] = {
                "id": job_id,
                "name": name,
                "status": "running",
                "progress": 0.0,
                "created": time.time(),
                "result": None,
                "error": "",
            }
        return job_id

    def update(self, job_id: str, **kwargs) -> None:
        with self.lock:
            if job_id in self.jobs:
                self.jobs[job_id].update(kwargs)

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def run(self, name: str, fn: Callable[[str], Any]) -> str:
        job_id = self.create(name)

        def target() -> None:
            try:
                result = fn(job_id)
                self.update(job_id, status="done", progress=1.0, result=result)
            except Exception as exc:
                traceback.print_exc()
                self.update(job_id, status="error", error=str(exc))

        threading.Thread(target=target, daemon=True, name=f"job-{job_id}").start()
        return job_id


jobs = JobManager()


class Handler(BaseHTTPRequestHandler):
    server_version = "LilacLingua/3.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("LILAC_DEBUG"):
            print(f"[http] {self.address_string()} {fmt % args}", flush=True)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Lilac")

    def _json(self, payload: Dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"ok": False, "error": message}, status)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _json_body(self) -> Dict[str, Any]:
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception as exc:
            raise ValueError(f"无效的 JSON 请求: {exc}") from exc

    def _query(self) -> Dict[str, str]:
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json(
                {
                    "ok": True,
                    "app": APP_NAME,
                    "version": VERSION,
                    "local_model": local_model is not None,
                    "local_model_error": local_model_error,
                    "nllb": translator.nllb.status(),
                    "asr": asr.status(),
                    "asr_supported": ASR_LANGUAGES,
                    "models_dir": MODELS_DIR,
                    "languages": LANGUAGES,
                    "offline_only": translator.offline_only,
                    "data_dir": DATA_DIR,
                    "pid": os.getpid(),
                }
            )
            return
        if path == "/api/languages":
            self._json({"ok": True, "languages": LANGUAGES, "asr": ASR_LANGUAGES})
            return
        if path.startswith("/api/jobs/"):
            job = jobs.get(path.rsplit("/", 1)[-1])
            if not job:
                self._error("任务不存在", 404)
                return
            self._json({"ok": True, "job": job})
            return
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/app/index.html")
            self.end_headers()
            return
        if path == "/media":
            self._media()
            return
        if path.startswith("/app/") or path.startswith("/assets/"):
            self._static(path)
            return
        self._error("Not found", 404)

    def _media(self) -> None:
        params = parse_qs(urlparse(self.path).query)
        file_path = (params.get("path") or [""])[0]
        allowed = {".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".ogg"}
        if not file_path or not os.path.isfile(file_path):
            self._error("媒体文件不存在", 404)
            return
        if os.path.splitext(file_path)[1].lower() not in allowed:
            self._error("不支持的媒体格式", 415)
            return
        size = os.path.getsize(file_path)
        mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        range_header = self.headers.get("Range", "")
        start, end = 0, size - 1
        status = 200
        if range_header.startswith("bytes="):
            try:
                value = range_header.split("=", 1)[1].split(",", 1)[0].strip()
                first, _, last = value.partition("-")
                start = int(first) if first else 0
                end = int(last) if last else size - 1
                start = max(0, min(start, size - 1))
                end = max(start, min(end, size - 1))
                status = 206
            except Exception:
                start, end, status = 0, size - 1, 200
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with open(file_path, "rb") as stream:
                stream.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = stream.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _static(self, path: str) -> None:
        rel = path[len("/app/") :] if path.startswith("/app/") else path.lstrip("/")
        rel = rel.split("?")[0].replace("\\", "/")
        if ".." in rel.split("/"):
            self._error("Bad path", 400)
            return
        full = os.path.normpath(os.path.join(UI_DIR, rel))
        if not full.startswith(os.path.normpath(UI_DIR)):
            self._error("Bad path", 400)
            return
        if not os.path.isfile(full):
            self._error("Not found", 404)
            return
        with open(full, "rb") as f:
            raw = f.read()
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        if mime == "text/html":
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self' http://127.0.0.1:*; "
                "media-src 'self' file: blob:; font-src 'self';",
            )
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/translate":
                self._translate()
            elif path == "/api/detect":
                self._detect()
            elif path == "/api/asr/start":
                self._asr_start()
            elif path == "/api/asr/feed":
                self._asr_feed()
            elif path == "/api/asr/stop":
                self._asr_stop()
            elif path == "/api/asr/file":
                self._asr_file()
            elif path == "/api/web/extract":
                self._web_extract()
            elif path == "/api/web/translate":
                self._web_translate()
            elif path == "/api/ocr/translate":
                self._ocr_translate()
            elif path == "/api/shutdown":
                self._json({"ok": True})
                threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0)), daemon=True).start()
            else:
                self._error("Unknown endpoint", 404)
        except AsrError as exc:
            self._error(str(exc), 409)
        except ValueError as exc:
            self._error(str(exc), 400)
        except Exception as exc:
            traceback.print_exc()
            self._error(f"服务异常: {exc}", 500)

    def _translate(self) -> None:
        data = self._json_body()
        texts = data.get("texts")
        if texts is None:
            texts = [data.get("text", "")]
        if not isinstance(texts, list):
            raise ValueError("texts 必须是数组")
        texts = [str(text) for text in texts]
        source = normalize_lang(data.get("source", "auto"))
        target = normalize_lang(data.get("target", "zh"), "zh")
        mode = data.get("mode", "offline")
        result = translator.translate_many(texts, source, target, mode)
        result["ok"] = True
        if len(texts) == 1:
            result["original"] = texts[0]
            result["translated"] = result["translations"][0] if result["translations"] else ""
        self._json(result)

    def _detect(self) -> None:
        data = self._json_body()
        text = str(data.get("text", ""))
        self._json({"ok": True, "result": translator.detect(text)})

    def _asr_start(self) -> None:
        data = self._json_body()
        language = normalize_lang(data.get("language", "auto"), "auto")
        result = asr.start_session(language)
        result["ok"] = True
        result["language_name"] = display_name(language)
        self._json(result)

    def _asr_feed(self) -> None:
        q = self._query()
        session_id = q.get("session", "")
        pcm = self._body()
        result = asr.feed(session_id, pcm)
        result["ok"] = True
        self._json(result)

    def _asr_stop(self) -> None:
        session_id = self._query().get("session", "")
        result = asr.stop(session_id)
        result["ok"] = True
        self._json(result)

    def _asr_file(self) -> None:
        data = self._json_body()
        path = str(data.get("path", ""))
        language = normalize_lang(data.get("language", "auto"), "auto")
        target = normalize_lang(data.get("target", "zh"), "zh")
        mode = data.get("mode", "offline")
        if not path or not os.path.isfile(path):
            raise ValueError("请提供有效的媒体文件路径")

        def task(job_id: str) -> Dict[str, Any]:
            jobs.update(job_id, progress=0.02)
            result = asr.transcribe_file(
                path,
                language,
                progress_cb=lambda value: jobs.update(job_id, progress=min(0.94, 0.02 + value * 0.9)),
            )
            effective_target = target
            if effective_target == "auto":
                effective_target = "en" if result.get("language") == "zh" else "zh"
            segments = result.pop("segments", [])
            texts = [segment["text"] for segment in segments]
            if texts:
                translated = translator.translate_many(
                    texts,
                    source=result.get("language", "auto"),
                    target=effective_target,
                    mode=mode,
                )
                for idx, segment in enumerate(segments):
                    segment["translated"] = (
                        translated["translations"][idx] if idx < len(translated["translations"]) else ""
                    )
                result["provider"] = translated.get("provider")
                result["target"] = effective_target
                result["target_name"] = display_name(effective_target)
            result["segments"] = segments
            jobs.update(job_id, progress=0.99)
            return result

        job_id = jobs.run("asr_file", task)
        self._json({"ok": True, "job_id": job_id})

    def _web_extract(self) -> None:
        data = self._json_body()
        url = str(data.get("url", "")).strip()
        if not url:
            raise ValueError("请输入网页地址")
        self._json({"ok": True, "article": extract_article(url)})

    def _web_translate(self) -> None:
        data = self._json_body()
        url = str(data.get("url", "")).strip()
        if not url:
            raise ValueError("请输入网页地址")
        source = normalize_lang(data.get("source", "auto"))
        target = normalize_lang(data.get("target", "zh"), "zh")
        mode = data.get("mode", "offline")
        article = translate_article(translator, url, source, target, mode)
        article["ok"] = True
        self._json(article)

    def _ocr_translate(self) -> None:
        data = self._json_body()
        image_data = str(data.get("image", "")).strip()
        override_text = str(data.get("text", "")).strip()
        source = normalize_lang(data.get("source", "auto"))
        target = normalize_lang(data.get("target", "zh"), "zh")
        mode = data.get("mode", "offline")

        ocr_text = override_text
        if not ocr_text and image_data:
            if "," in image_data:
                image_data = image_data.split(",", 1)[1]
            raw_bytes = base64.b64decode(image_data)
            tmp = tempfile.NamedTemporaryFile(prefix="lilac_ocr_", suffix=".png", delete=False)
            try:
                tmp.write(raw_bytes)
                tmp.close()
                ocr_text = run_windows_ocr(tmp.name)
            finally:
                try:
                    os.unlink(tmp.name)
                except Exception:
                    pass

        ocr_text = (ocr_text or "").strip()
        if not ocr_text:
            self._json({
                "ok": True,
                "original": "",
                "translated": "",
                "empty": True,
                "message": "未在所选屏幕区域识别到清晰文字",
            })
            return

        lines = [line.strip() for line in ocr_text.splitlines() if line.strip()]
        merged_original = "\n".join(lines)
        trans_res = translator.translate_many(lines, source=source, target=target, mode=mode)
        detected_src = trans_res.get("detected_source") or source
        if source == "auto" and detected_src == target:
            switched_target = "en" if target == "zh" else "zh"
            trans_res = translator.translate_many(lines, source=detected_src, target=switched_target, mode=mode)
            target = switched_target

        translations = list(trans_res.get("translations") or [])
        used_fallback = False
        if mode != "offline" and detected_src != target:
            # Short all-caps OCR labels are often passed through unchanged by
            # the batch neural endpoint.  Fall back per line for those.
            for idx, line in enumerate(lines):
                current = translations[idx] if idx < len(translations) else ""
                if current and current.strip().lower() != line.strip().lower():
                    continue
                try:
                    fallback = translator._mymemory_one(line, detected_src, target)
                    if fallback and fallback.strip().lower() != line.strip().lower():
                        while len(translations) <= idx:
                            translations.append("")
                        translations[idx] = fallback
                        used_fallback = True
                except Exception:
                    pass
        if used_fallback:
            trans_res["provider"] = "mymemory"

        merged_translated = "\n".join(translations)
        self._json({
            "ok": True,
            "empty": False,
            "original": merged_original,
            "translated": merged_translated,
            "source": detected_src,
            "source_name": display_name(detected_src),
            "target": target,
            "target_name": display_name(target),
            "provider": trans_res.get("provider"),
            "latency_ms": trans_res.get("latency_ms"),
        })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("LILAC_PORT", "52019")))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    print(
        "LILAC_SERVER_READY "
        + json.dumps({"port": port, "pid": os.getpid(), "version": VERSION, "app": APP_NAME}),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

