# -*- coding: utf-8 -*-
"""Readable article extraction for the built-in web translation workspace."""

from __future__ import annotations

import gzip
import html as html_lib
import re
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

BLOCK_TAGS = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
    "figcaption", "td", "th", "pre", "dt", "dd",
}
SKIP_TAGS = {
    "script", "style", "noscript", "svg", "canvas", "iframe", "form",
    "nav", "footer", "aside", "button", "select", "textarea", "template",
}
COMMON_NAV = {
    "首页", "登录", "注册", "搜索", "更多", "下一页", "上一页", "返回",
    "home", "login", "sign in", "sign up", "search", "menu", "more",
    "cookie", "privacy policy", "terms of service", "advertisement",
}


def _decode_body(raw: bytes, content_type: str) -> str:
    charsets: List[str] = []
    match = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    if match:
        charsets.append(match.group(1))
    head = raw[:4096].decode("ascii", "ignore")
    match = re.search(r"<meta[^>]+charset=[\"']?([\w-]+)", head, re.I)
    if match:
        charsets.append(match.group(1))
    charsets.extend(["utf-8", "gb18030", "big5", "latin-1"])
    for charset in charsets:
        try:
            return raw.decode(charset, "replace")
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


def fetch_html(url: str, timeout: int = 25) -> Dict[str, Any]:
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(4_000_000)
            encoding = resp.headers.get("Content-Encoding", "")
            if "gzip" in encoding:
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            elif "deflate" in encoding:
                try:
                    raw = zlib.decompress(raw)
                except Exception:
                    pass
            content_type = resp.headers.get("Content-Type", "")
            final_url = resp.geturl()
            charset = resp.headers.get_content_charset() or ""
            text = _decode_body(raw, content_type or f"charset={charset}")
            return {"html": text, "url": final_url, "content_type": content_type}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"网页返回 HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法访问网页: {exc.reason}") from exc


class ArticleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: List[Dict[str, str]] = []
        self.title = ""
        self.description = ""
        self._skip_depth = 0
        self._in_title = False
        self._title_parts: List[str] = []
        self._current_tag: Optional[str] = None
        self._buffer: List[str] = []
        self._body_text: List[str] = []

    def _flush(self) -> None:
        tag = self._current_tag
        text = html_lib.unescape(" ".join("".join(self._buffer).split()))
        self._buffer = []
        self._current_tag = None
        if not text or len(text) < 2:
            return
        if tag == "li":
            text = "• " + text
        low = text.lower().strip(" .:：·-—")
        if low in COMMON_NAV or len(low) <= 1:
            return
        if self.blocks and self.blocks[-1]["text"] == text:
            return
        self.blocks.append({"tag": tag or "p", "text": text})

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
        if tag in SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "meta":
            attr = dict(attrs)
            name = (attr.get("name") or attr.get("property") or "").lower()
            if name in ("description", "og:description") and attr.get("content"):
                self.description = attr["content"].strip()
        if tag in BLOCK_TAGS:
            self._flush()
            self._current_tag = tag

    def handle_startendtag(self, tag: str, attrs) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag in SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in BLOCK_TAGS and self._current_tag == tag:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        if self._skip_depth:
            return
        if self._current_tag:
            self._buffer.append(data)
        self._body_text.append(data)

    def close(self) -> None:
        super().close()
        self._flush()
        self.title = " ".join("".join(self._title_parts).split())
        if len(self.blocks) < 3:
            # Some modern sites render long articles as generic divs; use a
            # conservative fallback over the body text.
            raw = " ".join(" ".join(self._body_text).split())
            pieces = [p.strip() for p in re.split(r"(?<=[。！？.!?])\s+|\n+", raw) if len(p.strip()) > 30]
            for piece in pieces[:120]:
                if len(piece) > 220:
                    piece = piece[:220].rstrip() + "…"
                if all(piece != b["text"] for b in self.blocks):
                    self.blocks.append({"tag": "p", "text": piece})


def extract_article(url: str) -> Dict[str, Any]:
    fetched = fetch_html(url)
    parser = ArticleParser()
    try:
        parser.feed(fetched["html"])
        parser.close()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"网页解析失败: {exc}") from exc
    blocks: List[Dict[str, str]] = []
    total_chars = 0
    for block in parser.blocks:
        text = block["text"].strip()
        if not text:
            continue
        if total_chars + len(text) > 36000 or len(blocks) >= 180:
            break
        blocks.append(block)
        total_chars += len(text)
    if not blocks:
        snippet = re.sub(r"<[^>]+>", " ", fetched["html"])
        snippet = " ".join(html_lib.unescape(snippet).split())
        if snippet:
            blocks = [{"tag": "p", "text": snippet[:2000]}]
    if not blocks:
        raise RuntimeError("未能从该网页提取到可翻译的正文")
    return {
        "url": fetched["url"],
        "title": parser.title or fetched["url"],
        "description": parser.description,
        "blocks": blocks,
        "char_count": total_chars,
    }


def translate_article(translator, url: str, source: str, target: str, mode: str) -> Dict[str, Any]:
    article = extract_article(url)
    texts = [article["title"]] + [block["text"] for block in article["blocks"]]
    result = translator.translate_many(texts, source=source, target=target, mode=mode)
    translated = result["translations"]
    detected = result.get("detected_source") or source
    paragraphs = []
    for idx, block in enumerate(article["blocks"]):
        paragraphs.append(
            {
                "tag": block["tag"],
                "original": block["text"],
                "translated": translated[idx + 1] if idx + 1 < len(translated) else "",
            }
        )
    return {
        "url": article["url"],
        "title": article["title"],
        "translated_title": translated[0] if translated else article["title"],
        "description": article["description"],
        "paragraphs": paragraphs,
        "detected_source": detected,
        "provider": result.get("provider"),
        "mode": mode,
        "latency_ms": result.get("latency_ms"),
        "char_count": article["char_count"],
    }
