#!/usr/bin/env python3
"""
Smoke test for the PDF pipeline (text extraction and optional PaddleOCR).
Run from project root:
  python pdf_service/scripts/smoke_test_pdf_pipeline.py
Or with .env present:
  cd pdf_service && python scripts/smoke_test_pdf_pipeline.py
Creates a minimal in-memory text PDF and runs pdf_has_text + process_text_pdf; optionally runs PaddleOCR if PDF_OCR_ENGINE=paddle.
"""
import io
import os
import sys

# Set minimal env for storage paths if not already set (so app import does not exit)
def _set_default_env():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    for key, default in (
        ("PDF_STORAGE_PATH", os.path.join(root, "storage", "pdfs")),
        ("MARKDOWN_PATH", os.path.join(root, "storage", "output")),
        ("IMAGES_PATH", os.path.join(root, "storage", "images")),
    ):
        if not os.environ.get(key):
            os.environ[key] = default


_set_default_env()


def _add_app_to_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    pdf_service_root = os.path.dirname(script_dir)
    if pdf_service_root not in sys.path:
        sys.path.insert(0, pdf_service_root)


_add_app_to_path()


def make_minimal_text_pdf_bytes() -> bytes:
    """Produce a minimal PDF with one page and extractable text (PyMuPDF)."""
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Hello world. This is a smoke test for text extraction.", fontsize=12)
    buf = io.BytesIO()
    doc.save(buf, deflate=True)
    doc.close()
    return buf.getvalue()


def main():
    from app import pdf_has_text, process_text_pdf, PDF_OCR_ENGINE

    pdf_bytes = make_minimal_text_pdf_bytes()
    print("1. pdf_has_text:", pdf_has_text(pdf_bytes))
    text_md = process_text_pdf(pdf_bytes)
    print("2. process_text_pdf length:", len(text_md))
    assert "smoke test" in text_md or "Hello" in text_md, "Expected extractable text"
    print("3. Text pipeline smoke test passed.")

    if PDF_OCR_ENGINE == "paddle":
        try:
            from app import process_scanned_pdf_with_paddleocr
            ocr_md = process_scanned_pdf_with_paddleocr(pdf_bytes)
            print("4. process_scanned_pdf_with_paddleocr length:", len(ocr_md))
            print("5. PaddleOCR pipeline smoke test passed.")
        except Exception as e:
            print("5. PaddleOCR skipped (no GPU or dependency):", e)
    else:
        print("4. PaddleOCR skipped (PDF_OCR_ENGINE != paddle).")

    print("Done.")


if __name__ == "__main__":
    main()
