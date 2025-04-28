from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from bson import ObjectId

# Custom Pydantic type for ObjectId
class PyObjectId(ObjectId):
    @classmethod
    def __get_validators__(cls):
        yield cls.validate

    @classmethod
    def validate(cls, v):
        if not ObjectId.is_valid(v):
            raise ValueError("Invalid ObjectId")
        return ObjectId(v)

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
    id: PyObjectId = Field(default_factory=PyObjectId, alias="_id")
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
