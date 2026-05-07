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

    def nodes_to_reading_guide_items(self, nodes: List[Dict[str, Any]]) -> List[ReadingGuideItem]:
        def convert(node: Dict[str, Any]) -> ReadingGuideItem:
            references = node.get("references", [])
            thought_process = [f"reference::{ref.get('text', '')}" for ref in references] or None
            children = [convert(child) for child in node.get("children", [])]
            return ReadingGuideItem(
                id=str(node["id"]),
                title=node["title"],
                takeaway=node.get("purpose"),
                purpose=node.get("purpose"),
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
