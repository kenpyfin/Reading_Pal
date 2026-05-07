from datetime import datetime
from typing import Optional, Any, List, Dict

from bson import ObjectId
from pydantic import BaseModel, Field

# Assuming PyObjectId is in user.py or a common place.
# If it's in a different location, adjust the import path.
# For this example, let's assume it might be in a common models utility
# or directly use a validation approach if PyObjectId is not easily accessible.
# For now, let's assume a common ObjectId validator or Pydantic's built-in capabilities.

class PyObjectId(ObjectId):
    @classmethod
    def __get_validators__(cls):
        yield cls.validate

    @classmethod
    def validate(cls, v: Any) -> ObjectId:
        if isinstance(v, ObjectId):
            return v
        if ObjectId.is_valid(v):
            return ObjectId(v)
        raise ValueError("Invalid ObjectId")

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        from pydantic_core import core_schema
        return core_schema.json_or_python_schema(
            json_schema=core_schema.str_schema(
                min_length=24,
                max_length=24,
                pattern="^[0-9a-fA-F]{24}$"
            ),
            python_schema=core_schema.union_schema([
                core_schema.is_instance_schema(ObjectId),
                core_schema.chain_schema([
                    core_schema.str_schema(),
                    core_schema.no_info_plain_validator_function(cls.validate),
                ])
            ]),
            serialization=core_schema.plain_serializer_function_ser_schema(lambda x: str(x)),
        )

class TextLink(BaseModel):
    """Represents a link to original text with enhanced context for fast navigation."""
    start_offset: int = Field(..., description="Global character offset in original markdown where this link starts")
    end_offset: int = Field(..., description="Global character offset in original markdown where this link ends")
    preview_text: str = Field(..., description="100-200 character preview of original text for quick reference")
    context_before: Optional[str] = Field(None, description="50 characters of text before the link for context")
    context_after: Optional[str] = Field(None, description="50 characters of text after the link for context")


class ReadingGuideItem(BaseModel):
    """A single item in the whole-book reading roadmap (tree node)."""
    id: str = Field(..., description="Unique ID for progress tracking (UUID or slug)")
    title: str = Field(..., description="Section title from document")
    takeaway: Optional[str] = Field(None, description="Short description or key takeaway from LLM")
    thought_process: Optional[List[str]] = Field(None, description="Reasoning steps for understanding this section")
    alternative_reading: Optional[str] = Field(
        None,
        description="Short rewrite in the source author's style to help quick comprehension",
    )
    alternative_source_word_count: Optional[int] = Field(
        None,
        description="Word count of the source excerpt used to generate Author Shortcut",
    )
    alternative_word_count: Optional[int] = Field(
        None,
        description="Word count of the generated Author Shortcut text",
    )
    outsider_guide: Optional[str] = Field(
        None,
        description="Beginner-oriented rewrite in the source author's style for topic outsiders",
    )
    outsider_source_word_count: Optional[int] = Field(
        None,
        description="Word count of the source excerpt used to generate Outsider Guide",
    )
    outsider_word_count: Optional[int] = Field(
        None,
        description="Word count of the generated Outsider Guide text",
    )
    reading_summary: Optional[str] = Field(None, description="Quick 1-2 sentence absorption summary for this section")
    reading_bullets: Optional[List[str]] = Field(None, description="Short bullet points for quick reading absorption")
    start_offset: int = Field(..., description="Character offset in original markdown where this section starts")
    end_offset: int = Field(..., description="Character offset in original markdown where this section ends")
    level: int = Field(..., description="Heading level: 1=part, 2=chapter, 3=section, etc.")
    children: Optional[List["ReadingGuideItem"]] = Field(None, description="Nested items for mindmap hierarchy")
    preview_text: Optional[str] = Field(None, description="Actual book excerpt for search/highlight (from source content)")
    key_term: Optional[str] = Field(None, description="Key term for focused highlight (e.g. from critical_definitions)")
    enriched: Optional[bool] = Field(False, description="True if this item has been enriched with grounded sub-points")
    key_quote: Optional[str] = Field(None, description="Direct quote or paraphrase from source text (for enriched sub-points)")
    graph_image_url: Optional[str] = Field(None, description="Signed URL to generated concept graph image")
    graph_status: Optional[str] = Field(None, description="Graph generation status: idle|generating|ready|failed")
    graph_prompt: Optional[str] = Field(None, description="Prompt used to generate concept graph")
    hub_score: Optional[int] = Field(0, description="Cross-reference count that marks this section as a knowledge hub")
    purpose: Optional[str] = Field(None, description="Signpost sentence for why this section matters")


class ReadingGuide(BaseModel):
    """Whole-book reading roadmap generated from document structure + LLM enrichment."""
    book_id: PyObjectId = Field(alias="book_id")
    user_id: str = Field(...)
    items: List[ReadingGuideItem] = Field(default_factory=list, description="Root-level items (tree)")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    enriched: Optional[bool] = Field(False, description="True if all top-level items have been enriched with grounded sub-points")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class ReadingGuideInDB(ReadingGuide):
    """ReadingGuide as stored in MongoDB with _id."""
    id: PyObjectId = Field(default_factory=PyObjectId, alias="_id")


