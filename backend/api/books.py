import os
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool

from backend.services.pdf_client import process_pdf_with_service
from backend.db.mongodb import save_book, get_book, get_database # Import get_database for listing
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
            # This case should ideally not happen if save_book was successful
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to retrieve saved book data after saving.")

        # Read markdown content from the file path for the response
        # Note: For the upload response, we read the content immediately.
        # For the GET endpoint, we also read it on demand.
        markdown_content = ""
        markdown_file_path = saved_book_doc.get("markdown_file_path")
        logger.info(f"Upload endpoint: Markdown file path from DB: {markdown_file_path}")
        if markdown_file_path and os.path.exists(markdown_file_path):
            logger.info(f"Upload endpoint: Markdown file exists at {markdown_file_path}")
            try:
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
                logger.info(f"Upload endpoint: Successfully read markdown content (length: {len(markdown_content)})")
            except Exception as file_read_error:
                logger.error(f"Upload endpoint: Failed to read markdown file {markdown_file_path}: {file_read_error}", exc_info=True)
        else:
             logger.warning(f"Upload endpoint: Markdown file path missing or file not found: {markdown_file_path}")


        response_data = {
            "_id": str(saved_book_doc["_id"]),
            "title": saved_book_doc.get("title"),
            "original_filename": saved_book_doc.get("original_filename"),
            "markdown_content": markdown_content, # Include content in upload response
            "markdown_file_path": saved_book_doc.get("markdown_file_path"),
            "image_paths": saved_book_doc.get("image_paths", []),
            "image_urls": [f"/images/{os.path.basename(path)}" for path in saved_book_doc.get("image_paths", [])]
        }
        logger.info(f"Upload endpoint: Returning book data for ID {book_id}")

        return Book(**response_data)

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload and processing: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database.
    Does NOT include full markdown content in the list view.
    """
    logger.info("Received request to list all books")
    database = get_database()
    if database is None:
         logger.error("Database not initialized for list_books.")
         raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database not initialized.")

    try:
        # Fetch all book documents. Project only necessary fields for the list view.
        # We don't need the full markdown_file_path or image_paths here.
        # We also don't need markdown_content or image_urls as they are derived/large.
        books_cursor = database.books.find({}, {"title": 1, "original_filename": 1}) # Project _id, title, original_filename
        books_list = await books_cursor.to_list(length=1000) # Limit the number of results if needed

        # Convert ObjectId to string for the response model
        # Create a simplified Book model instance for each document
        response_list = []
        for book_doc in books_list:
             # Create a dictionary matching the Book model structure, converting _id
             # Only include fields that were projected or are simple defaults
             response_data = {
                 "_id": str(book_doc["_id"]),
                 "title": book_doc.get("title", "Untitled"), # Provide default if title is missing
                 "original_filename": book_doc.get("original_filename", "N/A"),
                 # Provide empty lists/None for fields not fetched in the projection
                 "markdown_file_path": None,
                 "image_paths": [],
                 "markdown_content": None,
                 "image_urls": []
             }
             response_list.append(Book(**response_data))

        logger.info(f"Returning list of {len(response_list)} books.")
        return response_list

    except Exception as e:
        logger.error(f"Error listing books: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error retrieving books: {e}")


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
        logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")
        markdown_content = ""
        markdown_file_path = book_data_doc.get("markdown_file_path")
        logger.info(f"Get endpoint: Markdown file path from DB: {markdown_file_path}")
        if markdown_file_path and os.path.exists(markdown_file_path):
             logger.info(f"Get endpoint: Markdown file exists at {markdown_file_path}")
             try:
                # Use run_in_threadpool for file reading as well
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
                logger.info(f"Get endpoint: Successfully read markdown content (length: {len(markdown_content)})")
             except Exception as file_read_error:
                logger.error(f"Get endpoint: Failed to read markdown file {markdown_file_path}: {file_read_error}", exc_info=True)
                # Decide how to handle file read errors - return empty content or raise error?
                # For now, return empty content but log the error.
        else:
             logger.warning(f"Get endpoint: Markdown file path missing or file not found: {markdown_file_path}")


        response_data = {
            "_id": str(book_data_doc["_id"]), # Convert ObjectId to string
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "markdown_file_path": book_data_doc.get("markdown_file_path"), # Optionally include path
            "image_paths": book_data_doc.get("image_paths", []),
            "markdown_content": markdown_content, # Include content in get response
            # Convert server-side image paths to public URLs for the response
            "image_urls": [f"/images/{os.path.basename(path)}" for path in book_data_doc.get("image_paths", [])]
        }
        logger.info(f"Get endpoint: Returning book data for ID {book_id}")

        return Book(**response_data)
    else:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
