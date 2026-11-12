# -*- coding: utf-8 -*-
"""Shared language metadata for the LilacLingua backend."""

from __future__ import annotations

from typing import Dict, List

LANGUAGES: List[Dict[str, str]] = [
    {"code": "zh", "name": "中文", "native": "中文", "mm": "zh-CN", "flag": "中"},
    {"code": "en", "name": "英语", "native": "English", "mm": "en-US", "flag": "EN"},
    {"code": "ja", "name": "日语", "native": "日本語", "mm": "ja-JP", "flag": "日"},
    {"code": "ko", "name": "韩语", "native": "한국어", "mm": "ko-KR", "flag": "한"},
    {"code": "fr", "name": "法语", "native": "Français", "mm": "fr-FR", "flag": "FR"},
    {"code": "de", "name": "德语", "native": "Deutsch", "mm": "de-DE", "flag": "DE"},
    {"code": "es", "name": "西班牙语", "native": "Español", "mm": "es-ES", "flag": "ES"},
    {"code": "ru", "name": "俄语", "native": "Русский", "mm": "ru-RU", "flag": "RU"},
    {"code": "ar", "name": "阿拉伯语", "native": "العربية", "mm": "ar-SA", "flag": "AR"},
    {"code": "pt", "name": "葡萄牙语", "native": "Português", "mm": "pt-PT", "flag": "PT"},
    {"code": "it", "name": "意大利语", "native": "Italiano", "mm": "it-IT", "flag": "IT"},
    {"code": "th", "name": "泰语", "native": "ไทย", "mm": "th-TH", "flag": "TH"},
]

LANG_BY_CODE: Dict[str, Dict[str, str]] = {item["code"]: item for item in LANGUAGES}
LANG_CODES = list(LANG_BY_CODE)

# Languages for which a small Vosk acoustic model is bundled.
ASR_LANGUAGES = ["zh", "en"]


def normalize_lang(code: str | None, default: str = "auto") -> str:
    code = (code or "").strip().lower()
    if code in ("", "auto", "autodetect", "detect"):
        return "auto"
    aliases = {
        "zh-cn": "zh", "zh-hans": "zh", "cn": "zh", "chinese": "zh",
        "en-us": "en", "en-gb": "en", "english": "en",
        "ja-jp": "ja", "jp": "ja", "japanese": "ja",
        "ko-kr": "ko", "korean": "ko",
        "fr-fr": "fr", "de-de": "de", "es-es": "es", "ru-ru": "ru",
        "ar-sa": "ar", "pt-pt": "pt", "it-it": "it", "th-th": "th",
    }
    return aliases.get(code, code if code in LANG_BY_CODE else default)


def display_name(code: str) -> str:
    if code in ("auto", "", None):
        return "自动检测"
    item = LANG_BY_CODE.get(code)
    return item["name"] if item else code


def mymemory_code(code: str) -> str:
    item = LANG_BY_CODE.get(code)
    return item["mm"] if item else "en-US"
