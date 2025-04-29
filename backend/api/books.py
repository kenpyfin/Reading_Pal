import os
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool

from backend.services.pdf_client import process_pdf_with_service
from backend.db.mongodb import save_book, get_book, get_database
from backend.models.book import Book

logger = logging.getLogger(__name__)
router = APIRouter()

# Retrieve container paths from environment variables
# These should be set in docker-compose.yml to the mount points inside the container
CONTAINER_IMAGES_PATH = os.getenv("IMAGES_PATH")
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH")

# Remove the translate_path function as it's no longer needed


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
        # process_pdf_with_service returns host paths and filenames
        # This call is synchronous, so run it in a threadpool
        processed_data = await run_in_threadpool(process_pdf_with_service, file, title)

        if not processed_data or not processed_data.get("success"):
             raise HTTPException(status_code=500, detail=processed_data.get("message", "PDF processing failed"))

        # Extract filenames from the processed data returned by the PDF service
        # The PDF service saves files using the sanitized title as a prefix,
        # and returns the full host path. We only need the basename (filename).
        markdown_filename = os.path.basename(processed_data.get("file_path", ""))
        # The PDF service returns a list of image dicts, each with 'filename' and 'path'
        image_filenames = [img["filename"] for img in processed_data.get("images", [])]

        # Store ONLY filenames in the DB. The backend will construct container paths.
        book_data = {
            "title": processed_data.get("title", title or os.path.splitext(file.filename)[0]),
            "original_filename": file.filename,
            # Store filenames instead of full paths
            "markdown_filename": markdown_filename,
            "image_filenames": image_filenames,
        }

        book_id = await save_book(book_data)
        logger.info(f"Book saved with ID: {book_id}")

        # Retrieve the saved book document to ensure we have the _id and stored data
        saved_book_doc = await get_book(book_id)
        if not saved_book_doc:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to retrieve saved book data after saving.")

        # Read markdown content from the file using the container path
        markdown_content = ""
        stored_markdown_filename = saved_book_doc.get("markdown_filename")
        container_markdown_path = None

        # Construct the full container path using the container mount point and filename
        if CONTAINER_MARKDOWN_PATH and stored_markdown_filename:
            container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, stored_markdown_filename)

        logger.info(f"Upload endpoint: Attempting to read markdown from container path: {container_markdown_path}")
        if container_markdown_path and os.path.exists(container_markdown_path):
            try:
                # File I/O is blocking, run in threadpool
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), container_markdown_path)
                logger.info(f"Upload endpoint: Successfully read markdown content (length: {len(markdown_content)})")
            except Exception as file_read_error:
                logger.error(f"Upload endpoint: Failed to read markdown file {container_markdown_path}: {file_read_error}", exc_info=True)
        else:
             logger.warning(f"Upload endpoint: Container markdown file path missing or file not found: {container_markdown_path}")


        # Generate image URLs using the static mount prefix and stored filenames
        stored_image_filenames = saved_book_doc.get("image_filenames", [])
        image_urls = [f"/images/{filename}" for filename in stored_image_filenames]
        logger.info(f"Upload endpoint: Generated {len(image_urls)} image URLs: {image_urls}")


        # Construct the response model
        response_data = {
            "_id": str(saved_book_doc["_id"]),
            "title": saved_book_doc.get("title"),
            "original_filename": saved_book_doc.get("original_filename"),
            "markdown_content": markdown_content, # Include content in upload response
            # Do NOT include internal filenames in the API response model
            "image_urls": image_urls # Include generated URLs
        }
        logger.info(f"Upload endpoint: Returning book data for ID {book_id}")

        return Book(**response_data)

    except HTTPException as e:
        # Re-raise FastAPI HTTPExceptions
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload and processing: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database.
    Does NOT include full markdown content or image URLs in the list view.
    """
    logger.info("Received request to list all books")
    database = get_database()
    if database is None:
         logger.error("Database not initialized for list_books.")
         raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database not initialized.")

    try:
        # Fetch all book documents. Project only necessary fields for the list view.
        # We only need title and original_filename for the list display.
        books_cursor = database.books.find({}, {"title": 1, "original_filename": 1})
        books_list = await books_cursor.to_list(length=1000)

        response_list = []
        for book_doc in books_list:
             response_data = {
                 "_id": str(book_doc["_id"]),
                 "title": book_doc.get("title", "Untitled"),
                 "original_filename": book_doc.get("original_filename", "N/A"),
                 # These fields are not needed for the list view, set to None/empty
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
    if not ObjectId.is_valid(book_id):
        logger.warning(f"Invalid book ID format received: {book_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    book_data_doc = await get_book(book_id)

    if book_data_doc:
        logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

        # Retrieve filenames from the DB document
        stored_markdown_filename = book_data_doc.get("markdown_filename")
        stored_image_filenames = book_data_doc.get("image_filenames", [])

        # Construct the container markdown path using the container mount point and filename
        markdown_content = ""
        container_markdown_path = None
        if CONTAINER_MARKDOWN_PATH and stored_markdown_filename:
            container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, stored_markdown_filename)

        logger.info(f"Get endpoint: Constructed container markdown path: {container_markdown_path}")

        # Add detailed checks and logging before attempting to open
        if not container_markdown_path:
             logger.error(f"Get endpoint: Container markdown path is empty for book ID {book_id}.")
        elif not os.path.exists(container_markdown_path):
             logger.error(f"Get endpoint: Markdown file NOT FOUND at container path: {container_markdown_path} for book ID {book_id}.")
             # You might want to return a specific error or message to the frontend here
             # indicating the file is missing, rather than just empty content.
             # For now, it will return empty content.
        else:
             logger.info(f"Get endpoint: Markdown file found at container path: {container_markdown_path}. Attempting to read...")
             try:
                # Use run_in_threadpool for file I/O
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), container_markdown_path)
                logger.info(f"Get endpoint: Successfully read markdown content (length: {len(markdown_content)}) from {container_markdown_path}")
                if not markdown_content.strip():
                     logger.warning(f"Get endpoint: Markdown content read from {container_markdown_path} is empty or only whitespace.")
             except Exception as file_read_error:
                logger.error(f"Get endpoint: Failed to read markdown file {container_markdown_path} for book ID {book_id}: {file_read_error}", exc_info=True)
                # Optionally set markdown_content to an error message string
                # markdown_content = f"Error reading markdown file: {file_read_error}"


        # Generate image URLs using the static mount prefix and stored filenames
        image_urls = [f"/images/{filename}" for filename in stored_image_filenames]
        logger.info(f"Get endpoint: Generated {len(image_urls)} image URLs: {image_urls}")


        # Construct the response model
        response_data = {
            "_id": str(book_data_doc["_id"]),
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "markdown_content": markdown_content, # Include content in get response
            "image_urls": image_urls # Include generated URLs
        }
        logger.info(f"Get endpoint: Returning book data for ID {book_id}")

        return Book(**response_data)
    else:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
