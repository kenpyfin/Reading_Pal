from pydantic import BaseModel, Field
from pydantic_core import PydanticCustomError # Import for Pydantic v2 custom errors
from typing import Optional
from datetime import datetime
from bson import ObjectId

# Custom Pydantic type for ObjectId
# Inherit from ObjectId to leverage its methods and type checking
class PyObjectId(ObjectId):
    # Pydantic v2 validation using __validate__
    @classmethod
    def __validate__(cls, __input_value, _info):
        # Handle ObjectId instance directly (most common case when loading from DB)
        if isinstance(__input_value, ObjectId):
            return __input_value
        # Handle string representation (e.g., from API input or if DB returns strings)
        if isinstance(__input_value, str) and ObjectId.is_valid(__input_value):
            return ObjectId(__input_value) # Return ObjectId instance after parsing
        # Raise error for invalid types or invalid string format
        raise PydanticCustomError(
            'invalid_object_id',
            'ObjectId must be an instance of ObjectId or a valid string representation',
            {'value': __input_value, 'type': type(__input_value)},
        )

    @classmethod
    def __get_pydantic_json_schema__(cls, field_schema):
        field_schema.update(type="string")

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
    # Use PyObjectId type hint for the id field, alias to "_id" for MongoDB mapping
    id: PyObjectId = Field(alias="_id") # Removed default_factory
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True
        json_encoders = {ObjectId: str}
        json_schema_extra = {
            "example": {
                "book_id": "60c72b2f9b1d4b3b8c8b4567",
                "content": "This is a note about the first chapter.",
                "created_at": "2023-10-27T10:00:00.000Z",
                "updated_at": "2023-10-27T10:00:00.000Z"
            }
        }
