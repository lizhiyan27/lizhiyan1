# -*- coding: utf-8 -*-
"""Streaming / file speech recognition built on Vosk small acoustic models.

Enhanced with:
- Real-time streaming partial stabilization & forced clause commits for continuous audio
- Low-latency simultaneous translation support ("listen-while-translating")
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import vosk  # type: ignore

    try:
        vosk.SetLogLevel(-1)
    except Exception:
        pass
except Exception:
    vosk = None

from languages import ASR_LANGUAGES, display_name, normalize_lang

SAMPLE_RATE = 16000
MODEL_DIR_NAMES = {
    "zh": "vosk-model-small-cn-0.22",
    "en": "vosk-model-small-en-us-0.15",
}


def _cjk_count(text: str) -> int:
    return len(re.findall(r"[\u3400-\u9fff]", text or ""))


def _latin_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z]", text or ""))


def _avg_confidence(words: List[dict]) -> float:
    if not words:
        return 0.0
    vals = []
    for word in words:
        try:
            vals.append(float(word.get("conf", 0.0)))
        except Exception:
            pass
    if not vals:
        return 0.0
    return sum(vals) / len(vals)


def _score_hypothesis(lang: str, text: str, words: List[dict]) -> float:
    if not text.strip():
        return 0.0
    conf = _avg_confidence(words)
    if conf <= 0.0:
        conf = 0.35
    length_factor = min(1.0, len(text.strip()) / 40.0)
    script_factor = 1.0
    if lang == "zh":
        cjk = _cjk_count(text)
        script_factor = 1.2 if cjk >= max(1, len(text) * 0.3) else 0.55
    elif lang == "en":
        latin = _latin_count(text)
        script_factor = 1.2 if latin >= max(2, len(text) * 0.5) else 0.55
    return (conf ** 2) * (0.55 + 0.45 * length_factor) * script_factor


def _pick_best(candidates: Dict[str, Tuple[str, List[dict]]]) -> Tuple[str, str, float]:
    best_lang, best_text, best_score = "", "", -1.0
    for lang, (text, words) in candidates.items():
        score = _score_hypothesis(lang, text, words)
        if score > best_score:
            best_lang, best_text, best_score = lang, text, score
    return best_lang, best_text, best_score


@dataclass
class LiveSession:
    id: str
    languages: List[str]
    recognizers: Dict[str, Any] = field(default_factory=dict)
    total_bytes: int = 0
    created_at: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_lang: str = ""
    locked_lang: str = ""
    partial_max: Dict[str, int] = field(default_factory=dict)
    probe_leader: str = ""
    probe_streak: int = 0
    pending_first: Dict[str, Tuple[str, List[dict]]] = field(default_factory=dict)
    first_final_at: float = 0.0
    last_final_text: str = ""
    last_final_at: float = 0.0
    finals: List[Dict[str, Any]] = field(default_factory=list)
    partial: str = ""
    last_partial_text: str = ""
    last_partial_change_at: float = field(default_factory=time.time)
    segment_started_at: float = field(default_factory=time.time)


class AsrError(RuntimeError):
    pass


class AsrService:
    def __init__(self, models_root: str) -> None:
        self.models_root = models_root
        self._models: Dict[str, Any] = {}
        self._model_lock = threading.Lock()
        self._sessions: Dict[str, LiveSession] = {}
        self._session_lock = threading.Lock()
        self._ffmpeg = self._find_ffmpeg()

    @staticmethod
    def _find_ffmpeg() -> Optional[str]:
        try:
            import imageio_ffmpeg  # type: ignore

            path = imageio_ffmpeg.get_ffmpeg_exe()
            if path and os.path.exists(path):
                return path
        except Exception:
            pass
        for candidate in ("ffmpeg.exe", "ffmpeg"):
            from shutil import which

            found = which(candidate)
            if found:
                return found
        local = os.path.join(os.path.dirname(os.path.dirname(__file__)), "bin", "ffmpeg.exe")
        return local if os.path.exists(local) else None

    def model_path(self, lang: str) -> str:
        return os.path.join(self.models_root, MODEL_DIR_NAMES.get(lang, ""))

    def model_available(self, lang: str) -> bool:
        path = self.model_path(lang)
        return bool(path) and os.path.isdir(path) and os.path.exists(os.path.join(path, "am"))

    def status(self) -> Dict[str, Any]:
        return {
            "vosk_imported": vosk is not None,
            "ffmpeg": bool(self._ffmpeg),
            "models": {
                lang: {
                    "available": self.model_available(lang),
                    "loaded": lang in self._models,
                    "path": self.model_path(lang),
                }
                for lang in ASR_LANGUAGES
            },
            "supported": ASR_LANGUAGES,
        }

    def ensure_model(self, lang: str):
        if vosk is None:
            raise AsrError("Vosk 语音识别库未安装")
        if lang not in ASR_LANGUAGES:
            raise AsrError(f"暂不支持 {display_name(lang)} 的离线语音识别")
        if lang in self._models:
            return self._models[lang]
        path = self.model_path(lang)
        if not self.model_available(lang):
            raise AsrError(
                f"缺少 {display_name(lang)} 语音模型，请将 {MODEL_DIR_NAMES[lang]} 放入 models 目录"
            )
        with self._model_lock:
            if lang not in self._models:
                started = time.perf_counter()
                self._models[lang] = vosk.Model(path)
                print(
                    f"[asr] loaded {lang} model in {(time.perf_counter()-started)*1000:.0f} ms",
                    flush=True,
                )
        return self._models[lang]

    def start_session(self, language: str = "auto") -> Dict[str, Any]:
        language = normalize_lang(language, "auto")
        if language == "auto":
            langs = [lang for lang in ASR_LANGUAGES if self.model_available(lang)]
            if not langs:
                raise AsrError("没有可用的语音识别模型")
            if "zh" in langs:
                langs = ["zh"] + [lang for lang in langs if lang != "zh"]
        else:
            langs = [language]
        if not langs:
            raise AsrError("没有可用的语音识别模型")
        recognizers = {}
        for lang in langs:
            model = self.ensure_model(lang)
            recognizer = vosk.KaldiRecognizer(model, SAMPLE_RATE)
            try:
                recognizer.SetWords(True)
            except Exception:
                pass
            recognizers[lang] = recognizer
        now = time.time()
        session = LiveSession(
            id=uuid.uuid4().hex[:12],
            languages=langs,
            recognizers=recognizers,
            locked_lang=langs[0] if len(langs) == 1 else "",
            last_lang=langs[0] if len(langs) == 1 else "zh",
            last_partial_change_at=now,
            segment_started_at=now,
        )
        with self._session_lock:
            self._sessions[session.id] = session
        return {
            "session_id": session.id,
            "languages": langs,
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "format": "s16le",
        }

    def get_session(self, session_id: str) -> LiveSession:
        session = self._sessions.get(session_id)
        if not session:
            raise AsrError("语音识别会话不存在或已结束")
        return session

    def feed(self, session_id: str, pcm: bytes) -> Dict[str, Any]:
        session = self.get_session(session_id)
        if len(pcm) % 2:
            pcm = pcm[:-1]
        if not pcm:
            return {"partial": session.partial, "finals": [], "rms": 0.0}
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0.0
        now = time.time()

        with session.lock:
            session.total_bytes += len(pcm)
            partials: Dict[str, Tuple[str, List[dict]]] = {}
            final_candidates: Dict[str, Tuple[str, List[dict]]] = {}
            for lang, rec in session.recognizers.items():
                try:
                    if rec.AcceptWaveform(pcm):
                        result = json.loads(rec.Result())
                        text = (result.get("text") or "").strip()
                        words = result.get("result") or []
                        if text:
                            final_candidates[lang] = (text, words)
                    else:
                        pres = json.loads(rec.PartialResult())
                        text = (pres.get("partial") or "").strip()
                        if text:
                            partials[lang] = (text, [])
                except Exception as exc:
                    print(f"[asr] {lang} feed error: {exc}", flush=True)

            finals: List[Dict[str, Any]] = []
            if final_candidates:
                session.last_partial_text = ""
                session.segment_started_at = now
                if len(session.recognizers) == 1:
                    lang, (text, words) = next(iter(final_candidates.items()))
                    session.locked_lang = lang
                    emitted = [(lang, text, words)]
                elif session.locked_lang:
                    if session.locked_lang in final_candidates:
                        text, words = final_candidates[session.locked_lang]
                        emitted = [(session.locked_lang, text, words)]
                    else:
                        emitted = []
                else:
                    for lang, (text, words) in final_candidates.items():
                        if text:
                            session.pending_first[lang] = (text, words)
                            if not session.first_final_at:
                                session.first_final_at = now
                    emitted = []
                    if session.pending_first and (
                        len(session.pending_first) >= 2
                        or (now - session.first_final_at) > 4.5
                        or session.total_bytes / 2.0 / SAMPLE_RATE > 11.0
                    ):
                        lang, text, score = _pick_best(session.pending_first)
                        words = session.pending_first[lang][1]
                        session.locked_lang = lang
                        emitted = [(lang, text, words)]
                        session.pending_first.clear()

                for lang, text, words in emitted:
                    if not text:
                        continue
                    if text == session.last_final_text and now - session.last_final_at < 1.2:
                        continue
                    start = float(words[0].get("start", 0.0)) if words else session.total_bytes / 2.0 / SAMPLE_RATE
                    end = float(words[-1].get("end", start)) if words else session.total_bytes / 2.0 / SAMPLE_RATE
                    finals.append(
                        {
                            "text": text,
                            "lang": lang,
                            "start": round(start, 2),
                            "end": round(max(end, start), 2),
                            "confidence": round(_avg_confidence(words), 3),
                        }
                    )
                    session.last_final_text = text
                    session.last_final_at = now
                    session.last_lang = lang
                    session.finals.append(finals[-1])

            if not session.locked_lang and len(session.recognizers) > 1:
                for lang, (text, _words) in partials.items():
                    session.partial_max[lang] = max(session.partial_max.get(lang, 0), len(text))
                duration = session.total_bytes / 2.0 / SAMPLE_RATE
                if duration >= 0.8 and session.partial_max:
                    ranked = sorted(session.partial_max.items(), key=lambda item: item[1], reverse=True)
                    best_lang, best_len = ranked[0]
                    other_len = ranked[1][1] if len(ranked) > 1 else 0
                    leader = ""
                    if best_len >= 4 and (other_len < 2 or best_len >= other_len * 1.5):
                        leader = best_lang
                    if leader:
                        if leader == session.probe_leader:
                            session.probe_streak += 1
                        else:
                            session.probe_leader = leader
                            session.probe_streak = 1
                        if session.probe_streak >= 2 and duration >= 1.2:
                            session.locked_lang = leader
                            session.pending_first.clear()
                    else:
                        session.probe_leader = ""
                        session.probe_streak = 0

            if partials:
                if session.locked_lang and session.locked_lang in partials:
                    partial = partials[session.locked_lang][0]
                    active_p_lang = session.locked_lang
                elif session.last_lang and session.last_lang in partials:
                    partial = partials[session.last_lang][0]
                    active_p_lang = session.last_lang
                elif len(partials) == 1:
                    active_p_lang, (partial, _) = next(iter(partials.items()))
                else:
                    active_p_lang = "zh" if "zh" in partials else next(iter(partials.keys()))
                    partial = partials[active_p_lang][0]
                session.partial = partial
                session.last_lang = active_p_lang
            elif finals:
                session.partial = ""

            return {
                "partial": session.partial,
                "finals": finals,
                "rms": round(min(1.0, rms * 6.0), 3),
                "duration": round(session.total_bytes / 2.0 / SAMPLE_RATE, 2),
                "lang": session.locked_lang or session.last_lang or "zh",
            }

    def stop(self, session_id: str) -> Dict[str, Any]:
        session = self._sessions.pop(session_id, None)
        if not session:
            return {"finals": [], "partial": ""}
        candidates: Dict[str, Tuple[str, List[dict]]] = {}
        with session.lock:
            for lang, rec in session.recognizers.items():
                try:
                    result = json.loads(rec.FinalResult())
                except Exception:
                    continue
                text = (result.get("text") or "").strip()
                if text:
                    candidates[lang] = (text, result.get("result") or [])
        finals: List[Dict[str, Any]] = []
        if candidates:
            pool: Dict[str, Tuple[str, List[dict]]] = dict(session.pending_first)
            pool.update(candidates)
            if session.locked_lang and session.locked_lang in pool:
                lang, (text, words) = session.locked_lang, pool[session.locked_lang]
            else:
                lang, text, _ = _pick_best(pool)
                words = pool.get(lang, ("", []))[1] if lang else []
            if text and not (text == session.last_final_text):
                start = float(words[0].get("start", 0.0)) if words else 0.0
                end = float(words[-1].get("end", start)) if words else session.total_bytes / 2.0 / SAMPLE_RATE
                finals.append(
                    {
                        "text": text,
                        "lang": lang,
                        "start": round(start, 2),
                        "end": round(max(end, start), 2),
                        "confidence": round(_avg_confidence(words), 3),
                    }
                )
        all_segments = session.finals + finals
        return {
            "finals": finals,
            "all_finals": all_segments,
            "partial": "",
            "duration": round(session.total_bytes / 2.0 / SAMPLE_RATE, 2),
            "full_text": " ".join(x["text"] for x in all_segments) if all_segments else "",
        }

    def extract_audio(self, input_path: str) -> str:
        if not os.path.exists(input_path):
            raise AsrError("文件不存在")
        if input_path.lower().endswith(".wav"):
            try:
                with wave.open(input_path, "rb") as wf:
                    if wf.getframerate() == SAMPLE_RATE and wf.getnchannels() == 1 and wf.getsampwidth() == 2:
                        return input_path
            except Exception:
                pass
        if not self._ffmpeg:
            raise AsrError("未找到 ffmpeg，暂时无法解析该媒体格式")
        tmp = tempfile.NamedTemporaryFile(prefix="lilac_audio_", suffix=".wav", delete=False)
        tmp.close()
        cmd = [
            self._ffmpeg, "-y", "-i", input_path, "-vn",
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-acodec", "pcm_s16le", tmp.name,
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
        if proc.returncode != 0 or not os.path.exists(tmp.name):
            raise AsrError(f"音频提取失败: {proc.stderr.decode('utf-8', 'replace')[-300:]}")
        return tmp.name

    @staticmethod
    def _read_wav(path: str) -> np.ndarray:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
        if width == 2:
            data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        elif width == 1:
            data = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif width == 4:
            data = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            data = data.reshape(-1, channels).mean(axis=1)
        if rate != SAMPLE_RATE and len(data):
            duration = len(data) / float(rate)
            target_len = max(1, int(round(duration * SAMPLE_RATE)))
            data = np.interp(
                np.linspace(0.0, 1.0, target_len, dtype=np.float32),
                np.linspace(0.0, 1.0, len(data), dtype=np.float32),
                data,
            ).astype(np.float32)
        return np.clip(data, -1.0, 1.0)

    def _recognize_wave(self, samples: np.ndarray, lang: str, progress_cb=None) -> List[Dict[str, Any]]:
        model = self.ensure_model(lang)
        rec = vosk.KaldiRecognizer(model, SAMPLE_RATE)
        try:
            rec.SetWords(True)
        except Exception:
            pass
        pcm = (samples * 32767.0).astype(np.int16).tobytes()
        chunk = SAMPLE_RATE * 2 * 4
        words: List[dict] = []
        texts: List[str] = []
        total = max(1, len(pcm))
        for offset in range(0, len(pcm), chunk):
            part = pcm[offset : offset + chunk]
            if rec.AcceptWaveform(part):
                result = json.loads(rec.Result())
                if result.get("text"):
                    texts.append(result["text"].strip())
                    words.extend(result.get("result") or [])
            if progress_cb:
                progress_cb(min(0.96, (offset + len(part)) / total * 0.96))
        result = json.loads(rec.FinalResult())
        if result.get("text"):
            texts.append(result["text"].strip())
            words.extend(result.get("result") or [])
        if not words and not texts:
            return []
        if not words:
            duration = len(samples) / float(SAMPLE_RATE)
            return [{"text": " ".join(texts), "start": 0.0, "end": round(duration, 2), "confidence": 0.0}]
        segments: List[Dict[str, Any]] = []
        current: List[dict] = []
        start = float(words[0].get("start", 0.0))
        last_end = start
        for word in words:
            w_start = float(word.get("start", last_end))
            w_end = float(word.get("end", w_start))
            gap = w_start - last_end
            too_long = (w_end - start) > 9.0
            if current and (gap > 0.75 or too_long or len(current) >= 26):
                text = "".join(w.get("word", "") for w in current) if lang == "zh" else " ".join(w.get("word", "") for w in current)
                segments.append(
                    {
                        "text": text.strip(),
                        "start": round(start, 2),
                        "end": round(last_end, 2),
                        "confidence": round(_avg_confidence(current), 3),
                    }
                )
                current = []
                start = w_start
            current.append(word)
            last_end = w_end
        if current:
            text = "".join(w.get("word", "") for w in current) if lang == "zh" else " ".join(w.get("word", "") for w in current)
            segments.append(
                {
                    "text": text.strip(),
                    "start": round(start, 2),
                    "end": round(last_end, 2),
                    "confidence": round(_avg_confidence(current), 3),
                }
            )
        return [seg for seg in segments if seg["text"]]

    def transcribe_file(self, path: str, language: str = "auto", progress_cb=None) -> Dict[str, Any]:
        language = normalize_lang(language, "auto")
        wav_path = self.extract_audio(path)
        cleanup = wav_path != path
        try:
            samples = self._read_wav(wav_path)
            duration = len(samples) / float(SAMPLE_RATE)
            if language == "auto":
                candidates = [lang for lang in ASR_LANGUAGES if self.model_available(lang)]
                best_segments: List[Dict[str, Any]] = []
                best_lang = candidates[0] if candidates else "zh"
                best_score = -1.0
                for idx, lang in enumerate(candidates):
                    sub_progress = None
                    if progress_cb:
                        sub_progress = lambda value, idx=idx, n=len(candidates): progress_cb((idx + value) / max(1, n))
                    segments = self._recognize_wave(samples, lang, sub_progress)
                    text = " ".join(seg["text"] for seg in segments)
                    conf = sum(seg["confidence"] for seg in segments) / max(1, len(segments))
                    cjk = _cjk_count(text)
                    latin = _latin_count(text)
                    script = 1.2 if (lang == "zh" and cjk > len(text) * 0.3) or (lang == "en" and latin > len(text) * 0.5) else 0.7
                    score = (conf ** 2) * (0.55 + 0.45 * min(1.0, len(text) / 60.0)) * script
                    if score > best_score:
                        best_lang, best_segments, best_score = lang, segments, score
                segments = best_segments
                language = best_lang
            else:
                segments = self._recognize_wave(samples, language, progress_cb)
            return {
                "language": language,
                "language_name": display_name(language),
                "duration": round(duration, 2),
                "segments": segments,
                "full_text": " ".join(seg["text"] for seg in segments),
                "wav_path": wav_path if not cleanup else "",
            }
        finally:
            if cleanup:
                try:
                    os.unlink(wav_path)
                except Exception:
                    pass
