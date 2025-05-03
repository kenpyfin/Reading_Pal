# backend/models/book.py

from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
from datetime import datetime # Import datetime

class Book(BaseModel):
    # Use Field alias for MongoDB's _id, ensure it's Optional for creation before ID exists
    id: Optional[str] = Field(default=None, alias='_id')
    title: str
    original_filename: str
    # --- Fields for job tracking and results ---
    job_id: Optional[str] = None # Store the ID from the PDF processing service
    status: Optional[str] = "pending" # Store the processing status (e.g., pending, processing, completed, failed)
    markdown_filename: Optional[str] = None # Store the name of the generated markdown file
    image_filenames: List[str] = [] # Store the names of the generated image files
    processing_error: Optional[str] = None # Store error message if processing fails
    # Optional: Timestamps
    created_at: Optional[datetime] = Field(default_factory=datetime.utcnow)
    updated_at: Optional[datetime] = Field(default_factory=datetime.utcnow)

    # --- Fields populated on retrieval for response, not stored directly ---
    markdown_content: Optional[str] = None # Populated when fetching a single book
    image_urls: List[str] = [] # Populated when fetching a single book

    # Use model_config for Pydantic v2
    model_config = ConfigDict(
        populate_by_name=True, # Allow mapping _id to id
        arbitrary_types_allowed=True, # Needed if using datetime or ObjectId directly
        json_encoders={datetime: lambda dt: dt.isoformat()}, # Example encoder for datetime
        json_schema_extra={
            "example": {
                "_id": "60f1b0b3b3f3f3f3f3f3f3f3", # Note: Pydantic expects 'id' here if alias is used effectively
                "id": "60f1b0b3b3f3f3f3f3f3f3f3",
                "title": "Sample Book",
                "original_filename": "sample.pdf",
                "job_id": "some-uuid-string",
                "status": "completed",
                "markdown_filename": "Sample Book.md", # Added example
                "image_filenames": ["Sample Book_img_001.png"], # Added example
                "processing_error": None,
                "created_at": "2023-10-27T10:00:00Z",
                "updated_at": "2023-10-27T10:05:00Z",
                # Response-only fields:
                "markdown_content": "# Sample Book\n\nThis is the content...",
                "image_urls": ["/images/Sample Book_img_001.png"]
            }
        },
    )
