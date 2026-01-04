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
