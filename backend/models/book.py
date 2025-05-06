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

class Book(BaseModel):
    # Use Annotated and BeforeValidator for Pydantic v2 ObjectId handling
    # Use Field alias for MongoDB's _id, default_factory=ObjectId for new documents
    id: Annotated[ObjectId, BeforeValidator(validate_objectid)] = Field(alias="_id", default_factory=ObjectId)

    job_id: Optional[str] = None # Store the ID from the PDF processing service
    title: str
    original_filename: str
    sanitized_title: Optional[str] = None # Store the sanitized title used for filenames
    status: str = "pending" # Store the processing status (e.g., pending, processing, completed, failed)
    # Use 'filepath' to indicate server-side path
    markdown_filepath: Optional[str] = None # Store the server-side path to the generated markdown file
    image_filepaths: List[str] = [] # Store the server-side paths to the generated image files
    # CHANGE THIS LINE: Make upload_timestamp Optional
    upload_timestamp: Optional[datetime] = Field(default_factory=datetime.utcnow) # Allow None, but still provide a default for new objects
    completion_timestamp: Optional[datetime] = None # Timestamp when processing completed
    error_message: Optional[str] = None # Store error message if processing fails

    # --- Fields populated on retrieval for response, not stored directly ---
    markdown_content: Optional[str] = None # Populated when fetching a single book by reading the file
    image_urls: List[str] = [] # Populated when fetching a single book by converting filepaths to URLs

    # --- Pydantic V2 Configuration ---
    model_config = ConfigDict(
        populate_by_name=True, # Allow mapping _id to id
        arbitrary_types_allowed=True, # Needed for ObjectId and datetime
        # Add json_encoders to handle custom types during JSON serialization
        json_encoders={
            ObjectId: serialize_objectid, # Add this line to serialize ObjectId to string
            datetime: lambda dt: dt.isoformat() # Keep the existing datetime encoder
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
                "markdown_filepath": "/path/to/storage/output/Sample_Book.md", # Example server path
                "image_filepaths": ["/path/to/storage/images/Sample_Book_img_001.png"], # Example server paths
                # Example showing it can be None or a string
                "upload_timestamp": "2023-10-27T10:00:00Z", # Or null
                "completion_timestamp": "2023-10-27T10:05:00Z",
                "error_message": None,
                "markdown_content": "# Sample Book\n\nThis is the content...",
                "image_urls": ["/images/Sample_Book_img_001.png"]
            }
        },
    )
