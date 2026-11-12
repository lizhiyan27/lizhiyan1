# -*- coding: utf-8 -*-
"""Translation gateway for LilacLingua.

Priority:
1. Tencent Transmart public neural translation endpoint (fast, high quality, 12 languages).
2. MyMemory public API (per-segment fallback).
3. The user's bundled LilacLingua local neural-statistical model (offline / privacy mode).

All providers run on the local machine's network only when the user selects the
online mode; the offline mode never leaves the computer.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from languages import display_name, mymemory_code, normalize_lang
from nllb_translator import NLLBTranslator, NLLBUnavailable

TENCENT_URL = "https://transmart.qq.com/api/imt"
MYMEMORY_URL = "https://api.mymemory.translated.net/get"
CLIENT_KEY = (
    "browser-chrome-124.0.0-Windows-11-"
    "df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487"
)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class ProviderError(RuntimeError):
    pass


def _http_json(url: str, payload: Optional[dict] = None, timeout: int = 14) -> dict:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=UTF-8"
        headers["Referer"] = "https://transmart.qq.com/"
        headers["Origin"] = "https://transmart.qq.com"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", "replace"))


def _split_text(text: str, limit: int = 420) -> List[str]:
    """Split text into chunks <= limit characters, preferring sentence boundaries."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    parts: List[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            parts.append(remaining)
            break
        window = remaining[:limit]
        cut = max(
            window.rfind("。"), window.rfind("！"), window.rfind("？"),
            window.rfind(". "), window.rfind("! "), window.rfind("? "),
            window.rfind("；"), window.rfind(";"), window.rfind("\n"),
        )
        if cut < int(limit * 0.35):
            cut = limit
        else:
            cut += 1
        parts.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    return [part for part in parts if part]


def _clean_translation(value: str) -> str:
    value = (value or "").replace("\r", "")
    value = re.sub(r"^[\s\"'“”]+|[\s\"'“”]+$", "", value)
    return value.strip()


class TranslationCache:
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with self._connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS translations ("
                " source TEXT, target TEXT, mode TEXT, original TEXT, translated TEXT,"
                " provider TEXT, created REAL, PRIMARY KEY(source,target,mode,original))"
            )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=8)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def get(self, source: str, target: str, mode: str, text: str) -> Optional[Tuple[str, str]]:
        with self.lock, self._connect() as db:
            row = db.execute(
                "SELECT translated, provider FROM translations "
                "WHERE source=? AND target=? AND mode=? AND original=?",
                (source, target, mode, text),
            ).fetchone()
            return (row[0], row[1]) if row else None

    def put(self, source: str, target: str, mode: str, text: str, translated: str, provider: str) -> None:
        with self.lock, self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO translations VALUES(?,?,?,?,?,?,?)",
                (source, target, mode, text, translated, provider, time.time()),
            )


