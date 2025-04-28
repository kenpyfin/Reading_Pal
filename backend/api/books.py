import os
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool

from backend.services.pdf_client import process_pdf_with_service
from backend.db.mongodb import save_book, get_book
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
        processed_data = await run_in_threadpool(process_pdf_with_service, file, title)

        if not processed_data or not processed_data.get("success"):
             raise HTTPException(status_code=500, detail=processed_data.get("message", "PDF processing failed"))

        book_data = {
            "title": processed_data.get("title", title or os.path.splitext(file.filename)[0]),
            "original_filename": file.filename,
            "markdown_file_path": processed_data.get("file_path", ""),
            "image_paths": [img["path"] for img in processed_data.get("images", [])],
        }

        book_id = await save_book(book_data)
        logger.info(f"Book saved with ID: {book_id}")

        saved_book_doc = await get_book(book_id)
        if not saved_book_doc:
            raise HTTPException(status_code=500, detail="Failed to retrieve saved book data after saving.")

        # Read markdown content from the file path for the response
        markdown_content = ""
        markdown_file_path = saved_book_doc.get("markdown_file_path")
        logger.info(f"Upload endpoint: Markdown file path from DB: {markdown_file_path}") # Add logging
        if markdown_file_path and os.path.exists(markdown_file_path):
            logger.info(f"Upload endpoint: Markdown file exists at {markdown_file_path}") # Add logging
            try:
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
                logger.info(f"Upload endpoint: Successfully read markdown content (length: {len(markdown_content)})") # Add logging
            except Exception as file_read_error:
                logger.error(f"Upload endpoint: Failed to read markdown file {markdown_file_path}: {file_read_error}", exc_info=True) # Add logging with traceback
        else:
             logger.warning(f"Upload endpoint: Markdown file path missing or file not found: {markdown_file_path}") # Add logging


        response_data = {
            "_id": str(saved_book_doc["_id"]),
            "title": saved_book_doc.get("title"),
            "original_filename": saved_book_doc.get("original_filename"),
            "markdown_content": markdown_content,
            "markdown_file_path": saved_book_doc.get("markdown_file_path"),
            "image_paths": saved_book_doc.get("image_paths", []),
            "image_urls": [f"/images/{os.path.basename(path)}" for path in saved_book_doc.get("image_paths", [])]
        }
        logger.info(f"Upload endpoint: Returning book data for ID {book_id}") # Add logging
        # logger.debug(f"Upload endpoint: Response data: {response_data}") # Optional: log full data if needed

        return Book(**response_data)

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload and processing: {e}", exc_info=True) # Log traceback
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
        logger.info(f"Get endpoint: Book found in DB for ID: {book_id}") # Add logging
        markdown_content = ""
        markdown_file_path = book_data_doc.get("markdown_file_path")
        logger.info(f"Get endpoint: Markdown file path from DB: {markdown_file_path}") # Add logging
        if markdown_file_path and os.path.exists(markdown_file_path):
             logger.info(f"Get endpoint: Markdown file exists at {markdown_file_path}") # Add logging
             try:
                # Use run_in_threadpool for file reading as well
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
             except Exception as file_read_error:
                logger.error(f"Get endpoint: Failed to read markdown file {markdown_file_path}: {file_read_error}", exc_info=True) # Add logging with traceback
        else:
             logger.warning(f"Get endpoint: Markdown file path missing or file not found: {markdown_file_path}") # Add logging


        response_data = {
            "_id": str(book_data_doc["_id"]), # Convert ObjectId to string
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "markdown_file_path": book_data_doc.get("markdown_file_path"), # Optionally include path
            "image_paths": book_data_doc.get("image_paths", []),
            # Convert server-side image paths to public URLs for the response
            "image_urls": [f"/images/{os.path.basename(path)}" for path in book_data_doc.get("image_paths", [])]
        }
        logger.info(f"Get endpoint: Returning book data for ID {book_id}") # Add logging
        # logger.debug(f"Get endpoint: Response data: {response_data}") # Optional: log full data if needed

        return Book(**response_data)
    else:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}") # Add logging
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
