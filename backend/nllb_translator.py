# -*- coding: utf-8 -*-
"""Offline NLLB-200 translation engine (CTranslate2 int8).

The original LilacLingua model is kept as a lightweight fallback / language
identifier.  NLLB-200 distilled 600M is used for the actual offline translation
because it is much stronger on all 12 supported languages while still running
comfortably on a 6-core desktop CPU.

Model directory layout (pre-converted CT2 int8):
    model.bin
    config.json
    sentencepiece.bpe.model
    shared_vocabulary.txt
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Sequence

try:
    import ctranslate2  # type: ignore
    import sentencepiece as spm  # type: ignore
except Exception:  # pragma: no cover - health reports availability
    ctranslate2 = None
    spm = None

APP_TO_NLLB = {
    "zh": "zho_Hans",
    "en": "eng_Latn",
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "es": "spa_Latn",
    "ru": "rus_Cyrl",
    "ar": "arb_Arab",
    "pt": "por_Latn",
    "it": "ita_Latn",
    "th": "tha_Thai",
}
NLLB_TO_APP = {value: key for key, value in APP_TO_NLLB.items()}

DEFAULT_MODEL_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models",
    "nllb-200-distilled-600M-ct2-int8",
)

# A tiny phrasebook for the most common greetings.  NLLB-200 600M is strong
# on full sentences but sometimes over-translates very short idioms
# ("How are you?" -> "你怎么回事?"); these exact matches are safe.
PHRASEBOOK = {
    ("en", "zh"): {
        "hello": "你好",
        "hi": "嗨",
        "hello world": "你好，世界",
        "how are you": "你好吗？",
        "how are you?": "你好吗？",
        "thank you": "谢谢",
        "thanks": "谢谢",
        "good morning": "早上好",
        "good night": "晚安",
        "goodbye": "再见",
        "bye": "再见",
        "see you": "回头见",
        "i love you": "我爱你",
        "what's your name": "你叫什么名字？",
        "what's your name?": "你叫什么名字？",
        "nice to meet you": "很高兴认识你",
    },
    ("zh", "en"): {
        "你好": "Hello.",
        "你好吗": "How are you?",
        "你好吗？": "How are you?",
        "谢谢": "Thank you.",
        "再见": "Goodbye.",
        "早上好": "Good morning.",
        "晚安": "Good night.",
        "我爱你": "I love you.",
        "你叫什么名字": "What's your name?",
        "你叫什么名字？": "What's your name?",
        "很高兴认识你": "Nice to meet you.",
    },
}


class NLLBUnavailable(RuntimeError):
    pass


class NLLBTranslator:
    def __init__(self, model_dir: Optional[str] = None) -> None:
        self.model_dir = model_dir or os.environ.get("LILAC_NLLB_DIR") or DEFAULT_MODEL_DIR
        self._model = None
        self._sp = None
        self._lang_ids: Dict[str, int] = {}
        self._lock = threading.Lock()
        self._last_error = ""

    @property
    def model_path(self) -> str:
        return self.model_dir

    def files_ready(self) -> bool:
        return all(
            os.path.isfile(os.path.join(self.model_dir, name))
            for name in ("model.bin", "config.json", "sentencepiece.bpe.model", "shared_vocabulary.txt")
        )

    @property
    def available(self) -> bool:
        return ctranslate2 is not None and spm is not None and self.files_ready()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def status(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "loaded": self.loaded,
            "path": self.model_dir,
            "engine": "NLLB-200-distilled-600M / CTranslate2 int8",
            "languages": list(APP_TO_NLLB),
            "error": self._last_error,
        }

    def _ensure_loaded(self) -> None:
        if self._model is not None and self._sp is not None:
            return
        if ctranslate2 is None or spm is None:
            raise NLLBUnavailable("未安装 ctranslate2 / sentencepiece")
        if not self.files_ready():
            raise NLLBUnavailable(f"NLLB 模型文件不完整：{self.model_dir}")
        with self._lock:
            if self._model is not None and self._sp is not None:
                return
            started = time.perf_counter()
            try:
                sp = spm.SentencePieceProcessor(
                    model_file=os.path.join(self.model_dir, "sentencepiece.bpe.model")
                )
                vocab_path = os.path.join(self.model_dir, "shared_vocabulary.txt")
                lang_ids: Dict[str, int] = {}
                with open(vocab_path, "r", encoding="utf-8") as handle:
                    for index, line in enumerate(handle):
                        token = line.rstrip("\r\n")
                        if re.fullmatch(r"[a-z]{3}_[A-Z][a-z]{3}", token):
                            lang_ids[token] = index
                model = ctranslate2.Translator(
                    self.model_dir,
                    device="cpu",
                    compute_type="int8",
                    inter_threads=1,
                    intra_threads=max(2, min(6, os.cpu_count() or 4)),
                )
                self._sp = sp
                self._lang_ids = lang_ids
                self._model = model
                elapsed = (time.perf_counter() - started) * 1000
                print(f"[nllb] model loaded in {elapsed:.0f} ms ({len(lang_ids)} language tokens)", flush=True)
            except Exception as exc:  # noqa: BLE001
                self._last_error = repr(exc)
                raise NLLBUnavailable(f"NLLB 模型加载失败：{exc}") from exc

    def language_id(self, app_code: str) -> int:
        code = APP_TO_NLLB.get(app_code)
        if not code:
            raise NLLBUnavailable(f"NLLB 不支持语言：{app_code}")
        token_id = self._lang_ids.get(code)
        if token_id is None:
            # Fallback mapping known for NLLB-200.
            known = {
                "zho_Hans": 256201, "eng_Latn": 256048, "jpn_Jpan": 256080,
                "kor_Hang": 256099, "fra_Latn": 256058, "deu_Latn": 256043,
                "spa_Latn": 256162, "rus_Cyrl": 256148, "arb_Arab": 256012,
                "por_Latn": 256142, "ita_Latn": 256078, "tha_Thai": 256176,
            }
            token_id = known.get(code)
        if token_id is None:
            raise NLLBUnavailable(f"缺少语言 token：{code}")
        return int(token_id)

    def translate_batch(
        self,
        texts: Sequence[str],
        sources: Sequence[str],
        target: str,
        beam_size: int = 4,
        max_decoding_length: int = 256,
    ) -> List[str]:
        self._ensure_loaded()
        assert self._model is not None and self._sp is not None
        target_token = APP_TO_NLLB.get(target)
        if not target_token:
            raise NLLBUnavailable(f"NLLB 不支持目标语言：{target}")
        output = ["" for _ in texts]
        prepared: List[List[str]] = []
        indices: List[int] = []
        for idx, (text, source) in enumerate(zip(texts, sources)):
            text = (text or "").strip()
            if not text:
                continue
            phrase_key = re.sub(r"\s+", " ", text.lower())
            phrase = PHRASEBOOK.get((source, target), {}).get(phrase_key)
            if phrase:
                output[idx] = phrase
                continue
            source_token = APP_TO_NLLB.get(source)
            if not source_token:
                raise NLLBUnavailable(f"NLLB 不支持源语言：{source}")
            pieces = self._sp.encode(text, out_type=int)
            prepared.append([source_token] + [self._sp.id_to_piece(piece) for piece in pieces] + ["</s>"])
            indices.append(idx)
        if not prepared:
            return output
        results = self._model.translate_batch(
            prepared,
            target_prefix=[[target_token] for _ in prepared],
            beam_size=beam_size,
            max_batch_size=8,
            max_decoding_length=max_decoding_length,
            length_penalty=1.0,
            repetition_penalty=1.08,
            no_repeat_ngram_size=4,
        )
        for original_index, result in zip(indices, results):
            hypothesis = list(result.hypotheses[0])
            if hypothesis and hypothesis[0] == target_token:
                hypothesis = hypothesis[1:]
            pieces = [
                token for token in hypothesis
                if token not in ("<s>", "</s>", "<pad>", "<unk>", "<mask>")
            ]
            ids = [self._sp.piece_to_id(token) for token in pieces]
            output[original_index] = self._sp.decode([i for i in ids if i > 3]).strip()
        return output

    def translate(
        self, text: str, source: str, target: str, beam_size: int = 4
    ) -> str:
        return self.translate_batch([text], [source], target, beam_size=beam_size)[0]