class LocalLilacTranslator:
    """Thin adapter around the user's bundled LilacLingua model."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.lock = threading.Lock()

    @property
    def available(self) -> bool:
        return self.model is not None

    def translate(self, text: str, source: str, target: str, mode: str = "fluent") -> Dict[str, Any]:
        if self.model is None:
            raise ProviderError("本地模型未加载")
        with self.lock:
            start = time.perf_counter()
            result = self.model.translate(
                text=text, target_lang=target, source_lang=source, mode=mode
            )
            detected = self.model.detect_language(text)
            return {
                "translated": result.translated_text,
                "source": result.source_lang,
                "target": result.target_lang,
                "confidence": float(detected.confidence or 0.0),
                "latency_ms": (time.perf_counter() - start) * 1000.0,
            }

    def detect(self, text: str) -> Dict[str, Any]:
        if self.model is None:
            raise ProviderError("本地模型未加载")
        with self.lock:
            det = self.model.detect_language(text)
            return {
                "language": det.language,
                "name": det.language_name,
                "confidence": float(det.confidence or 0.0),
                "top_candidates": [
                    {"language": code, "score": float(score)}
                    for code, score in (det.top_candidates or [])[:5]
                ],
                "latency_ms": float(det.latency_ms or 0.0),
            }


class Translator:
    def __init__(
        self,
        data_dir: str,
        local_model: Any = None,
        offline_only: bool = False,
        nllb_model_dir: Optional[str] = None,
    ) -> None:
        self.data_dir = data_dir
        self.local = LocalLilacTranslator(local_model)
        self.offline_only = offline_only
        self.nllb = NLLBTranslator(nllb_model_dir)
        self.cache = TranslationCache(os.path.join(data_dir, "translation_cache.db"))
        self._last_online_error = ""
        self._online_disabled_until = 0.0
        self._lock = threading.Lock()

    def preload_nllb(self) -> None:
        """Load the offline model in the background so the first request is fast."""
        if not self.nllb.available:
            return
        try:
            self.nllb._ensure_loaded()
        except Exception as exc:  # noqa: BLE001
            print(f"[nllb] preload failed: {exc}", flush=True)

    # ------------------------------------------------------------------ online
    def _tencent(self, texts: Sequence[str], source: str, target: str) -> Tuple[List[str], str]:
        if self.offline_only or time.time() < self._online_disabled_until:
            raise ProviderError("online disabled")
        payload = {
            "header": {"fn": "auto_translation", "client_key": CLIENT_KEY},
            "type": "plain",
            "model_category": "normal",
            "source": {"lang": source if source != "auto" else "auto", "text_list": list(texts)},
            "target": {"lang": target},
        }
        last_error: Optional[Exception] = None
        for attempt in range(2):
            try:
                data = _http_json(TENCENT_URL, payload, timeout=16)
                if data.get("header", {}).get("ret_code") != "succ":
                    raise ProviderError(str(data.get("message") or data.get("header")))
                result = data.get("auto_translation") or []
                if len(result) != len(texts):
                    raise ProviderError("翻译返回数量不一致")
                detected = str(data.get("src_lang") or source or "auto")
                return [_clean_translation(item) for item in result], detected
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(0.35 + attempt * 0.4)
        self._last_online_error = str(last_error)
        raise ProviderError(f"腾讯翻译接口不可用: {last_error}")

    def _mymemory_one(self, text: str, source: str, target: str) -> str:
        if self.offline_only:
            raise ProviderError("online disabled")
        pair = f"{'Autodetect' if source == 'auto' else mymemory_code(source)}|{mymemory_code(target)}"
        chunks = _split_text(text, 420)
        out: List[str] = []
        for chunk in chunks:
            query = urllib.parse.urlencode({"q": chunk, "langpair": pair})
            req = urllib.request.Request(
                f"{MYMEMORY_URL}?{query}",
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=14) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            translated = (data.get("responseData") or {}).get("translatedText") or ""
            if not translated or "MYMEMORY WARNING" in translated.upper():
                raise ProviderError("MyMemory 返回空结果")
            out.append(translated)
        return _clean_translation(" ".join(out))

    # ----------------------------------------------------------------- offline
    def _local_one(self, text: str, source: str, target: str, mode: str) -> str:
        if self.nllb.available:
            resolved_source = source
            if resolved_source == "auto":
                resolved_source = self.detect(text).get("language", "en")
            try:
                return self.nllb.translate(text, resolved_source, target)
            except Exception as exc:  # noqa: BLE001
                print(f"[nllb] fallback to Lilac: {exc}", flush=True)
        result = self.local.translate(text, source, target, mode="fluent")
        return result["translated"]

    # ------------------------------------------------------------------- public
    def detect(self, text: str) -> Dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"language": "auto", "name": "自动检测", "confidence": 0.0, "provider": "none"}
        if self.local.available:
            try:
                info = self.local.detect(text[:2000])
                info["provider"] = "lilac-local"
                return info
            except Exception:
                pass
        # Script based fallback.
        if re.search(r"[\u4e00-\u9fff]", text):
            return {"language": "zh", "name": "中文", "confidence": 0.9, "provider": "script"}
        if re.search(r"[\u3040-\u30ff]", text):
            return {"language": "ja", "name": "日语", "confidence": 0.8, "provider": "script"}
        if re.search(r"[\uac00-\ud7af]", text):
            return {"language": "ko", "name": "韩语", "confidence": 0.8, "provider": "script"}
        return {"language": "en", "name": "英语", "confidence": 0.6, "provider": "script"}

    def translate_many(
        self,
        texts: Sequence[str],
        source: str = "auto",
        target: str = "zh",
        mode: str = "offline",
    ) -> Dict[str, Any]:
        started = time.perf_counter()
        source = normalize_lang(source)
        target = normalize_lang(target, "zh")
        if target == "auto":
            target = "en" if source == "zh" else "zh"
        mode = mode if mode in ("online", "offline") else "offline"
        originals = [str(text if text is not None else "") for text in texts]
        results: List[str] = ["" for _ in originals]
        providers: List[str] = ["empty" for _ in originals]
        detected = source
        to_translate: List[int] = []

        for idx, text in enumerate(originals):
            stripped = text.strip()
            if not stripped:
                providers[idx] = "empty"
                continue
            if source != "auto" and source == target:
                results[idx] = text
                providers[idx] = "identity"
                continue
            cached = self.cache.get(source, target, mode, stripped)
            if cached:
                results[idx], providers[idx] = cached
                continue
            to_translate.append(idx)

        if to_translate:
            pending = [originals[i].strip() for i in to_translate]
            translated_parts: List[str] = []
            used_provider = "unknown"
            online_detected = "auto"
            if mode == "offline":
                translated_parts = ["" for _ in pending]
                if self.nllb.available:
                    batch_texts: List[str] = []
                    batch_sources: List[str] = []
                    batch_positions: List[int] = []
                    for pos, text in enumerate(pending):
                        resolved_source = source if source != "auto" else self.detect(text).get("language", "en")
                        if resolved_source == target:
                            translated_parts[pos] = text
                            providers[to_translate[pos]] = "identity"
                            continue
                        batch_texts.append(text)
                        batch_sources.append(resolved_source)
                        batch_positions.append(pos)
                    used_provider = "nllb-local"
                    if batch_texts:
                        try:
                            batch_result = self.nllb.translate_batch(
                                batch_texts, batch_sources, target, beam_size=4
                            )
                            for pos, value in zip(batch_positions, batch_result):
                                translated_parts[pos] = value
                        except Exception as exc:  # noqa: BLE001
                            print(f"[nllb] batch failed, falling back to Lilac: {exc}", flush=True)
                            used_provider = "lilac-local"
                            for idx, (pos, text) in enumerate(zip(batch_positions, batch_texts)):
                                translated_parts[pos] = self.local.translate(
                                    text, batch_sources[idx], target, mode="fluent"
                                )["translated"]
                else:
                    used_provider = "lilac-local"
                    for pos, text in enumerate(pending):
                        translated_parts[pos] = self.local.translate(
                            text, source, target, mode="fluent"
                        )["translated"]
            else:
                # Batch into Tencent requests of <= 40 items / <= 5000 characters.
                batches: List[List[int]] = []
                current: List[int] = []
                length = 0
                for pos, value in enumerate(pending):
                    if current and (length + len(value) > 4800 or len(current) >= 40):
                        batches.append(current)
                        current, length = [], 0
                    current.append(pos)
                    length += len(value)
                if current:
                    batches.append(current)
                translated_parts = [""] * len(pending)
                used_provider = "tencent"
                for batch in batches:
                    batch_texts = [pending[i] for i in batch]
                    try:
                        translated, batch_source = self._tencent(batch_texts, source, target)
                        if batch_source and batch_source != "auto":
                            online_detected = batch_source
                    except Exception:
                        translated = []
                        for text in batch_texts:
                            try:
                                translated.append(self._mymemory_one(text, source, target))
                                used_provider = "mymemory"
                            except Exception:
                                translated.append(self._local_one(text, source, target, "fluent"))
                                used_provider = "lilac-local"
                    for local_idx, value in zip(batch, translated):
                        translated_parts[local_idx] = value
                # Prefer the provider's own language identification.
                if online_detected != "auto":
                    detected = normalize_lang(online_detected, source)
                else:
                    try:
                        detected = self.detect(pending[0]).get("language", source)
                    except Exception:
                        detected = source

            for local_idx, value in enumerate(translated_parts):
                original_idx = to_translate[local_idx]
                results[original_idx] = value
                providers[original_idx] = used_provider
                if value:
                    self.cache.put(source, target, mode, originals[original_idx].strip(), value, used_provider)

        if source == "auto" and detected == "auto":
            detected = self.detect(originals[0] if originals else "").get("language", "auto")

        provider_set = {p for p in providers if p != "empty"}
        provider = next(iter(provider_set)) if len(provider_set) == 1 else "+".join(sorted(provider_set))
        return {
            "translations": results,
            "providers": providers,
            "provider": provider or "none",
            "detected_source": detected,
            "detected_source_name": display_name(detected),
            "source": source,
            "target": target,
            "mode": mode,
            "target_name": display_name(target),
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 2),
            "online_error": self._last_online_error,
        }

    def translate_one(
        self, text: str, source: str = "auto", target: str = "zh", mode: str = "offline"
    ) -> Dict[str, Any]:
        data = self.translate_many([text], source, target, mode)
        data["original"] = text
        data["translated"] = data["translations"][0] if data["translations"] else ""
        return data


