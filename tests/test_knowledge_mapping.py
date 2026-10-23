from bson import ObjectId
import pytest

from backend.api import books as books_api
from backend.models.reading_guide import ReadingGuideItem
from backend.services.knowledge_mapper import KnowledgeMapper


SAMPLE_MARKDOWN = """
# Intro
Welcome to the book.
See Section 2.

## Foundations
This chapter sets context.
Refer to Chapter 3.

### Deep Dive
Details and examples.
Figure 4.1 shows the flow.
"""


def test_knowledge_mapper_builds_hierarchy():
    mapper = KnowledgeMapper()
    tree = mapper.extract_knowledge_map(SAMPLE_MARKDOWN)

    assert len(tree) == 1
    assert tree[0]["title"] == "Intro"
    assert len(tree[0]["children"]) == 1
    assert tree[0]["children"][0]["title"] == "Foundations"
    assert len(tree[0]["children"][0]["children"]) == 1
    assert tree[0]["children"][0]["children"][0]["title"] == "Deep Dive"


def test_knowledge_mapper_hub_score_for_internal_references():
    mapper = KnowledgeMapper()
    items = mapper.to_reading_guide_items(SAMPLE_MARKDOWN)

    assert items[0].hub_score > 0
    assert items[0].children[0].hub_score > 0
    assert items[0].children[0].children[0].hub_score > 0


def test_prompt_controls_leave_standard_depth_unchanged_and_do_not_cap_high_fidelity():
    from backend.services.llm_service import LLMService

    standard = LLMService._prompt_controls_block("standard", "balanced", for_segmentation=True)
    omitted = LLMService._prompt_controls_block(None, None, for_segmentation=True)
    assert standard == ""
    assert omitted == ""

    compact = LLMService._prompt_controls_block("compact", "balanced", for_segmentation=True)
    assert "4\u20136 pillars" in compact

    detailed = LLMService._prompt_controls_block("high_fidelity", "takeaways", for_segmentation=True)
    assert "Do not impose a small fixed pillar cap" in detailed
    assert "8\u201312" not in detailed

    cards = LLMService._prompt_controls_block("compact", "author_craft", for_segmentation=False)
    assert "Author craft" in cards
    assert "purpose 1 sentence" in cards


def test_normalize_semantic_segments_preserves_pillars_and_fills_gaps():
    """Architect path: partial LLM pillars keep semantic grouping; omitted headings get gap segments in order."""
    mapper = KnowledgeMapper()
    nodes = [
        {"id": "km-1", "level": 1, "title": "A", "start_offset": 0, "end_offset": 10, "snippet": "", "hub_score": 0},
        {"id": "km-2", "level": 1, "title": "B", "start_offset": 10, "end_offset": 20, "snippet": "", "hub_score": 0},
        {"id": "km-3", "level": 1, "title": "C", "start_offset": 20, "end_offset": 30, "snippet": "", "hub_score": 0},
    ]
    raw = [
        {
            "id": "p1",
            "title": "Setup",
            "is_book_content": True,
            "source_section_ids": ["km-1", "km-2"],
            "why": "A and B open the arc.",
        }
    ]
    out = mapper.normalize_semantic_segments(nodes, raw)
    assert len(out) == 2
    assert out[0]["source_section_ids"] == ["km-1", "km-2"]
    assert out[0].get("why") == "A and B open the arc."
    assert out[1]["id"] == "km-3-arch-gap"
    assert out[1]["source_section_ids"] == ["km-3"]


