"""
Layout-aware figure extraction for scanned PDF pages.

Figures baked into a flat page scan are not separate PDF image objects; this module
uses PaddleOCR LayoutDetection (PP-DocLayout) to find image/figure/chart regions and
crop them from the rendered page bitmap.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
from PIL import Image

from parsers.paddle_device import resolve_paddle_device

logger = logging.getLogger(__name__)

# Layout labels treated as visual figure regions (not text/tables/formulas).
LAYOUT_FIGURE_LABELS: Set[str] = frozenset(
    {
        "image",
        "figure",
        "chart",
        "header_image",
        "footer_image",
    }
)

_layout_detector_instance: Optional[Any] = None
_layout_detector_unavailable_reason: Optional[str] = None


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s=%r; using default %s", name, raw, default)
        return default


def get_layout_figure_labels() -> Set[str]:
    """Optional override: PDF_LAYOUT_FIGURE_LABELS=image,figure,chart"""
    raw = os.getenv("PDF_LAYOUT_FIGURE_LABELS", "").strip()
    if not raw:
        return set(LAYOUT_FIGURE_LABELS)
    labels = {part.strip().lower() for part in raw.split(",") if part.strip()}
    return labels or set(LAYOUT_FIGURE_LABELS)


def get_layout_detector():
    """Lazy singleton for PaddleOCR LayoutDetection."""
    global _layout_detector_instance, _layout_detector_unavailable_reason
    if _layout_detector_instance is not None:
        return _layout_detector_instance
    if _layout_detector_unavailable_reason:
        return None

    try:
        from paddleocr import LayoutDetection
    except Exception as exc:
        _layout_detector_unavailable_reason = f"LayoutDetection import failed: {exc}"
        logger.warning(_layout_detector_unavailable_reason)
        return None

    model_name = os.getenv("PDF_LAYOUT_MODEL_NAME", "PP-DocLayout_plus-L")
    device = resolve_paddle_device("PDF_LAYOUT_DEVICE", default_gpu="gpu:0")
    score_threshold = _env_float("PDF_LAYOUT_FIGURE_SCORE_THRESHOLD", 0.45)

    try:
        _layout_detector_instance = LayoutDetection(
            model_name=model_name,
            device=device,
            threshold=score_threshold,
        )
        logger.info(
            "LayoutDetection ready (model=%s, device=%s, threshold=%.2f)",
            model_name,
            device,
            score_threshold,
        )
        return _layout_detector_instance
    except Exception as exc:
        _layout_detector_unavailable_reason = f"LayoutDetection init failed: {exc}"
        logger.warning(_layout_detector_unavailable_reason)
        return None


def _normalize_box(
    coordinate: Sequence[float], page_w: int, page_h: int, padding_ratio: float = 0.01
) -> Optional[Tuple[int, int, int, int]]:
    if len(coordinate) < 4:
        return None
    x0, y0, x1, y1 = [float(v) for v in coordinate[:4]]
    if x1 <= x0 or y1 <= y0:
        return None

    pad_x = max(int(page_w * padding_ratio), 2)
    pad_y = max(int(page_h * padding_ratio), 2)
    ix0 = max(0, int(np.floor(x0)) - pad_x)
    iy0 = max(0, int(np.floor(y0)) - pad_y)
    ix1 = min(page_w, int(np.ceil(x1)) + pad_x)
    iy1 = min(page_h, int(np.ceil(y1)) + pad_y)
    if ix1 <= ix0 or iy1 <= iy0:
        return None
    return ix0, iy0, ix1, iy1


def _box_area_ratio(box: Tuple[int, int, int, int], page_w: int, page_h: int) -> float:
    x0, y0, x1, y1 = box
    return float((x1 - x0) * (y1 - y0)) / float(max(page_w * page_h, 1))


def _iter_layout_boxes(prediction_result: Any) -> List[Dict[str, Any]]:
    """Read layout boxes from a LayoutDetection Result object."""
    payload: Any = None
    if hasattr(prediction_result, "json"):
        try:
            payload = prediction_result.json
        except Exception:
            payload = None
    if payload is None and isinstance(prediction_result, dict):
        payload = prediction_result
    if not isinstance(payload, dict):
        return []

    res = payload.get("res", payload)
    if isinstance(res, dict):
        boxes = res.get("boxes")
        if isinstance(boxes, list):
            return [b for b in boxes if isinstance(b, dict)]
    return []


def _save_crop(
    page_img: np.ndarray,
    box: Tuple[int, int, int, int],
    out_path: str,
) -> bool:
    x0, y0, x1, y1 = box
    crop = page_img[y0:y1, x0:x1]
    if crop.size == 0:
        return False
    Image.fromarray(crop).save(out_path, format="PNG")
    return True


def extract_layout_figures_from_page(
    page_img: np.ndarray,
    sanitized_title: str,
    page_num: int,
    app_images_path: str,
) -> List[str]:
    """Detect figure/image/chart regions with LayoutDetection and save crops."""
    if page_img is None or page_img.size == 0 or not app_images_path:
        return []

    detector = get_layout_detector()
    if detector is None:
        return []

    h, w = page_img.shape[:2]
    if h < 100 or w < 100:
        return []

    min_area = _env_float("PDF_LAYOUT_MIN_FIGURE_AREA_RATIO", 0.01)
    max_area = _env_float("PDF_LAYOUT_MAX_FIGURE_AREA_RATIO", 0.85)
    allowed_labels = get_layout_figure_labels()

    try:
        outputs = detector.predict(page_img, batch_size=1, layout_nms=True)
    except Exception as exc:
        logger.warning("LayoutDetection predict failed on page %s: %s", page_num + 1, exc)
        return []

    filenames: List[str] = []
    fig_idx = 0
    for result in outputs or []:
        for box_info in _iter_layout_boxes(result):
            label = str(box_info.get("label", "")).lower()
            if label not in allowed_labels:
                continue

            score = float(box_info.get("score") or 0.0)
            score_threshold = _env_float("PDF_LAYOUT_FIGURE_SCORE_THRESHOLD", 0.45)
            if score < score_threshold:
                continue

            normalized = _normalize_box(box_info.get("coordinate") or [], w, h)
            if not normalized:
                continue

            area_ratio = _box_area_ratio(normalized, w, h)
            if area_ratio < min_area or area_ratio > max_area:
                logger.debug(
                    "Skip layout box label=%s page=%s area_ratio=%.3f",
                    label,
                    page_num + 1,
                    area_ratio,
                )
                continue

            filename = f"{sanitized_title}_p{page_num}_fig{fig_idx}.png"
            out_path = os.path.join(app_images_path, filename)
            if _save_crop(page_img, normalized, out_path):
                filenames.append(filename)
                fig_idx += 1
                logger.info(
                    "Saved layout figure page=%s label=%s score=%.2f file=%s",
                    page_num + 1,
                    label,
                    score,
                    filename,
                )

    return filenames


def extract_heuristic_figures_from_page(
    page_img: np.ndarray,
    lines_with_boxes: List[Tuple[List, Tuple[str, float]]],
    sanitized_title: str,
    page_num: int,
    app_images_path: str,
    sanitize_text,
) -> List[str]:
    """Fallback: crop likely figure bands using OCR text masks (Phase 1 heuristic)."""
    if page_img is None or page_img.size == 0 or not app_images_path:
        return []

    h, w = page_img.shape[:2]
    if h < 100 or w < 100:
        return []

    row_has_text = np.zeros(h, dtype=bool)
    for box, (text, conf) in lines_with_boxes:
        cleaned = sanitize_text(text or "")
        if not cleaned:
            continue
        if conf is not None and conf < 0.45:
            continue
        pts = np.array(box, dtype=float)
        y0 = max(0, int(np.floor(pts[:, 1].min())))
        y1 = min(h, int(np.ceil(pts[:, 1].max())))
        if y1 > y0:
            row_has_text[y0:y1] = True

    gray = np.mean(page_img.astype(np.float32), axis=2)
    nonwhite = gray < 242

    min_gap_h = max(int(h * 0.06), 40)
    min_band_area_ratio = 0.02
    max_band_area_ratio = 0.65

    figures: List[str] = []
    in_gap = False
    gap_start = 0

    def finalize_band(start: int, end: int, out_index: int) -> Optional[str]:
        band_h = end - start
        if band_h < min_gap_h:
            return None
        band_nonwhite = nonwhite[start:end, :]
        if band_nonwhite.size == 0:
            return None

        density = float(band_nonwhite.mean())
        if density < 0.02:
            return None

        col_density = band_nonwhite.mean(axis=0)
        active_cols = np.where(col_density > 0.03)[0]
        if active_cols.size == 0:
            return None

        x0 = int(active_cols[0])
        x1 = int(active_cols[-1]) + 1
        crop_w = x1 - x0
        if crop_w < int(w * 0.2):
            return None

        area_ratio = float(crop_w * band_h) / float(w * h)
        if area_ratio < min_band_area_ratio or area_ratio > max_band_area_ratio:
            return None

        crop = page_img[start:end, x0:x1]
        if crop.size == 0:
            return None

        filename = f"{sanitized_title}_p{page_num}_scanfig{out_index}.png"
        out_path = os.path.join(app_images_path, filename)
        Image.fromarray(crop).save(out_path, format="PNG")
        return filename

    fig_idx = 0
    for y in range(h):
        gap_row = not row_has_text[y]
        if gap_row and not in_gap:
            in_gap = True
            gap_start = y
        elif not gap_row and in_gap:
            maybe = finalize_band(gap_start, y, fig_idx)
            if maybe:
                figures.append(maybe)
                fig_idx += 1
            in_gap = False

    if in_gap:
        maybe = finalize_band(gap_start, h, fig_idx)
        if maybe:
            figures.append(maybe)

    return figures


def extract_layout_figures_from_pdf_pages(
    pdf_bytes: bytes,
    sanitized_title: str,
    app_images_path: str,
    dpi: int = 200,
) -> List[List[str]]:
    """Render each PDF page and run layout-based figure extraction."""
    from pdf2image import convert_from_bytes as pdf2image_convert_from_bytes

    try:
        pil_images = pdf2image_convert_from_bytes(pdf_bytes, dpi=dpi)
    except Exception as exc:
        logger.warning("extract_layout_figures_from_pdf_pages render failed: %s", exc)
        return []

    per_page: List[List[str]] = []
    for page_num, pil_img in enumerate(pil_images):
        page_arr = np.array(pil_img)
        per_page.append(
            extract_layout_figures_from_page(
                page_img=page_arr,
                sanitized_title=sanitized_title,
                page_num=page_num,
                app_images_path=app_images_path,
            )
        )
    return per_page


def extract_scanned_page_figures(
    page_img: np.ndarray,
    lines_with_boxes: List[Tuple[List, Tuple[str, float]]],
    sanitized_title: str,
    page_num: int,
    app_images_path: str,
    sanitize_text,
) -> List[str]:
    """
    Extract figures from a scanned page bitmap.

    PDF_SCAN_FIGURE_ENGINE:
      - layout (default): PP-DocLayout detection only
      - heuristic: OCR-gap heuristic only
      - both: layout first, heuristic fallback when layout finds nothing
    """
    engine = os.getenv("PDF_SCAN_FIGURE_ENGINE", "layout").strip().lower()
    if engine == "mineru":
        logger.warning(
            "PDF_SCAN_FIGURE_ENGINE=mineru is invalid; MinerU is selected via "
            "PDF_EXTRACTION_BACKEND=mineru. Using 'layout' for figure crops."
        )
        engine = "layout"
    elif engine not in {"layout", "heuristic", "both"}:
        logger.warning("Unknown PDF_SCAN_FIGURE_ENGINE=%r; using 'layout'", engine)
        engine = "layout"

    layout_names: List[str] = []
    heuristic_names: List[str] = []

    if engine in {"layout", "both"}:
        layout_names = extract_layout_figures_from_page(
            page_img=page_img,
            sanitized_title=sanitized_title,
            page_num=page_num,
            app_images_path=app_images_path,
        )

    use_heuristic = engine == "heuristic" or (engine == "both" and not layout_names)
    if use_heuristic:
        heuristic_names = extract_heuristic_figures_from_page(
            page_img=page_img,
            lines_with_boxes=lines_with_boxes,
            sanitized_title=sanitized_title,
            page_num=page_num,
            app_images_path=app_images_path,
            sanitize_text=sanitize_text,
        )

    merged = list(dict.fromkeys([*layout_names, *heuristic_names]))
    return merged
