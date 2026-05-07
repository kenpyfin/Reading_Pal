import re
import json
from typing import List, Dict, Any

def extract_references(markdown_text: str) -> List[Dict[str, Any]]:
    """
    Scans for internal references and key terms.
    Technique 3: Cross-Link & Backlink Mapping
    """
    # Regex for common internal references
    ref_patterns = [
        r"\[\[(.*?)\]\]", # Wiki links
        r"(?:[Ss]ee|[Rr]efer to)\s+(?:[Ss]ection|[Cc]hapter|[Pp]age)\s+(\d+(?:\.\d+)*)", # Section/Page refs
        r"Figure\s+(\d+(?:\.\d+)*)", # Figure refs
        r"Table\s+(\d+(?:\.\d+)*)" # Table refs
    ]
    
    refs = []
    for pattern in ref_patterns:
        for match in re.finditer(pattern, markdown_text):
            refs.append({
                "type": "internal_link",
                "text": match.group(0),
                "target": match.group(1),
                "offset": match.start()
            })
    return refs

def extract_knowledge_map(markdown_text: str) -> List[Dict[str, Any]]:
    """
    Parses markdown text into a hierarchical knowledge map.
    Technique 1: Hierarchical Heading Indexing
    Technique 2: Directory & Metadata Graph (Signposts)
    Technique 3: Cross-Link & Backlink Mapping (Network)
    """
    heading_re = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)
    
    # Find all headings with their offsets
    headings = []
    for match in heading_re.finditer(markdown_text):
        level = len(match.group(1))
        title = match.group(2).strip()
        start_offset = match.start()
        headings.append({
            "level": level,
            "title": title,
            "start_offset": start_offset,
        })
    
    if not headings:
        return []

    # Assign end_offsets
    for i in range(len(headings)):
        if i + 1 < len(headings):
            headings[i]["end_offset"] = headings[i + 1]["start_offset"]
        else:
            headings[i]["end_offset"] = len(markdown_text)
            
    # Build hierarchy and Map references to nodes
    all_refs = extract_references(markdown_text)
    
    root = []
    stack = []
    
    for h in headings:
        node = {
            "title": h["title"],
            "level": h["level"],
            "start_offset": h["start_offset"],
            "end_offset": h["end_offset"],
            "children": [],
            "references": [],
            "hub_score": 0,
            "purpose": "" 
        }
        
        # Technique 2: Extract "Signpost" snippet
        content = markdown_text[h["start_offset"]:h["end_offset"]].strip()
        lines = content.split('\n')
        if lines:
            content_lines = [l for l in lines[1:] if l.strip() and not l.strip().startswith('#')]
            node["snippet"] = " ".join(content_lines[:3])[:200]
        
        # Technique 3: Map references that fall within this node
        for ref in all_refs:
            if h["start_offset"] <= ref["offset"] < h["end_offset"]:
                node["references"].append(ref)
                node["hub_score"] += 1
        
        while stack and stack[-1]["level"] >= node["level"]:
            stack.pop()
            
        if not stack:
            root.append(node)
        else:
            stack[-1]["children"].append(node)
            
        stack.append(node)
        
    return root

# Example usage with dummy markdown
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
