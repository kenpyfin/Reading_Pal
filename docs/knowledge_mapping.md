# Knowledge Mapping & Fragment Filtering

This document describes the implementation logic for semantic book mapping and the multi-layer filtering strategy used to eliminate "bad" titles and non-substantive fragments (e.g., layout artifacts like "The", "One", or "Page 1").

## The Problem: Fragment Hallucination

When processing complex or poorly parsed PDFs, layout fragments often appear as high-level headings. If the LLM (acting as a "Structural Architect") is forced to find meaning in every heading, it may hallucinate deep philosophical significance for single words or metadata, leading to a confusing and noisy reading guide.

## Multi-Layer Filtering Strategy

To solve this, we employ a four-layer defense strategy.

### 1. Layer 1: Substance Gate (Hard Heuristics)

Implemented in `backend/services/knowledge_mapper.py`, the `flatten_document_sections_for_roadmap` method applies strict size and content heuristics before sections are sent to the LLM.

- **Heuristic A**: If a title is $\le$ 3 characters (e.g., "The", "A", "One") and its associated content is less than 50 characters, it is discarded.
- **Heuristic B**: If a title is $\le$ 10 characters and content is less than 10 characters, it is discarded.
- **Structural Whitelist**: Keywords like `Chapter`, `Part`, `Section`, `Preface`, `Introduction`, `Appendix`, and `Index` (or Roman numerals/digits) are whitelisted to ensure structural containers are preserved even if they are empty.

### 2. Layer 2: Metadata Skip-List

We maintain an expanded list of "noise" tokens that identify boilerplate front-matter and back-matter. Sections containing these tokens in the title or opening snippet are automatically filtered out.

**Included tokens:**
- `copyright`, `all rights reserved`, `isbn`, `published by`
- `table of contents`, `title page`
- `about the author`, `praise for`, `also by`, `dedication`

### 3. Layer 3: Architectural Discard (LLM Instruction)

During the **Architect Pass** (where the LLM clusters headings into pillars), the system prompt includes explicit instructions to identify and discard "Parse Noise".

> "Discard 'Parse Noise'. If a section contains only a single word, layout fragment, metadata, or boilerplate, mark its `is_book_content` as false or simply omit its ID from any pillar. Do not try to find deep meaning in layout artifacts."

If a model marks a segment as `is_book_content: false`, it is dropped from the final roadmap.

### 4. Layer 4: Mentor Hallucination Guard

During the **Mentor Pass** (where the LLM generates the "Guide Card" for a pillar), the prompt instructs the model to be honest about thin content.

> "If the source text is non-substantive or purely metadata that slipped through filtering, do not hallucinate a deep meaning; instead, provide a very brief, honest description or leave the fields empty."

This ensures that if a fragment does slip through the previous layers, the resulting card is either empty or clearly identified as non-substantive, rather than being filled with "hallucinated depth."

## Implementation Details

- **Backend Logic**: `backend/services/knowledge_mapper.py`
- **LLM Prompts**: `backend/services/llm_service.py` (`_build_semantic_reading_guide_items`)
- **Models**: `backend/models/reading_guide.py` (ReadingGuideItem)
