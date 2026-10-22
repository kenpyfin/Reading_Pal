"""Reader page splits. Keep in sync with frontend/src/utils/pageBoundaries.js."""

import logging
import re
from typing import Dict, List

logger = logging.getLogger(__name__)

# One screen is 3,000 characters. A page is at most two screens. Must match
# frontend/src/utils/pageBoundaries.js (MAX_PAGE_BUDGET).
PAGE_SCREEN_CHARS = 3000
PAGE_BUDGET_CHARS = PAGE_SCREEN_CHARS * 2
APPROX_CHARS_PER_PAGE_FOR_GUIDE = PAGE_BUDGET_CHARS
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)\n]+\)")

def _markdown_image_spans(markdown: str) -> List[tuple]:
    return [(match.start(), match.end()) for match in _MARKDOWN_IMAGE_RE.finditer(markdown or "")]


def _hard_page_end(
    markdown: str,
    page_start: int,
    budget_cap: int,
    image_cost: int,
    spans: List[tuple],
) -> int:
    """Exclusive end that stays within two screens. An image costs one screen."""
    total = len(markdown)
    budget = 0
    index = page_start
    span_at = 0
    while span_at < len(spans) and spans[span_at][1] <= page_start:
        span_at += 1
    while index < total:
        if span_at < len(spans) and spans[span_at][0] < index < spans[span_at][1]:
            index = spans[span_at][1]
            continue
        if span_at < len(spans) and spans[span_at][0] == index:
            cursor = index
            while cursor > page_start and markdown[cursor - 1].isspace():
                cursor -= 1
            slack_budget = budget - (index - cursor)
            if slack_budget + image_cost > budget_cap:
                return index
            budget = slack_budget + image_cost
            index = spans[span_at][1]
            span_at += 1
            continue
        if budget >= budget_cap:
            return index
        budget += 1
        index += 1
    return index


def _snap_page_end_to_heading(
    heading_offsets: List[int],
    page_start: int,
    proposed_end: int,
    target_chars_per_page: int,
    total_length: int,
    max_end: int,
) -> int:
    """Prefer a section heading inside the page. Never move past max_end."""
    window_lo = page_start + int(target_chars_per_page * 0.55)
    window_hi = min(max_end, total_length)
    if window_lo >= window_hi:
        return proposed_end
    candidates = [h for h in heading_offsets if page_start < h <= window_hi and h >= window_lo]
    if not candidates:
        return proposed_end
    return min(candidates, key=lambda h: (abs(h - proposed_end), h))


def _snap_back_to_whitespace(markdown: str, page_start: int, proposed_end: int) -> int:
    if proposed_end >= len(markdown) or proposed_end <= page_start:
        return proposed_end
    if markdown[proposed_end - 1].isspace():
        return proposed_end
    for index in range(proposed_end, page_start, -1):
        if markdown[index - 1].isspace():
            if index - page_start < max(1, (proposed_end - page_start) // 2) and (proposed_end - page_start) > 64:
                return proposed_end
            return index
    return proposed_end


def _end_before_open_fence(markdown: str, page_start: int, proposed_end: int) -> int:
    segment = markdown[page_start:proposed_end]
    if segment.count("```") % 2 == 0:
        return proposed_end
    last = segment.rfind("```")
    if last <= 0:
        return proposed_end
    return page_start + last


def _end_before_open_tag(markdown: str, page_start: int, proposed_end: int) -> int:
    segment = markdown[page_start:proposed_end]
    last_open = segment.rfind("<")
    last_close = segment.rfind(">")
    if last_open > last_close and last_open > 0:
        return page_start + last_open
    return proposed_end


def _leave_image_span(page_start: int, proposed_end: int, hard_end: int, spans: List[tuple]) -> int:
    for start, end in spans:
        if start >= page_start and start < proposed_end < end:
            if end <= hard_end:
                return end
            return start if start > page_start else hard_end
    return proposed_end


def _calculate_page_boundaries(markdown: str, target_chars_per_page: int) -> List[Dict[str, int]]:
    """
    Split markdown into pages of at most two screens.

    target_chars_per_page is the hard text budget (6,000 in the reader). Each
    markdown image costs half of that, one screen. A heading, code fence, or
    long word may move the break earlier and must not push past the budget.
    Mirrors frontend/src/utils/pageBoundaries.js.
    """
    if not markdown:
        logger.warning("[_calculate_page_boundaries] Markdown content is invalid or empty.")
        return []

    from backend.services.knowledge_mapper import KnowledgeMapper

    budget_cap = target_chars_per_page if target_chars_per_page > 0 else PAGE_BUDGET_CHARS
    image_cost = max(1, budget_cap // 2)
    heading_offsets = KnowledgeMapper().heading_start_offsets(markdown)
    spans = _markdown_image_spans(markdown)
    boundaries = []
    current_offset = 0
    total_length = len(markdown)

    while current_offset < total_length:
        page_start = current_offset
        hard_end = _hard_page_end(markdown, page_start, budget_cap, image_cost, spans)
        actual_end = hard_end

        if hard_end < total_length:
            ends_on_image = any(end == hard_end and start >= page_start for start, end in spans)
            heading_end = _snap_page_end_to_heading(
                heading_offsets,
                page_start,
                hard_end,
                budget_cap,
                total_length,
                hard_end,
            )
            if heading_end != hard_end and page_start < heading_end <= hard_end:
                actual_end = heading_end
            elif not ends_on_image:
                actual_end = _snap_back_to_whitespace(markdown, page_start, hard_end)
            actual_end = _end_before_open_fence(markdown, page_start, actual_end)
            actual_end = _end_before_open_tag(markdown, page_start, actual_end)
            actual_end = _leave_image_span(page_start, actual_end, hard_end, spans)

        if actual_end <= page_start:
            logger.warning(
                f"[_calculate_page_boundaries] actual_end ({actual_end}) did not advance from page_start ({page_start}). Forcing advance."
            )
            actual_end = hard_end if hard_end > page_start else min(total_length, page_start + 1)
        if hard_end > page_start and actual_end > hard_end:
            actual_end = hard_end
        actual_end = min(actual_end, total_length)

        boundaries.append({"start": page_start, "end": actual_end})
        current_offset = actual_end

        if len(boundaries) > 10000:
            logger.error("[_calculate_page_boundaries] Exceeded 10000 page boundaries, breaking loop.")
            break

    logger.info(f"[_calculate_page_boundaries] Calculated {len(boundaries)} pages.")
    return boundaries


