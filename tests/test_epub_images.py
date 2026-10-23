import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pdf_service"))

from parsers.document_parsers import (  # noqa: E402
    epub_bytes_to_markdown,
    images_are_already_inline,
)

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


def _epub_with_image(chapter_name: str, src: str) -> bytes:
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier("img-id")
    book.set_title("Image EPUB")
    book.set_language("en")
    image = epub.EpubItem(
        uid="cover",
        file_name="images/cover.png",
        media_type="image/png",
        content=PNG,
    )
    book.add_item(image)
    chapter = epub.EpubHtml(title="Chapter", file_name=chapter_name, lang="en")
    chapter.content = (
        "<h1>Chapter</h1><p>Before the figure.</p>"
        f'<img src="{src}" alt="Cover"/>'
        "<p>After the figure.</p>"
    )
    book.add_item(chapter)
    book.toc = (chapter,)
    book.spine = ["nav", chapter]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        epub_path = tmp.name
    try:
        epub.write_epub(epub_path, book)
        return Path(epub_path).read_bytes()
    finally:
        Path(epub_path).unlink(missing_ok=True)


def test_epub_image_is_written_inline_once():
    raw = _epub_with_image("text/chapter.xhtml", "../images/cover.png")
    with tempfile.TemporaryDirectory() as images_dir:
        markdown, names = epub_bytes_to_markdown(raw, images_dir=images_dir)
        assert len(names) == 1
        web_path = f"/images/app/{names[0]}"
        assert markdown.count(web_path) == 1
        assert "Before the figure." in markdown
        assert "After the figure." in markdown
        assert markdown.index("Before") < markdown.index(web_path) < markdown.index("After")
        assert "../images/cover.png" not in markdown
        assert (Path(images_dir) / names[0]).read_bytes() == PNG
        assert images_are_already_inline(markdown, names)
        again, again_names = epub_bytes_to_markdown(raw, images_dir=images_dir)
        assert again_names == names
        assert again.count(web_path) == 1


def test_missing_epub_image_keeps_the_chapter_text():
    raw = _epub_with_image("chapter.xhtml", "images/missing.png")
    with tempfile.TemporaryDirectory() as images_dir:
        markdown, names = epub_bytes_to_markdown(raw, images_dir=images_dir)
        assert names == []
        assert "Before the figure." in markdown
        assert not images_are_already_inline(markdown, names)
