import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from posixpath import basename, dirname, join as posix_join, normpath
from typing import Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

from bs4 import BeautifulSoup
from charset_normalizer import from_bytes
from docx import Document
import ebooklib
from ebooklib import epub
from markdownify import markdownify as html_to_markdown

logger = logging.getLogger(__name__)

_IMAGE_EXTENSIONS = {"png", "jpg", "gif", "webp", "svg", "bmp"}


SUPPORTED_DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".epub",
    ".mobi",
    ".azw",
    ".azw3",
    ".docx",
    ".txt",
    ".html",
    ".htm",
}


def detect_document_extension(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext not in SUPPORTED_DOCUMENT_EXTENSIONS:
        raise ValueError(f"Unsupported document format: '{ext or 'unknown'}'")
    return ext


def decode_text_bytes(raw_bytes: bytes) -> str:
    if not raw_bytes:
        return ""
    best = from_bytes(raw_bytes).best()
    if best is None:
        return raw_bytes.decode("utf-8", errors="strict")
    return str(best)


def html_bytes_to_markdown(raw_bytes: bytes) -> str:
    html_text = decode_text_bytes(raw_bytes)
    return html_string_to_markdown(html_text)


def html_string_to_markdown(html_text: str) -> str:
    if not html_text.strip():
        return ""
    soup = BeautifulSoup(html_text, "html.parser")
    body = soup.body or soup
    markdown = html_to_markdown(str(body), heading_style="ATX")
    return markdown.strip()


def txt_bytes_to_markdown(raw_bytes: bytes) -> str:
    text = decode_text_bytes(raw_bytes)
    return text.strip()


def docx_bytes_to_markdown(raw_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        tmp.write(raw_bytes)
        tmp_path = tmp.name
    try:
        doc = Document(tmp_path)
        blocks: List[str] = []
        for p in doc.paragraphs:
            content = (p.text or "").strip()
            if content:
                blocks.append(content)
        return "\n\n".join(blocks).strip()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _image_extension(name: str, data: bytes) -> str:
    ext = Path(name).suffix.lower().lstrip(".")
    if ext == "jpeg":
        ext = "jpg"
    if ext in _IMAGE_EXTENSIONS:
        return ext
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    head = data[:300].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "svg"
    return ""


def _resolve_epub_href(chapter_name: str, src: str) -> Optional[str]:
    raw = (src or "").strip()
    if not raw or raw.startswith("#") or raw.lower().startswith("data:"):
        return None
    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https", "mailto"}:
        return None
    path = unquote(parsed.path or "").replace("\\", "/")
    if not path:
        return None
    if path.startswith("/"):
        resolved = normpath(path.lstrip("/"))
    else:
        base = dirname((chapter_name or "").replace("\\", "/"))
        resolved = normpath(posix_join(base, path)) if base else normpath(path)
    if resolved in {"", "."} or resolved.startswith("../") or resolved == "..":
        return None
    return resolved


def _lookup_epub_item(book, href: str):
    href_norm = (href or "").replace("\\", "/").lstrip("./")
    if not href_norm:
        return None
    direct = book.get_item_with_href(href_norm)
    if direct is not None:
        return direct
    exact = []
    by_base = []
    base = basename(href_norm).lower()
    for item in book.get_items():
        name = (item.get_name() or "").replace("\\", "/")
        if name == href_norm or name.lstrip("./") == href_norm:
            return item
        if name.lower().endswith("/" + href_norm.lower()):
            exact.append(item)
        if base and basename(name).lower() == base:
            by_base.append(item)
    if len(exact) == 1:
        return exact[0]
    if len(by_base) == 1:
        return by_base[0]
    return None


def _remember_src(mapping: Dict[str, str], src: str, resolved: Optional[str], web_path: str) -> None:
    raw = (src or "").strip()
    if raw:
        mapping.setdefault(raw, web_path)
        mapping.setdefault(unquote(raw), web_path)
        mapping.setdefault(raw.split("#", 1)[0].split("?", 1)[0], web_path)
    if resolved:
        mapping.setdefault(resolved, web_path)
        mapping.setdefault(basename(resolved), web_path)


def _store_epub_image(data: bytes, source_name: str, images_dir: str) -> Optional[str]:
    ext = _image_extension(source_name, data)
    if not ext or not data:
        return None
    filename = f"{hashlib.sha256(data).hexdigest()}.{ext}"
    os.makedirs(images_dir, exist_ok=True)
    out_path = os.path.join(images_dir, filename)
    if not os.path.exists(out_path):
        with open(out_path, "wb") as handle:
            handle.write(data)
    return filename


def _chapter_markdown_with_images(
    book,
    item,
    images_dir: Optional[str],
    src_map: Dict[str, str],
    filenames: List[str],
) -> str:
    content = item.get_content() or b""
    if not images_dir:
        return html_bytes_to_markdown(content).strip()
    soup = BeautifulSoup(content, "html.parser")
    chapter_name = item.get_name() or ""
    rewritten = False
    for img in soup.find_all("img"):
        src = img.get("src")
        resolved = _resolve_epub_href(chapter_name, src or "")
        if not resolved:
            continue
        image_item = _lookup_epub_item(book, resolved)
        if image_item is None:
            logger.warning("EPUB image was not in the zip: %s (from %s)", src, chapter_name)
            continue
        data = image_item.get_content() or b""
        filename = _store_epub_image(data, image_item.get_name() or resolved, images_dir)
        if not filename:
            logger.warning("EPUB image has no supported bytes: %s", src)
            continue
        web_path = f"/images/app/{filename}"
        _remember_src(src_map, src or "", resolved, web_path)
        img["src"] = web_path
        if filename not in filenames:
            filenames.append(filename)
        rewritten = True
    if not rewritten:
        return html_bytes_to_markdown(content).strip()
    return html_string_to_markdown(str(soup)).strip()


def epub_bytes_to_markdown(
    raw_bytes: bytes,
    images_dir: Optional[str] = None,
) -> Tuple[str, List[str]]:
    """Convert an EPUB to markdown.

    When images_dir is set, each img src inside the zip is written under a
    content hash and the src is rewritten to /images/app/<hash> before the
    HTML becomes markdown. The picture stays where it sits in the chapter.
    """
    markdown, filenames, _src_map = convert_epub_bytes(raw_bytes, images_dir)
    return markdown, filenames


def epub_source_image_map(raw_bytes: bytes, images_dir: str) -> Dict[str, str]:
    """Map original EPUB img src strings to /images/app/<hash> paths."""
    _markdown, _filenames, src_map = convert_epub_bytes(raw_bytes, images_dir)
    return src_map


def convert_epub_bytes(
    raw_bytes: bytes,
    images_dir: Optional[str] = None,
) -> Tuple[str, List[str], Dict[str, str]]:
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(raw_bytes)
        epub_path = tmp.name
    try:
        book = epub.read_epub(epub_path)
        parts: List[str] = []
        filenames: List[str] = []
        src_map: Dict[str, str] = {}
        for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
            md = _chapter_markdown_with_images(book, item, images_dir, src_map, filenames)
            if md:
                parts.append(md)
        return "\n\n---\n\n".join(parts).strip(), filenames, src_map
    finally:
        try:
            os.remove(epub_path)
        except OSError:
            pass


def images_are_already_inline(markdown: str, filenames: List[str]) -> bool:
    """True when every extracted file is already linked as /images/app/<name>."""
    names = [name for name in filenames if name]
    if not names:
        return False
    return all(f"/images/app/{name}" in (markdown or "") for name in names)


def mobi_or_azw_to_epub_bytes(raw_bytes: bytes, source_extension: str) -> bytes:
    converter = shutil.which("ebook-convert")
    if not converter:
        raise RuntimeError("ebook-convert is not available; cannot process MOBI/AZW files.")
    with tempfile.NamedTemporaryFile(suffix=source_extension, delete=False) as src:
        src.write(raw_bytes)
        src_path = src.name
    dst_fd, dst_path = tempfile.mkstemp(suffix=".epub")
    os.close(dst_fd)
    try:
        result = subprocess.run(
            [converter, src_path, dst_path],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                "ebook-convert failed for MOBI/AZW input: "
                f"{result.stderr.strip() or result.stdout.strip() or 'unknown error'}"
            )
        with open(dst_path, "rb") as f:
            return f.read()
    finally:
        for path in (src_path, dst_path):
            try:
                os.remove(path)
            except OSError:
                pass
