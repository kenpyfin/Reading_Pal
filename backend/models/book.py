# backend/models/book.py

# ... existing imports ...
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict
from typing import Optional, List, Any, Annotated # Ensure Optional is imported
from datetime import datetime
from bson import ObjectId # Ensure ObjectId is imported

# Custom validator for ObjectId
def validate_objectid(v: Any) -> ObjectId:
    if isinstance(v, ObjectId):
        return v
    if isinstance(v, str):
        try:
            return ObjectId(v)
        except Exception:
            pass
    raise ValueError('Invalid ObjectId')

# Custom serializer for ObjectId to string
def serialize_objectid(v: ObjectId) -> str:
    return str(v)

# --- Add new model for storing detailed image info in DB ---
class ImageInfoForDB(BaseModel):
    filename: str # The final, sanitized filename stored on disk and used for serving
    original_path_in_markdown: str # The exact path string as it appeared in the raw markdown from magic_pdf

class Book(BaseModel):
    # Use Annotated and BeforeValidator for Pydantic v2 ObjectId handling
    # Use Field alias for MongoDB's _id, default_factory=ObjectId for new documents
    id: Annotated[ObjectId, BeforeValidator(validate_objectid)] = Field(alias="_id", default_factory=ObjectId)

    job_id: Optional[str] = None # Store the ID from the PDF processing service
    title: str
    original_filename: str
    sanitized_title: Optional[str] = None # Store the sanitized title used for filenames
    status: str = "pending" # Store the processing status (e.g., pending, processing, completed, failed)

    # --- Fields matching the actual DB schema ---
    # Use 'filename' as per DB schema
    markdown_filename: Optional[str] = None # Store the server-side filename of the generated markdown file
    image_filenames: List[str] = [] # Store the server-side filenames of the generated image files

    # Use 'created_at' and 'updated_at' as per DB schema
    created_at: Optional[datetime] = Field(default_factory=datetime.utcnow) # Allow None, provide default
    updated_at: Optional[datetime] = Field(default_factory=datetime.utcnow) # Allow None, provide default

    # Use 'processing_error' as per DB schema
    processing_error: Optional[str] = None # Store error message if processing fails

    # --- New field to store detailed image information for precise replacement ---
    processed_images_info: Optional[List[ImageInfoForDB]] = None # List of objects with original path and final filename

    # --- Fields populated on retrieval for response, not stored directly ---
    markdown_content: Optional[str] = None # Populated when fetching a single book by reading the file
    image_urls: List[str] = [] # Populated when fetching a single book by converting filenames to URLs

    # --- Pydantic V2 Configuration ---
    model_config = ConfigDict(
        populate_by_name=True, # Allow mapping _id to id
        arbitrary_types_allowed=True, # Needed for ObjectId and datetime
        # Add json_encoders to handle custom types during JSON serialization
        json_encoders={
            ObjectId: serialize_objectid, # Serialize ObjectId to string
            datetime: lambda dt: dt.isoformat() # Serialize datetime to ISO string
        },
        json_schema_extra={
            "example": {
                "_id": "60f1b0b3b3f3f3f3f3f3f3f3", # Example MongoDB _id
                "id": "60f1b0b3b3f3f3f3f3f3f3f3", # Example Pydantic id (string representation)
                "title": "Sample Book",
                "original_filename": "sample.pdf",
                "job_id": "some-uuid-string",
                "sanitized_title": "Sample_Book",
                "status": "completed",
                "markdown_filename": "Sample_Book.md", # Example server filename
                "image_filenames": ["Sample_Book_img_001.png"], # Example server filenames
                "processed_images_info": [
                    {"filename": "Sample_Book_img_001.png", "original_path_in_markdown": "images/Sample_Book_img_001.png"}
                ],
                "created_at": "2023-10-27T10:00:00Z", # Example timestamp
                "updated_at": "2023-10-27T10:05:00Z", # Example timestamp
                "processing_error": None,
                "markdown_content": "# Sample Book\n\nThis is the content with ![alt text](/images/Sample_Book_img_001.png)...",
                "image_urls": ["/images/Sample_Book_img_001.png"]
            }
        },
    )