class ReadingGuideProgressUpdate(BaseModel):
    """Request body for toggling item completion."""
    item_id: str = Field(..., description="ID of the roadmap item")
    completed: bool = Field(..., description="True to mark as read, False to unmark")


# Resolve forward reference for ReadingGuideItem children
ReadingGuideItem.model_rebuild()


class KeyConcept(BaseModel):
    """Represents a key concept or main idea with links to original text."""
    concept: str = Field(..., description="The key concept or main idea")
    explanation: str = Field(..., description="Explanation of the concept")
    importance_level: str = Field(..., description="Importance level: 'critical', 'important', or 'supporting'")
    source_links: List[TextLink] = Field(..., description="Links to original text where this concept is discussed (can have multiple if concept appears multiple times)")

class VocabularyItem(BaseModel):
    """Represents vocabulary terms with definitions and links to original text."""
    term: str = Field(..., description="The vocabulary term")
    definition: str = Field(..., description="Definition of the term")
    context_sentence: str = Field(..., description="Example sentence showing term usage")
    difficulty_level: Optional[str] = Field(None, description="Difficulty level: 'basic', 'intermediate', or 'advanced'")
    source_link: TextLink = Field(..., description="Link to original text where term appears")
    usage_links: Optional[List[TextLink]] = Field(None, description="Links to other occurrences of the term")

class ComprehensionQuestion(BaseModel):
    """Represents a comprehension question with links to original text."""
    question: str = Field(..., description="The comprehension question")
    question_type: str = Field(..., description="Question type: 'recall', 'analysis', 'synthesis', or 'evaluation'")
    suggested_answer: Optional[str] = Field(None, description="Suggested answer to the question")
    answer_source_link: TextLink = Field(..., description="Link to original text that answers the question")
    related_links: Optional[List[TextLink]] = Field(None, description="Links to related passages that provide context")

class ReadingGuideSection(BaseModel):
    """Represents a single section in a structured reading guide with enhanced linking."""
    section_title: str = Field(..., description="Header matching original document structure")
    rewritten_content: str = Field(..., description="Condensed/rewritten version of the section")
    key_takeaway: Optional[str] = Field(None, description="One-sentence main idea for quick absorption")
    original_start_offset: int = Field(..., description="Character offset in original markdown where this section starts (legacy, use primary_link instead)")
    original_end_offset: int = Field(..., description="Character offset in original markdown where this section ends (legacy, use primary_link instead)")
    original_text_preview: Optional[str] = Field(None, description="Short preview of original text for reference (legacy, use primary_link instead)")
    # Enhanced linking
    primary_link: Optional[TextLink] = Field(None, description="Main link for the entire section with preview and context")
    subsection_links: Optional[List[TextLink]] = Field(None, description="Links for subsections within this section")
    # Educational components
    key_concepts: Optional[List[KeyConcept]] = Field(None, description="Key concepts in this section")
    vocabulary: Optional[List[VocabularyItem]] = Field(None, description="Important vocabulary in this section")
    comprehension_questions: Optional[List[ComprehensionQuestion]] = Field(None, description="Comprehension questions for this section")

class ReadingGuidePageBase(BaseModel):
    book_id: PyObjectId = Field(alias="book_id")
    user_id: str = Field(...)
    page_number: int = Field(..., gt=0) # Page numbers are positive integers
    content: str = Field(default="", description="Legacy simple text content for backward compatibility")
    sections: Optional[List[ReadingGuideSection]] = Field(None, description="Structured guide sections with offsets and mappings")
    document_structure_map: Optional[Dict[str, Any]] = Field(None, description="Mapping of guide sections to original document headings/levels")
    # Guide metadata
    guide_type: str = Field(default="comprehensive", description="Guide type: 'comprehensive', 'summary', 'study', or 'quick_reference'")
    target_audience: Optional[str] = Field(None, description="Target audience: 'student', 'professional', 'casual', or 'adaptive'")
    reading_level: Optional[str] = Field(None, description="Overall page reading level: 'beginner', 'intermediate', or 'advanced'")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True # Pydantic V2 (was allow_population_by_field_name)
        json_encoders = {ObjectId: str, datetime: lambda dt: dt.isoformat()}
        arbitrary_types_allowed = True # Allow PyObjectId

class ReadingGuidePageCreate(ReadingGuidePageBase):
    pass

class ReadingGuidePageInDB(ReadingGuidePageBase):
    id: PyObjectId = Field(default_factory=PyObjectId, alias="_id")

    # Config class is inherited from ReadingGuidePageBase, 
    # but can be specified if overrides are needed.
    # For Pydantic V2, model_config can be used as a dictionary too.
    # class Config:
    #     populate_by_name = True
    #     json_encoders = {ObjectId: str, datetime: lambda dt: dt.isoformat()}
    #     arbitrary_types_allowed = True
