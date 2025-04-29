# backend/models/book.py

from pydantic import BaseModel, Field
from typing import List, Optional

class Book(BaseModel):
    # Use Field alias for MongoDB's _id
    id: str = Field(alias='_id')
    title: str
    original_filename: str
    # These fields are for the API response, derived from stored filenames
    # This field is for the API response, not stored in DB
    markdown_content: Optional[str] = None
    image_urls: List[str] = []

    class Config:
        populate_by_name = True # Allow mapping _id to id
        json_schema_extra = {
            "example": {
                "_id": "60f1b0b3b3f3f3f3f3f3f3f3",
                "title": "Sample Book",
                "original_filename": "sample.pdf",
                "markdown_content": "# Sample Book\n\nThis is the content...",
                "image_urls": ["/images/Sample Book_img_001.png"]
            }
        }
