import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from posixpath import basename, dirname, join as posix_join, normpath
from typing import Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

from bs4 import BeautifulSoup
from charset_normalizer import from_bytes
from docx import Document
import ebooklib
from ebooklib import epub
from lxml import etree
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


_OPF_NS = "http://www.idpf.org/2007/opf"
_CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"


def _xml_parser():
    return etree.XMLParser(no_network=True, load_dtd=False, resolve_entities=False)


def _normalized_zip_names(zf: zipfile.ZipFile) -> set:
    names = set()
    for name in zf.namelist():
        cleaned = normpath(name.replace("\\", "/").lstrip("/"))
        if cleaned not in {"", "."}:
            names.add(cleaned)
    return names


def _opf_member_name(zf: zipfile.ZipFile) -> str:
    root = etree.fromstring(zf.read("META-INF/container.xml"), _xml_parser())
    nodes = root.xpath(
        "//c:rootfile[@media-type='application/oebps-package+xml']",
        namespaces={"c": _CONTAINER_NS},
    )
    if not nodes:
        raise ValueError("EPUB package document was not listed in the container")
    full_path = (nodes[0].get("full-path") or "").replace("\\", "/")
    for name in zf.namelist():
        if name.replace("\\", "/") == full_path:
            return name
    raise ValueError(f"EPUB package document is missing: {full_path}")


def _href_in_zip(names: set, opf_dir: str, href: str) -> bool:
    raw = unquote((href or "").split("#", 1)[0].split("?", 1)[0]).replace("\\", "/")
    if not raw or raw.startswith("/"):
        raw = raw.lstrip("/")
    if not raw:
        return False
    candidates = [normpath(raw)]
    if opf_dir:
        candidates.append(normpath(posix_join(opf_dir, raw)))
    return any(candidate in names for candidate in candidates)


def _rewrite_epub_member(epub_path: str, member: str, new_bytes: bytes) -> None:
    directory = os.path.dirname(epub_path) or None
    fd, tmp_path = tempfile.mkstemp(suffix=".epub", dir=directory)
    os.close(fd)
    try:
        with zipfile.ZipFile(epub_path, "r") as source, zipfile.ZipFile(tmp_path, "w") as dest:
            infos = sorted(source.infolist(), key=lambda info: 0 if info.filename == "mimetype" else 1)
            for info in infos:
                data = new_bytes if info.filename == member else source.read(info.filename)
                replacement = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
                replacement.compress_type = (
                    zipfile.ZIP_STORED if info.filename == "mimetype" else info.compress_type
                )
                replacement.external_attr = info.external_attr
                replacement.flag_bits = info.flag_bits
                dest.writestr(replacement, data)
        os.replace(tmp_path, epub_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def _local_name(element) -> str:
    return etree.QName(element).localname


def prepare_epub_for_read(epub_path: str) -> None:
    """Drop a spine contents id that is not in the package, then the caller reads it again.

    ebooklib 0.20 follows the spine ``toc`` id and calls ``get_name()`` on that item.
    A missing id raises ``AttributeError`` before any chapter is read. A contents file
    that is listed but absent from the zip is removed so that file is skipped.
    The remaining spine itemrefs stay in their original order.
    """
    with zipfile.ZipFile(epub_path, "r") as zf:
        opf_name = _opf_member_name(zf)
        opf_bytes = zf.read(opf_name)
        names = _normalized_zip_names(zf)
        root = etree.fromstring(opf_bytes, _xml_parser())
        manifest = root.find(f"{{{_OPF_NS}}}manifest")
        spine = root.find(f"{{{_OPF_NS}}}spine")
        if manifest is None or spine is None:
            return
        opf_dir = dirname(opf_name.replace("\\", "/"))
        if opf_dir == ".":
            opf_dir = ""
        toc_id = spine.get("toc") or ""
        toc_payload = b""
        if toc_id:
            href = ""
            for item in manifest:
                if _local_name(item) == "item" and item.get("id") == toc_id:
                    href = item.get("href") or ""
                    break
            joined = normpath(posix_join(opf_dir, unquote(href))) if opf_dir and href else normpath(unquote(href or ""))
            for info in zf.infolist():
                if normpath(info.filename.replace("\\", "/").lstrip("/")) == joined:
                    toc_payload = zf.read(info.filename)
                    break

    items = [item for item in list(manifest) if _local_name(item) == "item"]
    by_id = {item.get("id"): item for item in items if item.get("id")}
    ids = set(by_id)
    changed = False

    def drop_manifest_id(item_id: str) -> None:
        nonlocal changed
        item = by_id.pop(item_id, None)
        if item is not None and item.getparent() is manifest:
            manifest.remove(item)
            ids.discard(item_id)
            changed = True
        for ref in list(spine):
            if ref.getparent() is spine and _local_name(ref) == "itemref" and ref.get("idref") == item_id:
                spine.remove(ref)
                changed = True

    toc_id = spine.get("toc") or ""
    if toc_id and toc_id not in ids:
        logger.warning("Dropping spine contents id that is not in the package: %s", toc_id)
        del spine.attrib["toc"]
        changed = True
    elif toc_id and toc_id in by_id:
        href = by_id[toc_id].get("href") or ""
        if not _href_in_zip(names, opf_dir, href):
            logger.warning("Skipping contents file missing from the EPUB zip: %s", href or toc_id)
            drop_manifest_id(toc_id)
            if "toc" in spine.attrib:
                del spine.attrib["toc"]
                changed = True
        elif toc_payload:
            try:
                etree.fromstring(toc_payload, _xml_parser())
            except etree.XMLSyntaxError:
                logger.warning("Skipping broken contents file: %s", href or toc_id)
                if "toc" in spine.attrib:
                    del spine.attrib["toc"]
                    changed = True

    for ref in list(spine):
        if ref.getparent() is not spine or _local_name(ref) != "itemref":
            continue
        idref = ref.get("idref") or ""
        if idref and idref not in ids:
            logger.warning("Dropping spine contents id that is not in the package: %s", idref)
            spine.remove(ref)
            changed = True

    if not changed:
        return

    new_opf = etree.tostring(root, xml_declaration=True, encoding="utf-8")
    _rewrite_epub_member(epub_path, opf_name, new_opf)


def _spine_document_items(book):
    """Chapter documents in spine order. A missing id is skipped."""
    documents = []
    seen = set()
    for entry in getattr(book, "spine", None) or []:
        idref = entry[0] if isinstance(entry, tuple) else entry
        if isinstance(idref, str):
            item = book.get_item_with_id(idref)
            label = idref
        else:
            item = idref
            label = getattr(item, "id", None)
        if item is None:
            logger.warning("Skipping spine contents id that is not in the package: %s", label)
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        key = item.get_id() or item.get_name()
        if key in seen:
            continue
        seen.add(key)
        documents.append(item)
    if documents:
        return documents
    return list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))


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
        prepare_epub_for_read(epub_path)
        book = epub.read_epub(epub_path)
        parts: List[str] = []
        filenames: List[str] = []
        src_map: Dict[str, str] = {}
        for item in _spine_document_items(book):
            try:
                md = _chapter_markdown_with_images(book, item, images_dir, src_map, filenames)
            except Exception:
                logger.warning(
                    "Skipping unreadable EPUB chapter: %s",
                    item.get_name() or item.get_id(),
                    exc_info=True,
                )
                continue
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