@pytest.mark.asyncio
async def test_api_generate_whole_book_reading_guide_returns_items(monkeypatch):
    fake_book_id = ObjectId()
    fake_user_id = "user-1"

    async def fake_get_book(book_id: str, user_id: str):
        assert book_id == str(fake_book_id)
        assert user_id == fake_user_id
        return {
            "_id": fake_book_id,
            "user_id": fake_user_id,
            "title": "Sample Book",
            "status": "completed",
            "markdown_filename": "sample.md",
            "image_filenames": [],
            "original_filename": "sample.pdf",
            "job_id": "job-1",
            "sanitized_title": "sample_book",
        }

    async def fake_run_in_threadpool(func, *args, **kwargs):
        return "# Chapter One\nSome text.\n## Chapter Two\nMore text."

    async def fake_generate_roadmap(markdown_text: str, **kwargs):
        assert "Chapter One" in markdown_text
        return [
            ReadingGuideItem(
                id="km-1",
                title="Chapter One",
                takeaway="Start here",
                purpose="Set the foundation",
                hub_score=1,
                start_offset=0,
                end_offset=20,
                level=1,
                preview_text="Some text",
                children=[],
            )
        ]

    async def fake_get_reading_guide_by_id(book_id: str, user_id: str, guide_id: str):
        return None

    async def fake_create_reading_guide(book_id: str, user_id: str, guide_id: str, name: str, items, **kwargs):
        from backend.models.reading_guide import ReadingGuideInDB, ReadingGuideItem

        return ReadingGuideInDB.model_validate({
            "_id": ObjectId(),
            "book_id": ObjectId(book_id),
            "user_id": user_id,
            "guide_id": guide_id,
            "name": name,
            "items": [ReadingGuideItem.model_validate(i) for i in items],
        })

    monkeypatch.setattr(books_api, "get_book", fake_get_book)
    monkeypatch.setattr(books_api, "run_in_threadpool", fake_run_in_threadpool)
    monkeypatch.setattr(books_api.llm_service, "generate_roadmap", fake_generate_roadmap)
    monkeypatch.setattr(books_api, "get_reading_guide_by_id", fake_get_reading_guide_by_id)
    monkeypatch.setattr(books_api, "create_reading_guide", fake_create_reading_guide)
    monkeypatch.setattr(books_api, "CONTAINER_MARKDOWN_PATH", "/tmp")

    result = await books_api.generate_whole_book_reading_guide(
        book_id=str(fake_book_id),
        current_user_id=fake_user_id,
    )

    assert result["items"]
    assert result["items"][0]["title"] == "Chapter One"
    assert result["items"][0]["hub_score"] == 1
    assert result["items"][0]["purpose"] == "Set the foundation"


def test_plain_chapter_lines_become_sections():
    mapper = KnowledgeMapper()
    markdown = (
        "# The Book\n"
        "A short opening that is long enough to keep.\n\n"
        "Chapter 1\n"
        "Never outshine the master in front of the court.\n\n"
        "Chapter 2\n"
        "Always say less than necessary when you answer.\n"
    )
    titles = [node["title"] for node in mapper.flatten_document_sections_for_roadmap(markdown)]
    assert "Chapter 1" in titles
    assert "Chapter 2" in titles
    assert mapper._structural_title_level("Chapter 1 shows why this sentence is prose.") is None


def test_page_boundary_starts_on_chapter_line():
    from backend.services.page_boundaries import _calculate_page_boundaries

    body = "word " * 1000
    markdown = body + "\nChapter 2\n" + ("tail " * 400)
    chapter_at = markdown.index("Chapter 2")
    boundaries = _calculate_page_boundaries(markdown, 6000)
    assert boundaries[0]["start"] == 0
    assert boundaries[-1]["end"] == len(markdown)
    assert any(boundary["start"] == chapter_at for boundary in boundaries)


def test_prompt_override_blank_uses_default_and_custom_is_stored():
    from backend.services.prompt_defaults import (
        DEFAULT_GUIDE_FORMAT_PROMPT,
        DEFAULT_GUIDE_GENERATION_PROMPT,
        resolve_prompt,
        stored_prompt_value,
    )

    assert resolve_prompt("  ", DEFAULT_GUIDE_GENERATION_PROMPT) == DEFAULT_GUIDE_GENERATION_PROMPT
    assert resolve_prompt(DEFAULT_GUIDE_FORMAT_PROMPT, DEFAULT_GUIDE_FORMAT_PROMPT) == DEFAULT_GUIDE_FORMAT_PROMPT
    assert stored_prompt_value(DEFAULT_GUIDE_GENERATION_PROMPT, DEFAULT_GUIDE_GENERATION_PROMPT) is None
    assert stored_prompt_value("Use fewer pillars.", DEFAULT_GUIDE_GENERATION_PROMPT) == "Use fewer pillars."
