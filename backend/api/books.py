import os
import logging # Keep one logging import
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool # Import run_in_threadpool

# Change relative imports to absolute imports
from backend.services.pdf_client import process_pdf_with_service
from backend.db.mongodb import save_book, get_book # Import the implemented DB functions
# Assuming backend/models/book.py exists with the Book model
# We will need to update this model to store markdown_file_path instead of markdown_content
from backend.models.book import Book

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
        # Use run_in_threadpool to call the synchronous function
        processed_data = await run_in_threadpool(process_pdf_with_service, file, title)

        if not processed_data or not processed_data.get("success"):
             # process_pdf_with_service should raise HTTPException, but this is a fallback check
             raise HTTPException(status_code=500, detail=processed_data.get("message", "PDF processing failed"))

        # 2. Prepare data for database
        # Store the markdown file path instead of the content string
        book_data = {
            "title": processed_data.get("title", title or os.path.splitext(file.filename)[0]),
            "original_filename": file.filename,
            "markdown_file_path": processed_data.get("file_path", ""), # Store the file path
            "image_paths": [img["path"] for img in processed_data.get("images", [])],
            # image_urls will be generated on retrieval
            # markdown_content will be read from file on retrieval
        }

        # 3. Save to database
        book_id = await save_book(book_data)
        logger.info(f"Book saved with ID: {book_id}")

        # 4. Retrieve and return the saved book data (including generated ID)
        # We need to fetch the data again to get the _id and then read the markdown file
        saved_book_doc = await get_book(book_id)
        if not saved_book_doc:
            raise HTTPException(status_code=500, detail="Failed to retrieve saved book data after saving.")

        # Read markdown content from the file path
        markdown_content = ""
        markdown_file_path = saved_book_doc.get("markdown_file_path")
        if markdown_file_path and os.path.exists(markdown_file_path):
            try:
                # Use run_in_threadpool for file reading as well, as it's blocking I/O
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
            except Exception as file_read_error:
                logger.error(f"Failed to read markdown file {markdown_file_path}: {file_read_error}")
                # Decide how to handle file read errors - return empty content or raise error?
                # For now, return empty content but log the error.

        # Prepare the response model, including the read markdown content
        response_data = {
            "_id": str(saved_book_doc["_id"]), # Convert ObjectId to string
            "title": saved_book_doc.get("title"),
            "original_filename": saved_book_doc.get("original_filename"),
            "markdown_file_path": saved_book_doc.get("markdown_file_path"), # Optionally include path
            "image_paths": saved_book_doc.get("image_paths", []),
            # Convert server-side image paths to public URLs for the response
            "image_urls": [f"/images/{os.path.basename(path)}" for path in saved_book_doc.get("image_paths", [])]
        }


        return Book(**response_data)

    except HTTPException as e:
        # Re-raise HTTPExceptions raised by process_pdf_with_service or other parts
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload and processing: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str):
    """
    Retrieves book data by its ID, reads markdown content from file.
    """
    logger.info(f"Received request for book ID: {book_id}")
    # Validate book_id format
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    book_data_doc = await get_book(book_id)

    if book_data_doc:
        # Read markdown content from the file path stored in the database
        markdown_content = ""
        markdown_file_path = book_data_doc.get("markdown_file_path")
        if markdown_file_path and os.path.exists(markdown_file_path):
             try:
                # Use run_in_threadpool for file reading as well
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
             except Exception as file_read_error:
                logger.error(f"Failed to read markdown file {markdown_file_path}: {file_read_error}")
                # Decide how to handle file read errors - return empty content or raise error?
                # For now, return empty content but log the error.


        # Prepare the response model, including the read markdown content
        response_data = {
            "_id": str(book_data_doc["_id"]), # Convert ObjectId to string
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "markdown_content": markdown_content, # Include the read content
            "markdown_file_path": book_data_doc.get("markdown_file_path"), # Optionally include path
            "image_paths": book_data_doc.get("image_paths", []),
            # Convert server-side image paths to public URLs for the response
            "image_urls": [f"/images/{os.path.basename(path)}" for path in book_data_doc.get("image_paths", [])]
        }

        return Book(**response_data)
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
