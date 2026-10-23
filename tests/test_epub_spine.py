import io
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pdf_service"))

from parsers.document_parsers import epub_bytes_to_markdown  # noqa: E402


def _write_book(book) -> bytes:
    from ebooklib import epub

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        epub_path = tmp.name
    try:
        epub.write_epub(epub_path, book)
        return Path(epub_path).read_bytes()
    finally:
        Path(epub_path).unlink(missing_ok=True)


def _two_chapter_epub() -> bytes:
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier("spine-order")
    book.set_title("Spine Order")
    book.set_language("en")
    first = epub.EpubHtml(title="First", file_name="first.xhtml", lang="en", uid="first")
    first.content = "<h1>First chapter</h1><p>Alpha text.</p>"
    second = epub.EpubHtml(title="Second", file_name="second.xhtml", lang="en", uid="second")
    second.content = "<h1>Second chapter</h1><p>Beta text.</p>"
    book.add_item(first)
    book.add_item(second)
    book.add_item(epub.EpubNcx())
    book.spine = [second, first]
    return _write_book(book)


def _opf_name(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        root = etree.fromstring(zf.read("META-INF/container.xml"))
        node = root.xpath(
            "//c:rootfile[@media-type='application/oebps-package+xml']",
            namespaces={"c": "urn:oasis:names:tc:opendocument:xmlns:container"},
        )[0]
        full_path = node.get("full-path")
        for name in zf.namelist():
            if name.replace("\\", "/") == full_path:
                return name
    raise AssertionError("package document was not in the zip")


def _replace_opf(raw: bytes, new_opf: bytes) -> bytes:
    opf_name = _opf_name(raw)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, "w") as dest:
        infos = sorted(source.infolist(), key=lambda info: 0 if info.filename == "mimetype" else 1)
        for info in infos:
            data = new_opf if info.filename == opf_name else source.read(info.filename)
            replacement = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
            replacement.compress_type = zipfile.ZIP_STORED if info.filename == "mimetype" else info.compress_type
            dest.writestr(replacement, data)
    return output.getvalue()


def _with_spine_toc(raw: bytes, toc_id: str) -> bytes:
    opf_name = _opf_name(raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        opf = zf.read(opf_name)
    text = opf.decode("utf-8")
    if 'toc="' not in text:
        raise AssertionError("generated package has no spine toc id")
    text = text.replace('toc="ncx"', f'toc="{toc_id}"', 1)
    return _replace_opf(raw, text.encode("utf-8"))


def _without_ncx_file(raw: bytes) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, "w") as dest:
        infos = sorted(source.infolist(), key=lambda info: 0 if info.filename == "mimetype" else 1)
        removed = False
        for info in infos:
            if info.filename.replace("\\", "/").endswith("toc.ncx"):
                removed = True
                continue
            data = source.read(info.filename)
            replacement = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
            replacement.compress_type = zipfile.ZIP_STORED if info.filename == "mimetype" else info.compress_type
            dest.writestr(replacement, data)
    if not removed:
        raise AssertionError("generated package has no toc.ncx")
    return output.getvalue()


def _with_dangling_itemref(raw: bytes) -> bytes:
    opf_name = _opf_name(raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        text = zf.read(opf_name).decode("utf-8")
    needle = "<itemref "
    if needle not in text:
        raise AssertionError("generated package has no spine item")
    text = text.replace(needle, '<itemref idref="missing-chapter" />' + needle, 1)
    return _replace_opf(raw, text.encode("utf-8"))


def _markdown(raw: bytes) -> str:
    markdown, _names = epub_bytes_to_markdown(raw)
    return markdown


def test_chapters_follow_spine_order():
    markdown = _markdown(_two_chapter_epub())
    assert "Beta text." in markdown
    assert "Alpha text." in markdown
    assert markdown.index("Beta text.") < markdown.index("Alpha text.")


def test_missing_spine_toc_id_still_reads_chapters_in_spine_order():
    raw = _with_spine_toc(_two_chapter_epub(), "missing-toc")
    from ebooklib import epub

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(raw)
        path = tmp.name
    try:
        try:
            epub.read_epub(path)
        except AttributeError as exc:
            assert "get_name" in str(exc)
        else:
            raise AssertionError("ebooklib should fail when the spine contents id is missing")
    finally:
        Path(path).unlink(missing_ok=True)

    markdown = _markdown(raw)
    assert markdown.index("Beta text.") < markdown.index("Alpha text.")


def test_missing_contents_file_is_skipped():
    markdown = _markdown(_without_ncx_file(_two_chapter_epub()))
    assert markdown.index("Beta text.") < markdown.index("Alpha text.")


def test_dangling_spine_item_is_skipped():
    markdown = _markdown(_with_dangling_itemref(_two_chapter_epub()))
    assert markdown.index("Beta text.") < markdown.index("Alpha text.")
