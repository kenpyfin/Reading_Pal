import json
import re
from typing import Any, Dict, List, Optional

from backend.models.reading_guide import ReadingGuideItem


class KnowledgeMapper:
    """
    Extracts a heading hierarchy from markdown and maps references to each node.
    It can also convert nodes to ReadingGuideItem models.
    """

    _heading_re = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)
    _ref_patterns = [
        r"\[\[(.*?)\]\]",  # Wiki links
        r"(?:[Ss]ee|[Rr]efer to)\s+(?:[Ss]ection|[Cc]hapter|[Pp]age)\s+(\d+(?:\.\d+)*)",
        r"Figure\s+(\d+(?:\.\d+)*)",
        r"Table\s+(\d+(?:\.\d+)*)",
    ]

    def extract_references(self, markdown_text: str) -> List[Dict[str, Any]]:
        refs: List[Dict[str, Any]] = []
        for pattern in self._ref_patterns:
            for match in re.finditer(pattern, markdown_text):
                refs.append(
                    {
                        "type": "internal_link",
                        "text": match.group(0),
                        "target": match.group(1),
                        "offset": match.start(),
                    }
                )
        return refs

    def _snippet_from_content(self, content: str) -> str:
        lines = content.split("\n")
        content_lines = [line.strip() for line in lines[1:] if line.strip() and not line.strip().startswith("#")]
        return " ".join(content_lines[:3])[:220]

    def extract_knowledge_map(self, markdown_text: str) -> List[Dict[str, Any]]:
        headings: List[Dict[str, Any]] = []
        for match in self._heading_re.finditer(markdown_text):
            headings.append(
                {
                    "level": len(match.group(1)),
                    "title": match.group(2).strip(),
                    "start_offset": match.start(),
                }
            )
        if not headings:
            return []

        for idx, heading in enumerate(headings):
            heading["end_offset"] = headings[idx + 1]["start_offset"] if idx + 1 < len(headings) else len(markdown_text)

        all_refs = self.extract_references(markdown_text)
        roots: List[Dict[str, Any]] = []
        stack: List[Dict[str, Any]] = []
        node_counter = 1

        for heading in headings:
            content = markdown_text[heading["start_offset"] : heading["end_offset"]].strip()
            references = [
                ref
                for ref in all_refs
                if heading["start_offset"] <= ref["offset"] < heading["end_offset"]
            ]
            node = {
                "id": f"km-{node_counter}",
                "title": heading["title"],
                "level": heading["level"],
                "start_offset": heading["start_offset"],
                "end_offset": heading["end_offset"],
                "children": [],
                "references": references,
                "hub_score": len(references),
                "purpose": None,
                "snippet": self._snippet_from_content(content),
            }
            node_counter += 1

            while stack and stack[-1]["level"] >= node["level"]:
                stack.pop()
            if stack:
                stack[-1]["children"].append(node)
            else:
                roots.append(node)
            stack.append(node)
        return roots

    def _flatten_nodes(self, nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        flattened: List[Dict[str, Any]] = []
        for node in nodes:
            flattened.append(node)
            flattened.extend(self._flatten_nodes(node.get("children", [])))
        return flattened

    def apply_purposes(self, nodes: List[Dict[str, Any]], purposes_by_id: Dict[str, str]) -> None:
        for node in self._flatten_nodes(nodes):
            node_id = node.get("id")
            purpose = purposes_by_id.get(node_id) if node_id else None
            if purpose:
                node["purpose"] = purpose.strip()

    _skip_section_tokens = (
        "copyright",
        "all rights reserved",
        "isbn",
        "published by",
        "table of contents",
        "contents",
        "title page",
        "about the author",
        "praise for",
        "also by",
        "dedication",
        "acknowledgements",
        "acknowledgments",
        "bibliography",
        "works cited",
        "list of figures",
        "list of tables",
        "list of illustrations",
        "notes",
        "endnotes",
        "footnotes",
        "publisher",
        "imprint",
        "printed in",
        "first edition",
    )

    # Substance gate + LLM thin-segment checks: keep in sync with flatten_document_sections_for_roadmap.
    STRUCTURAL_KEYWORDS = frozenset(
        {
            "chapter",
            "part",
            "section",
            "book",
            "volume",
            "preface",
            "introduction",
            "foreword",
            "appendix",
            "index",
            "prologue",
            "epilogue",
            "afterword",
        }
    )

    _trailing_page_indicator_re = re.compile(
        r"(?i)\s+(page|pg\.?|p\.)\s*\d+(\s*[-–]\s*\d+)?\s*$"
    )
    _trailing_segment_label_re = re.compile(
        r"(?i)\s+(segment|section|sect\.?|ch\.?|chapter)\s+\d+\s*$"
    )
    _trailing_digits_re = re.compile(r"\s+\d+\s*$")

    @classmethod
    def _canonical_title_for_frequency(cls, title: str) -> str:
        """
        Normalize headings so repeated page headers/footers and numbered variants
        (e.g. 'Segment 12', 'Chapter 3') bucket together for repetition detection.
        """
        t = " ".join((title or "").split()).strip()
        if not t:
            return ""
        t = cls._trailing_page_indicator_re.sub("", t)
        t = cls._trailing_segment_label_re.sub("", t)
        t = cls._trailing_digits_re.sub("", t)
        t = " ".join(t.split()).strip()
        return t.casefold()

    @classmethod
    def is_structural_heading(cls, title: str) -> bool:
        """True if the heading looks like real document structure (chapter, part, …)."""
        t = (title or "").strip()
        if not t:
            return False
        if re.match(r"^[IVXLCDM\d\.]+$", t):
            return True
        tokens = set(re.findall(r"[a-z]+", t.lower()))
        return bool(tokens & cls.STRUCTURAL_KEYWORDS)

    def flatten_document_sections_for_roadmap(self, markdown_text: str) -> List[Dict[str, Any]]:
        """
        Flat heading-aligned sections in reading order for semantic segmentation.
        Skips common front-matter / boilerplate blocks using the same heuristic as the API.
        Also filters out non-substantive fragments (very short titles with minimal content)
        and repetitive layout artifacts (page headers/footers).
        """
        roots = self.extract_knowledge_map(markdown_text or "")
        if not roots:
            return []
        flat = self._flatten_nodes(roots)

        # Frequency analysis: identify repetitive titles (likely page headers/footers)
        title_counts: Dict[str, int] = {}
        for node in flat:
            title = str(node.get("title", "")).strip()
            if not title:
                continue
            key = self._canonical_title_for_frequency(title)
            if not key:
                continue
            title_counts[key] = title_counts.get(key, 0) + 1

        repetitive_canonical = {k for k, c in title_counts.items() if c > 3}

        out: List[Dict[str, Any]] = []
        for node in flat:
            start = int(node["start_offset"])
            end = int(node["end_offset"])
            title = str(node.get("title", "")).strip()
            content = (markdown_text or "")[start:end]

            # Substantive check: Skip if title is tiny/fragmented and content is effectively empty
            # (e.g. single words like "The", "One", "A" that are often layout artifacts)
            # But keep structural headings (Chapter 1, Preface, etc.) even if they have no direct content.
            clean_content = re.sub(r"[#\s*_\-\[\]\(\)]+", "", content[len(title) + 1 :])
            title_len = len(title)
            content_len = len(clean_content)

            is_structural = self.is_structural_heading(title)

            if not is_structural:
                canon = self._canonical_title_for_frequency(title)
                if canon and canon in repetitive_canonical:
                    continue
                # Substance gate: skip very shallow fragments (unless structural)
                if content_len < 40:
                    continue
                # Skip if title is tiny and content is almost non-existent
                if (title_len <= 3 and content_len < 20) or (title_len <= 10 and content_len < 5):
                    continue
                # Skip numeric-only or "Segment X" titles if they have no content
                if re.match(r"^(Segment|Page|Section)?\s*\d+$", title, re.I) and content_len < 50:
                    continue

            low = f"{title}\n{content[:500]}".lower()
            if any(tok in low for tok in self._skip_section_tokens):
                continue
            out.append(
                {
                    "id": node["id"],
                    "level": int(node.get("level", 1)),
                    "title": title,
                    "start_offset": start,
                    "end_offset": end,
                    "snippet": content[:700],
                    "hub_score": int(node.get("hub_score", 0)),
                }
            )
        return out

    def normalize_semantic_segments(
        self,
        heading_nodes: List[Dict[str, Any]],
        raw_segments: Optional[List[Dict[str, Any]]],
    ) -> List[Dict[str, Any]]:
        """
        Turn LLM segmentation output into validated segment specs (ordered pillar list).
        Falls back to one segment per heading when the model returns nothing usable.
        """
        if not heading_nodes:
            return []

        id_to_node = {n["id"]: n for n in heading_nodes}
        if not raw_segments:
            return [
                {
                    "id": f"seg{i + 1}",
                    "title": n.get("title", f"Section {i + 1}"),
                    "source_section_ids": [n["id"]],
                    "why": "",
                }
                for i, n in enumerate(heading_nodes)
            ]

        valid_segments: List[Dict[str, Any]] = []
        rejected_ids = set()
        for i, seg in enumerate(raw_segments):
            if not isinstance(seg, dict):
                continue
            source_ids = [sid for sid in (seg.get("source_section_ids") or []) if sid in id_to_node]
            if not source_ids:
                continue
            if seg.get("is_book_content") is False:
                rejected_ids.update(source_ids)
                continue
            base_id = seg.get("id") or f"seg{i + 1}"
            base_title = seg.get("title") or f"Segment {i + 1}"
            why_raw = seg.get("why")
            why_text = str(why_raw).strip() if why_raw else ""
            if len(source_ids) > 8:
                total_parts = (len(source_ids) + 5) // 6
                for j in range(0, len(source_ids), 6):
                    chunk = source_ids[j : j + 6]
                    part = j // 6 + 1
                    part_why = why_text
                    if total_parts > 1:
                        part_why = f"{why_text} (part {part}/{total_parts})".strip() if why_text else f"Part {part}/{total_parts} of pillar."
                    valid_segments.append(
                        {
                            "id": f"{base_id}.p{part}",
                            "title": base_title,
                            "source_section_ids": chunk,
                            "why": part_why,
                        }
                    )
            else:
                valid_segments.append(
                    {
                        "id": base_id,
                        "title": base_title,
                        "source_section_ids": source_ids,
                        "why": why_text,
                    }
                )

        if not valid_segments:
            return [
                {
                    "id": f"seg{i + 1}",
                    "title": n.get("title", f"Section {i + 1}"),
                    "source_section_ids": [n["id"]],
                    "why": "",
                }
                for i, n in enumerate(heading_nodes)
            ]

        used_ids = set()
        for vs in valid_segments:
            for sid in vs.get("source_section_ids") or []:
                used_ids.add(sid)

        gap_segments: List[Dict[str, Any]] = []
        for n in heading_nodes:
            nid = n["id"]
            if nid in used_ids or nid in rejected_ids:
                continue
            gap_segments.append(
                {
                    "id": f"{nid}-arch-gap",
                    "title": n.get("title", "Section"),
                    "source_section_ids": [nid],
                    "why": "Section not covered by the model's pillars; preserved in document order.",
                }
            )

        def _segment_sort_key(spec: Dict[str, Any]) -> int:
            ids = spec.get("source_section_ids") or []
            offsets = [int(id_to_node[s]["start_offset"]) for s in ids if s in id_to_node]
            return min(offsets) if offsets else 0

        merged = valid_segments + gap_segments
        merged.sort(key=_segment_sort_key)
        return merged

    def nodes_to_reading_guide_items(self, nodes: List[Dict[str, Any]]) -> List[ReadingGuideItem]:
        def convert(node: Dict[str, Any]) -> ReadingGuideItem:
            references = node.get("references", [])
            thought_process = [f"reference::{ref.get('text', '')}" for ref in references] or None
            children = [convert(child) for child in node.get("children", [])]
            return ReadingGuideItem(
                id=str(node["id"]),
                title=node["title"],
                purpose=node.get("purpose"),
                takeaway=node.get("takeaway"),
                reading_summary=node.get("reading_summary"),
                reading_bullets=node.get("reading_bullets"),
                thought_process=thought_process,
                start_offset=node["start_offset"],
                end_offset=node["end_offset"],
                level=node["level"],
                preview_text=node.get("snippet"),
                hub_score=int(node.get("hub_score", 0)),
                children=children or [],
            )

        return [convert(node) for node in nodes]

    def to_reading_guide_items(self, markdown_text: str) -> List[ReadingGuideItem]:
        return self.nodes_to_reading_guide_items(self.extract_knowledge_map(markdown_text))


_default_mapper = KnowledgeMapper()


def extract_references(markdown_text: str) -> List[Dict[str, Any]]:
    return _default_mapper.extract_references(markdown_text)


def extract_knowledge_map(markdown_text: str) -> List[Dict[str, Any]]:
    return _default_mapper.extract_knowledge_map(markdown_text)


if __name__ == "__main__":
    dummy_md = """
# Introduction
Welcome to the project. This is a signpost.
## Background
We started in 2020.
## Objectives
- Do X
- Do Y
# Technical Specs
## Backend
Built with FastAPI.
### Database
Uses MongoDB.
## Frontend
Built with React.
    """
    k_map = extract_knowledge_map(dummy_md)
    print(json.dumps(k_map, indent=2))
