# backend/models/book.py

from pydantic import BaseModel, Field, ConfigDict # Import ConfigDict for Pydantic v2
from typing import List, Optional

class Book(BaseModel):
    # Use Field alias for MongoDB's _id
    id: str = Field(alias='_id')
    title: str
    original_filename: str
    # --- Add fields for job tracking ---
    job_id: Optional[str] = None # Store the ID from the PDF processing service
    status: Optional[str] = None # Store the processing status (e.g., pending, processing, completed, failed)
    # --- Fields populated on retrieval, not necessarily stored directly ---
    markdown_content: Optional[str] = None
    image_urls: List[str] = []

    # Use model_config for Pydantic v2
    model_config = ConfigDict(
        populate_by_name=True, # Allow mapping _id to id
        json_schema_extra={
            "example": {
                "_id": "60f1b0b3b3f3f3f3f3f3f3f3",
                "title": "Sample Book",
                "original_filename": "sample.pdf",
                "job_id": "some-uuid-string", # Added example
                "status": "completed", # Added example
                "markdown_content": "# Sample Book\n\nThis is the content...",
                "image_urls": ["/images/Sample Book_img_001.png"]
            }
        },
        # Add this if you encounter issues with ObjectId serialization, though str should work
        # json_encoders={ObjectId: str}
    )
