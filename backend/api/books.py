import os
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId

from ..services.pdf_client import process_pdf_with_service
from ..db.mongodb import save_book, get_book # Import the implemented DB functions
from ..models.book import Book # Assuming backend/models/book.py exists with the Book model

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/upload", response_model=Book)
async def upload_pdf(
    file: UploadFile = File(...),
    title: str = Form(None)
):
    """
    Uploads a PDF file, sends it to the processing service,
    saves the result to the database, and returns the book data.
    """
    logger.info(f"Received upload request for file: {file.filename}")
    try:
        # 1. Send file to PDF processing service
        processed_data = await process_pdf_with_service(file, title)

        if not processed_data or not processed_data.get("success"):
             # process_pdf_with_service should raise HTTPException
             raise HTTPException(status_code=500, detail=processed_data.get("message", "PDF processing failed"))

        # 2. Prepare data for database
        book_data = {
            "title": processed_data.get("title", title or os.path.splitext(file.filename)[0]),
            "original_filename": file.filename,
            "markdown_content": processed_data.get("markdown_content", ""),
            "image_paths": [img["path"] for img in processed_data.get("images", [])],
            # image_urls will be generated on retrieval
        }

        # 3. Save to database
        book_id = await save_book(book_data)
        logger.info(f"Book saved with ID: {book_id}")

        # 4. Retrieve and return the saved book data (including generated ID)
        saved_book = await get_book(book_id)
        if not saved_book:
            raise HTTPException(status_code=500, detail="Failed to retrieve saved book data after saving.")

        # Convert server-side paths to public URLs for the response
        # This assumes the static route is mounted at /images
        saved_book["image_urls"] = [f"/images/{os.path.basename(path)}" for path in saved_book.get("image_paths", [])]

        return Book(**saved_book)

    except HTTPException as e:
        # Re-raise HTTPExceptions raised by process_pdf_with_service
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload and processing: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str):
    """
    Retrieves book data by its ID.
    """
    logger.info(f"Received request for book ID: {book_id}")
    # Validate book_id format
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    book_data = await get_book(book_id)

    if book_data:
        # Convert server-side paths to public URLs
        # This assumes the static route is mounted at /images
        book_data["image_urls"] = [f"/images/{os.path.basename(path)}" for path in book_data.get("image_paths", [])]
        return Book(**book_data)
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
