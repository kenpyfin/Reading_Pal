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

# Retrieve container and host paths from environment variables
CONTAINER_IMAGES_PATH = os.getenv("IMAGES_PATH")
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH")
HOST_IMAGES_PATH = os.getenv("HOST_IMAGES_PATH")
HOST_MARKDOWN_PATH = os.getenv("HOST_MARKDOWN_PATH")

# Add a helper function for path translation
def translate_path(stored_path: str, host_prefix: str, container_prefix: str) -> str:
    """
    Translates a file path stored with a host prefix to a path
    accessible within the container using the container prefix.
    Returns the original path if it doesn't start with the host prefix
    or if prefixes are not configured.
    """
    if not stored_path or not host_prefix or not container_prefix:
        logger.warning(f"Path translation skipped: missing path or prefixes. Stored: {stored_path}, Host Prefix: {host_prefix}, Container Prefix: {container_prefix}")
        return stored_path # Cannot translate without prefixes

    # Ensure prefixes have trailing slash for consistent replacement
    host_prefix = host_prefix.rstrip('/') + '/'
    container_prefix = container_prefix.rstrip('/') + '/'

    if stored_path.startswith(host_prefix):
        relative_path = stored_path[len(host_prefix):]
        translated_path = os.path.join(container_prefix, relative_path)
        logger.debug(f"Translated path: {stored_path} -> {translated_path}")
        return translated_path
    else:
        logger.warning(f"Stored path does not start with host prefix. No translation: {stored_path} (Host Prefix: {host_prefix})")
        # If the path doesn't start with the expected host prefix,
        # it might already be a container path or something unexpected.
        # Return the original path, but log a warning.
        return stored_path


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
        # process_pdf_with_service returns host paths
        processed_data = await run_in_threadpool(process_pdf_with_service, file, title)

        if not processed_data or not processed_data.get("success"):
             raise HTTPException(status_code=500, detail=processed_data.get("message", "PDF processing failed"))

        # Store the host paths returned by the PDF service in the DB
        book_data = {
            "title": processed_data.get("title", title or os.path.splitext(file.filename)[0]),
            "original_filename": file.filename,
            "markdown_file_path": processed_data.get("file_path", ""), # This is the host path
            "image_paths": [img["path"] for img in processed_data.get("images", [])], # These are host paths
        }

        book_id = await save_book(book_data)
        logger.info(f"Book saved with ID: {book_id}")

        saved_book_doc = await get_book(book_id)
        if not saved_book_doc:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to retrieve saved book data after saving.")

        # Read markdown content from the file path for the response
        # Translate the stored host path to the container path before reading
        stored_markdown_path = saved_book_doc.get("markdown_file_path")
        container_markdown_path = translate_path(
            stored_markdown_path,
            HOST_MARKDOWN_PATH,
            CONTAINER_MARKDOWN_PATH
        )

        markdown_content = ""
        logger.info(f"Upload endpoint: Attempting to read markdown from container path: {container_markdown_path}")
        if container_markdown_path and os.path.exists(container_markdown_path):
            try:
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), container_markdown_path)
                logger.info(f"Upload endpoint: Successfully read markdown content (length: {len(markdown_content)})")
            except Exception as file_read_error:
                logger.error(f"Upload endpoint: Failed to read markdown file {container_markdown_path}: {file_read_error}", exc_info=True)
        else:
             logger.warning(f"Upload endpoint: Container markdown file path missing or file not found: {container_markdown_path}")


        # Image URLs are generated from the basename, which works with the static mount
        image_urls = [f"/images/{os.path.basename(path)}" for path in saved_book_doc.get("image_paths", [])]

        response_data = {
            "_id": str(saved_book_doc["_id"]),
            "title": saved_book_doc.get("title"),
            "original_filename": saved_book_doc.get("original_filename"),
            "markdown_content": markdown_content, # Include content in upload response
            "markdown_file_path": stored_markdown_path, # Store the original host path
            "image_paths": saved_book_doc.get("image_paths", []), # Store original host paths
            "image_urls": image_urls # Include generated URLs
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
        books_cursor = database.books.find({}, {"title": 1, "original_filename": 1})
        books_list = await books_cursor.to_list(length=1000)

        response_list = []
        for book_doc in books_list:
             response_data = {
                 "_id": str(book_doc["_id"]),
                 "title": book_doc.get("title", "Untitled"),
                 "original_filename": book_doc.get("original_filename", "N/A"),
                 # These fields are not needed for the list view, set to None/empty
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
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    book_data_doc = await get_book(book_id)

    if book_data_doc:
        logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

        # Read markdown content from the file path
        # Translate the stored host path to the container path before reading
        stored_markdown_path = book_data_doc.get("markdown_file_path")
        container_markdown_path = translate_path(
            stored_markdown_path,
            HOST_MARKDOWN_PATH,
            CONTAINER_MARKDOWN_PATH
        )

        markdown_content = ""
        logger.info(f"Get endpoint: Attempting to read markdown from container path: {container_markdown_path}")
        if container_markdown_path and os.path.exists(container_markdown_path):
             try:
                markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), container_markdown_path)
                logger.info(f"Get endpoint: Successfully read markdown content (length: {len(markdown_content)})")
             except Exception as file_read_error:
                logger.error(f"Get endpoint: Failed to read markdown file {container_markdown_path}: {file_read_error}", exc_info=True)
        else:
             logger.warning(f"Get endpoint: Container markdown file path missing or file not found: {container_markdown_path}")

        # Image URLs are generated from the basename of the stored host path
        image_urls = [f"/images/{os.path.basename(path)}" for path in book_data_doc.get("image_paths", [])]

        response_data = {
            "_id": str(book_data_doc["_id"]),
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "markdown_file_path": stored_markdown_path, # Optionally include original host path
            "image_paths": book_data_doc.get("image_paths", []), # Optionally include original host paths
            "markdown_content": markdown_content, # Include content in get response
            "image_urls": image_urls # Include generated URLs
        }
        logger.info(f"Get endpoint: Returning book data for ID {book_id}")

        return Book(**response_data)
    else:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
