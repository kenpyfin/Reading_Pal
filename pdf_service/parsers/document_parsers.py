import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List

from bs4 import BeautifulSoup
from charset_normalizer import from_bytes
from docx import Document
import ebooklib
from ebooklib import epub
from markdownify import markdownify as html_to_markdown


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


def epub_bytes_to_markdown(raw_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(raw_bytes)
        epub_path = tmp.name
    try:
        book = epub.read_epub(epub_path)
        parts: List[str] = []
        for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
            content = item.get_content() or b""
            md = html_bytes_to_markdown(content).strip()
            if md:
                parts.append(md)
        return "\n\n---\n\n".join(parts).strip()
    finally:
        try:
            os.remove(epub_path)
        except OSError:
            pass


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
