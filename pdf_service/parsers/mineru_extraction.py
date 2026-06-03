"""
MinerU (formerly magic-pdf) PDF extraction for scanned / image-heavy documents.

Requires: pip install "mineru[pipeline]" and model weights (see pdf_service/scripts/download_models.py).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from typing import List, Tuple

logger = logging.getLogger(__name__)

_mineru_unavailable_reason: str | None = None


def mineru_is_available() -> bool:
    global _mineru_unavailable_reason
    if _mineru_unavailable_reason:
        return False
    try:
        import mineru  # noqa: F401
        from mineru.cli.common import do_parse  # noqa: F401
        return True
    except Exception as exc:
        _mineru_unavailable_reason = str(exc)
        return False


def _rewrite_mineru_image_paths(md_text: str, web_base: str = "/images/app") -> str:
    """Rewrite MinerU relative image paths to stable app image URLs."""
    base = web_base.rstrip("/")

    def replacer(match: re.Match) -> str:
        alt = match.group(1)
        path = match.group(2).strip()
        filename = os.path.basename(path.replace("\\", "/"))
        return f"![{alt}]({base}/{filename})"

    return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", replacer, md_text)


def process_pdf_with_mineru(
    pdf_bytes: bytes,
    sanitized_title: str,
    app_images_path: str,
    lang: str | None = None,
) -> Tuple[str, List[List[str]]]:
    """
    Run MinerU pipeline backend and return markdown with /images/app/ links.
    Images are copied into app_images_path; images_per_page is empty because links are inline in md.
    """
    if not app_images_path:
        raise RuntimeError("app_images_path is required for MinerU extraction")

    if not mineru_is_available():
        raise RuntimeError(
            f"MinerU is not available: {_mineru_unavailable_reason or 'unknown'}. "
            "Install with: pip install \"mineru[pipeline]\" and download models."
        )

    from mineru.cli.common import do_parse
    from mineru.utils.enum_class import MakeMode

    ocr_lang = lang or os.getenv("PDF_OCR_LANG", "en")
    # MinerU language codes differ; map common values.
    lang_map = {"en": "en", "ch": "ch", "chinese": "ch", "english": "en"}
    mineru_lang = lang_map.get(ocr_lang.lower(), ocr_lang)

    backend = os.getenv("MINERU_BACKEND", "pipeline")
    parse_method = os.getenv("MINERU_PARSE_METHOD", "auto")

    models_dir = os.getenv("MINERU_MODELS_PATH", os.getenv("MINERU_MODELS_DIR", ""))
    if models_dir:
        os.environ.setdefault("MINERU_MODELS_DIR", models_dir)

    with tempfile.TemporaryDirectory(prefix="mineru_out_") as tmp_out:
        logger.info(
            "Running MinerU (backend=%s, parse_method=%s, lang=%s) for %s",
            backend,
            parse_method,
            mineru_lang,
            sanitized_title,
        )
        do_parse(
            output_dir=tmp_out,
            pdf_file_names=[sanitized_title],
            pdf_bytes_list=[pdf_bytes],
            p_lang_list=[mineru_lang],
            backend=backend,
            parse_method=parse_method,
            formula_enable=os.getenv("MINERU_FORMULA_ENABLE", "true").lower() == "true",
            table_enable=os.getenv("MINERU_TABLE_ENABLE", "true").lower() == "true",
            f_draw_layout_bbox=False,
            f_draw_span_bbox=False,
            f_dump_md=True,
            f_dump_middle_json=False,
            f_dump_model_output=False,
            f_dump_orig_pdf=False,
            f_dump_content_list=False,
            f_make_md_mode=MakeMode.MM_MD,
        )

        parse_subdir = backend if backend == "pipeline" else f"hybrid_{parse_method}"
        md_dir = os.path.join(tmp_out, sanitized_title, parse_subdir)
        md_path = os.path.join(md_dir, f"{sanitized_title}.md")
        images_src_dir = os.path.join(md_dir, "images")

        if not os.path.isfile(md_path):
            # Fallback: search for any .md under output tree
            md_candidates: List[str] = []
            for root, _dirs, files in os.walk(tmp_out):
                for name in files:
                    if name.endswith(".md") and not name.endswith("_layout.md"):
                        md_candidates.append(os.path.join(root, name))
            if not md_candidates:
                raise RuntimeError(f"MinerU did not produce markdown under {tmp_out}")
            md_path = md_candidates[0]
            md_dir = os.path.dirname(md_path)
            images_src_dir = os.path.join(md_dir, "images")

        with open(md_path, encoding="utf-8") as f:
            md_text = f.read()

        if os.path.isdir(images_src_dir):
            for name in os.listdir(images_src_dir):
                src = os.path.join(images_src_dir, name)
                if not os.path.isfile(src):
                    continue
                dst = os.path.join(app_images_path, name)
                shutil.copy2(src, dst)
            logger.info(
                "MinerU copied %s images to %s",
                len(os.listdir(images_src_dir)),
                app_images_path,
            )

        md_text = _rewrite_mineru_image_paths(md_text)
        logger.info("MinerU extraction complete. Markdown length=%s", len(md_text))
        return md_text, []
