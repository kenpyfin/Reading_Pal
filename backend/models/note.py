from pydantic import BaseModel, Field, BeforeValidator, ValidationError
from typing import Optional, Annotated, Any
from datetime import datetime
from bson import ObjectId

# Custom type for ObjectId using Annotated and BeforeValidator
def validate_objectid(v: Any) -> ObjectId:
    """
    Validator function to convert input (string or ObjectId) to ObjectId.
    Used with BeforeValidator to parse input before Pydantic's main validation.
    """
    if isinstance(v, ObjectId):
        return v
    if isinstance(v, str) and ObjectId.is_valid(v):
        return ObjectId(v)
    # If it's not a valid ObjectId or string, raise a ValueError.
    # Pydantic's BeforeValidator will catch this and convert it to a ValidationError.
    raise ValueError("Invalid ObjectId format")

class NoteBase(BaseModel):
    book_id: str = Field(...) # Reference to the book ID (as string)
    content: str = Field(...) # The note content
    # TODO: Add fields for position/section reference later

class NoteCreate(NoteBase):
    # created_at and updated_at will be set by the backend
    pass

class NoteUpdate(BaseModel):
    content: Optional[str] = None
    # TODO: Add fields for position/section reference later

class Note(NoteBase):
    # Use Annotated with BeforeValidator to handle ObjectId parsing from various inputs (like strings)
    # Alias "_id" for MongoDB mapping
    # Use default_factory=ObjectId for creating new notes in the application logic
    id: Annotated[ObjectId, BeforeValidator(validate_objectid)] = Field(alias="_id", default_factory=ObjectId)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        # Allow population by field name (id) or alias (_id)
        populate_by_name = True
        # Allow arbitrary types (like ObjectId)
        arbitrary_types_allowed = True
        # Configure JSON encoding for ObjectId when serializing the model
        json_encoders = {ObjectId: str}
        # Example schema for documentation
        json_schema_extra = {
            "example": {
                # Example should show string format for ObjectId as it appears in JSON
                "_id": "60f1b0b3b3f3f3f3f3f3f3f3",
                "book_id": "60c72b2f9b1d4b3b8c8b4567",
                "content": "This is a note about the first chapter.",
                "created_at": "2023-10-27T10:00:00.000Z",
                "updated_at": "2023-10-27T10:00:00.000Z"
            }
        }
