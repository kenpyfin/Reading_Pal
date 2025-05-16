from datetime import datetime
from typing import Optional, Annotated, Any # Ensure Any is imported

from pydantic import BaseModel, Field, BeforeValidator, ConfigDict # Ensure ConfigDict is imported
from bson import ObjectId

# Helper functions (can be moved to a shared utils module later)
def validate_objectid(v: Any) -> ObjectId:
    if isinstance(v, ObjectId):
        return v
    if ObjectId.is_valid(v): # Use ObjectId.is_valid for robustness
        return ObjectId(v)
    raise ValueError("Invalid ObjectId")

def serialize_objectid(v: ObjectId) -> str:
    return str(v)

class BookmarkBase(BaseModel):
    book_id: str # References Book.id (which is a string representation of ObjectId)
    name: Optional[str] = None
    page_number: Optional[int] = None
    scroll_percentage: Optional[float] = Field(None, ge=0.0, le=1.0)
    global_character_offset: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = Field(default_factory=datetime.utcnow) # Add updated_at

    # Pydantic V2 Configuration within BookmarkBase
    model_config = ConfigDict(
        populate_by_name=True, # Allow mapping _id to id
        arbitrary_types_allowed=True, # Needed for ObjectId and datetime
        json_encoders={
            ObjectId: serialize_objectid, # Serialize ObjectId to string
            datetime: lambda dt: dt.isoformat() if dt else None # Handle optional datetime
        }
    )

class BookmarkCreate(BookmarkBase):
    pass

class BookmarkUpdate(BaseModel): # For updating specific fields like name
    name: Optional[str] = None
    # Add other fields if they are updatable individually
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    model_config = ConfigDict(
        json_encoders={
            datetime: lambda dt: dt.isoformat() if dt else None
        }
    )


class Bookmark(BookmarkBase):
    id: Annotated[ObjectId, BeforeValidator(validate_objectid)] = Field(alias="_id")

    # model_config is inherited from BookmarkBase and can be extended if needed
