# backend/api/books.py

# Add necessary imports at the top
import asyncio # Import asyncio
import os
import logging
import requests # Import requests
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List, Optional, Dict, Any # Import Optional, Dict, Any
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool
from datetime import datetime # Import datetime
import re # Import re for sanitization

# Import models and db functions
from backend.models.book import Book
# Import specific DB functions needed
from backend.db.mongodb import (
    save_book,
    get_book,
    get_books, # Import get_books
    get_book_by_job_id, # Import get_book_by_job_id
    update_book, # Import update_book
    get_database
)
# Assuming pdf_client service exists and is imported if needed directly
# from backend.services.pdf_client import process_pdf_with_service # Keep if used

logger = logging.getLogger(__name__)
router = APIRouter()

# Define container paths (matching docker-compose volumes)
# Ensure these match the paths where markdown and images are stored *within the backend container*
# These should correspond to the volumes mounted in the backend's Dockerfile/docker-compose.yml
# If the PDF service returns absolute paths, you might need to adjust how you construct
# the container path, potentially just using the basename if the volume mount makes the
# directory structure consistent. Let's assume the PDF service returns just the filename
# or a path relative to its storage root, and we join it with the backend's mounted path.
# Based on the PDF service code, it saves to MARKDOWN_PATH and IMAGES_PATH.
# The backend needs to read from its *own* view of those paths via volumes.
# Let's assume CONTAINER_MARKDOWN_PATH and CONTAINER_IMAGES_PATH are the mount points.
# The PDF service returns the full path like /path/to/storage/output/file.md
# We need to join CONTAINER_MARKDOWN_PATH with just the basename 'file.md'
CONTAINER_IMAGES_PATH = os.getenv("IMAGES_PATH") # Should be the mount point like /app/storage/images
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH") # Should be the mount point like /app/storage/markdown

logger.info(f"API Books: CONTAINER_IMAGES_PATH = {CONTAINER_IMAGES_PATH}")
logger.info(f"API Books: CONTAINER_MARKDOWN_PATH = {CONTAINER_MARKDOWN_PATH}")

# Get PDF Service URL from environment variables
PDF_CLIENT_URL = os.getenv("PDF_CLIENT_URL")
if not PDF_CLIENT_URL:
    logger.error("PDF_CLIENT_URL environment variable is not set.")
    # Consider raising an exception here if the service is critical

# --- Add helper function for sanitizing filenames (keep as is) ---
def sanitize_filename(filename: str) -> str:
    """Replaces spaces with underscores and removes potentially problematic characters."""
    sanitized = filename.replace(' ', '_')
    sanitized = re.sub(r'[^\w.-]', '', sanitized)
    sanitized = sanitized.strip('._-')
    if not sanitized:
        sanitized = "sanitized_file"
    return sanitized

# --- Helper function for PDF service call (keep as is) ---
async def call_pdf_service_upload(file: UploadFile, title: Optional[str]):
    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL environment variable is not set.")
        raise HTTPException(status_code=500, detail="PDF processing service URL is not configured.")

    pdf_service_upload_url = f"{PDF_CLIENT_URL}/process-pdf"
    logger.info(f"Forwarding PDF to PDF service at {pdf_service_upload_url}")

    file_content = await file.read()
    files = {'file': (file.filename, file_content, file.content_type)}
    data = {'title': title} if title else {}

    try:
        def send_to_pdf_service():
            response = requests.post(pdf_service_upload_url, files=files, data=data)
            response.raise_for_status()
            return response.json()

        response_data = await run_in_threadpool(send_to_pdf_service)
        logger.info(f"Received response from PDF service upload: {response_data}")
        return response_data

    except requests.exceptions.RequestException as e:
        logger.error(f"Error connecting to PDF service during upload: {e}")
        raise HTTPException(status_code=503, detail=f"Could not connect to PDF processing service: {e}")
    except Exception as e:
        logger.error(f"Error in PDF service call: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error calling PDF service: {e}")


@router.post("/upload", response_model=Book)
async def upload_pdf(
    file: UploadFile = File(...),
    title: str = Form(None)
):
    """
    Uploads a PDF file, sends it to the processing service to start background processing,
    saves the initial book record with job_id and status, and returns the book data.
    """
    logger.info(f"Received upload request for file: {file.filename}")
    try:
        processed_data = await call_pdf_service_upload(file, title)

        if not processed_data or not processed_data.get("success"):
             error_detail = processed_data.get("message", "PDF processing initiation failed")
             logger.error(f"PDF service initiation failed: {error_detail}")
             raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=error_detail)

        job_id = processed_data.get("job_id")
        initial_status = processed_data.get("status", "pending")

        if not job_id:
            logger.error("PDF service did not return a job_id.")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="PDF processing service failed to return a job ID.")

        book_title = title if title else os.path.splitext(file.filename)[0]
        sanitized_book_title = sanitize_filename(book_title)

        # --- Prepare data using the Book model structure, matching DB schema ---
        book_to_save = Book(
            title=book_title,
            original_filename=file.filename,
            job_id=job_id,
            sanitized_title=sanitized_book_title,
            status=initial_status,
            # Use field names matching DB schema
            markdown_filename=None, # Initialize as None
            image_filenames=[], # Initialize as empty list
            processing_error=None, # Use processing_error as per DB schema
            # created_at and updated_at will be set by default_factory or DB
            id=None # Explicitly set to None or omit if using default=None in model
        )

        # Convert model to dict for saving, excluding unset/None fields and handling alias
        save_data = book_to_save.model_dump(by_alias=True, exclude_none=True)

        logger.info(f"Upload endpoint: Data prepared for DB save: {save_data}")

        # Save the initial book record
        inserted_id_str = await save_book(save_data)
        if not inserted_id_str:
             logger.error("Failed to save initial book record to database.")
             raise HTTPException(status_code=500, detail="Failed to save initial book record.")

        logger.info(f"Book saved with ID: {inserted_id_str}")

        # --- Return the newly created book record ---
        # Fetch the created book data to ensure consistency and include generated _id/timestamps
        created_book_doc = await get_book(inserted_id_str)
        if not created_book_doc:
             logger.error(f"Failed to retrieve created book record with ID: {inserted_id_str}")
             raise HTTPException(status_code=500, detail="Failed to retrieve created book record.")

        # Convert the retrieved document back to the Book model for response
        try:
            response_book = Book.model_validate(created_book_doc)
        except Exception as validation_error:
            logger.error(f"Upload endpoint: Failed to validate retrieved book data for ID {inserted_id_str}: {validation_error}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to validate created book data.")

        logger.info(f"Upload endpoint: Returning initial book data for ID {inserted_id_str}")
        return response_book

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Unexpected error during PDF upload: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"An unexpected error occurred during upload: {e}")


@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database.
    Explicitly constructs response dictionaries with 'id' as string.
    """
    logger.info("Received request to list all books")
    try:
        # Update projection to match DB schema field names
        projection = {
            "_id": 1,
            "title": 1,
            "original_filename": 1,
            "status": 1,
            "job_id": 1,
            "sanitized_title": 1,
            # Use field names matching DB schema
            "markdown_filename": 1,
            "image_filenames": 1,
            "created_at": 1, # Use created_at
            "updated_at": 1, # Use updated_at
            "processing_error": 1 # Use processing_error
        }

        books_docs = await get_books(projection=projection)
        logger.info(f"Fetched {len(books_docs)} book documents from DB.")

        response_list = []
        for book_doc in books_docs:
            if '_id' in book_doc and isinstance(book_doc['_id'], ObjectId):
                book_id_str = str(book_doc['_id'])
            elif '_id' in book_doc and isinstance(book_doc['_id'], str):
                 book_id_str = book_doc['_id']
            else:
                logger.warning(f"Skipping book document due to missing or invalid _id: {book_doc}")
                continue

            # Explicitly create the dictionary for the response
            # Map fields from book_doc to the structure expected by the Book model (and frontend)
            response_item = {
                "id": book_id_str, # Use the string ID here
                "title": book_doc.get("title"),
                "original_filename": book_doc.get("original_filename"),
                "status": book_doc.get("status"),
                "job_id": book_doc.get("job_id"),
                "sanitized_title": book_doc.get("sanitized_title"),
                # Use field names matching DB schema
                "markdown_filename": book_doc.get("markdown_filename"),
                "image_filenames": book_doc.get("image_filenames", []),
                "created_at": book_doc.get("created_at"), # Use created_at
                "updated_at": book_doc.get("updated_at"), # Use updated_at
                "processing_error": book_doc.get("processing_error"), # Use processing_error
                # Response-only fields are not needed here, set to defaults
                "markdown_content": None,
                "image_urls": []
            }
            # Optional: Validate this dictionary against the Book model if desired
            # try:
            #     Book.model_validate(response_item)
            # except Exception as validation_error:
            #     logger.warning(f"Skipping book due to validation error on constructed dict: {validation_error}. Data: {response_item}", exc_info=True)
            #     continue

            response_list.append(response_item)

        logger.info(f"Returning list of {len(response_list)} processed book dictionaries.")
        return response_list

    except Exception as e:
        logger.error(f"Error listing books: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error retrieving books: {e}")


@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str):
    """
    Retrieves book data by its ID, reads markdown content from file if available.
    """
    logger.info(f"Received request for book ID: {book_id}")

    book_data_doc = await get_book(book_id) # Fetches the raw document (dict)

    if not book_data_doc:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

    # Convert raw doc to Book model to work with typed fields
    try:
        book = Book.model_validate(book_data_doc)
    except Exception as validation_error:
         logger.error(f"Failed to validate book data from DB for ID {book_id}: {validation_error}", exc_info=True)
         raise HTTPException(status_code=500, detail="Invalid book data found in database.")

    markdown_content = None
    image_urls = []

    # Only attempt to read/generate if processing is completed and markdown_filename exists
    # FIX: Use book.markdown_filename
    if book.status == 'completed' and book.markdown_filename:
        # Construct the full path to the markdown file on the container's filesystem
        # Join the container mount path with the filename stored in the DB
        # FIX: Use book.markdown_filename
        container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)
        logger.info(f"Get endpoint: Constructed container markdown path: {container_markdown_path}")

        # Use run_in_threadpool for synchronous os.path.exists and file read
        def check_and_read_markdown(path):
            if os.path.exists(path):
                logger.info(f"Get endpoint: Markdown file found at {path}. Reading...")
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                        logger.info(f"Get endpoint: Successfully read markdown (length: {len(content)}) from {path}")
                        return content
                except Exception as file_read_error:
                    logger.error(f"Get endpoint: Failed to read markdown file {path}: {file_read_error}", exc_info=True)
                    return f"Error: Could not read processed content. {file_read_error}"
            else:
                logger.error(f"Get endpoint: Markdown file not found at container path: {path}")
                return "Error: Processed content file not found."

        markdown_content = await run_in_threadpool(check_and_read_markdown, container_markdown_path)

    # Generate image URLs from stored filenames
    # FIX: Use book.image_filenames
    if book.status == 'completed' and book.image_filenames: # Only generate URLs if completed and filenames exist
         # Convert server-side filenames to public URLs using the image static route prefix
         # Join the container mount path with the filename for the static server to find it
         image_urls = [f"/images/{filename}" for filename in book.image_filenames]
         logger.info(f"Get endpoint: Generated {len(image_urls)} image URLs.")
    elif book.status == 'completed' and not book.image_filenames:
         logger.info(f"Get endpoint: Book ID {book_id} completed but no image filenames stored.")
    elif book.status != 'completed':
         logger.info(f"Get endpoint: Book status is '{book.status}'. Not reading markdown or generating image URLs.")


    # Populate the response-only fields in the model instance
    book.markdown_content = markdown_content
    book.image_urls = image_urls

    logger.info(f"Get endpoint: Returning book data for ID {book_id}")
    return book # Return the populated Book model instance


@router.get("/status/{job_id}")
async def get_book_status_by_job_id(job_id: str) -> Dict[str, Any]:
    """
    Proxies the status check request to the PDF processing service
    and updates the book record in the database if processing is complete.
    Returns the PDF service's status response.
    """
    logger.info(f"Received status check request for job_id: {job_id}. Proxying to PDF service.")

    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL environment variable is not set.")
        raise HTTPException(status_code=500, detail="PDF processing service URL is not configured.")

    pdf_service_status_url = f"{PDF_CLIENT_URL}/status/{job_id}"
    logger.info(f"Proxying status request to: {pdf_service_status_url}")

    # Fetch the book record first to get the book_id and current status
    book_doc = await get_book_by_job_id(job_id)
    book_id_str = str(book_doc["_id"]) if book_doc and "_id" in book_doc else None
    current_db_status = book_doc.get("status", "unknown") if book_doc else "unknown"
    book_title = book_doc.get("title", "Unknown Title") if book_doc else "Unknown Title" # Get title for response

    if not book_doc:
         logger.warning(f"Status check: Book record with job_id {job_id} not found in DB.")
         # We can still try to get status from PDF service, but won't update DB

    try:
        def get_status_from_pdf_service():
            response = requests.get(pdf_service_status_url)
            response.raise_for_status()
            return response.json()

        pdf_service_response = await run_in_threadpool(get_status_from_pdf_service)
        logger.info(f"Received status response from PDF service for job {job_id}: {pdf_service_response}")

        # --- Update DB based on PDF service response ---
        pdf_service_status = pdf_service_response.get("status")

        # Only update if we found a book record and the PDF service status is 'completed' or 'failed'
        # and the DB status is not already completed/failed
        if book_doc and pdf_service_status in ["completed", "failed"] and current_db_status not in ["completed", "failed"]:
            logger.info(f"PDF service reported status '{pdf_service_status}' for job {job_id}. Updating DB record {book_id_str}.")

            update_data = {
                "status": pdf_service_status,
                # Use updated_at for completion timestamp as per DB schema
                "updated_at": datetime.utcnow(), # Update timestamp on completion/failure
                # Use processing_error as per DB schema
                "processing_error": pdf_service_response.get("message") if pdf_service_status == "failed" else None,
                # Store the file paths/filenames returned by the PDF service
                # The PDF service returns 'file_path' (full path) and 'images' (list of dicts with 'path').
                # We need to extract just the filenames or store the full paths depending on DB schema.
                # The DB schema shows 'markdown_filename' and 'image_filenames'.
                # Let's assume the PDF service returns full paths, and we store just the basename (filename).
                # If the PDF service *already* returns just the filename, this is simpler.
                # Based on pdf_service/app.py, it saves to MARKDOWN_PATH/sanitized_title.md
                # and IMAGES_PATH/sanitized_title_img_XYZ.png. It returns the full path.
                # So we should store the basename.
                "markdown_filename": os.path.basename(pdf_service_response.get("file_path")) if pdf_service_response.get("file_path") else None, # Store just the filename
                # The PDF service returns a list of dicts with 'filename' and 'path'.
                # We need to store the 'filename' for each image as per DB schema.
                "image_filenames": [img_info.get("filename") for img_info in pdf_service_response.get("images", []) if img_info.get("filename")] # Store image filenames from PDF service
            }
            # Remove None values from update_data to avoid overwriting existing data with None
            update_data = {k: v for k, v in update_data.items() if v is not None}

            updated = await update_book(book_id_str, update_data)
            if updated:
                logger.info(f"Successfully updated book {book_id_str} status to '{pdf_service_status}'.")
            else:
                logger.error(f"Failed to update book {book_id_str} status to '{pdf_service_status}' despite PDF service completion.")
        elif book_doc and pdf_service_status == "processing" and current_db_status == "pending":
             logger.info(f"PDF service reported status '{pdf_service_status}' for job {job_id}. Updating DB record {book_id_str} from '{current_db_status}'.")
             update_data = {"status": "processing", "updated_at": datetime.utcnow()} # Also update updated_at
             updated = await update_book(book_id_str, update_data)
             if updated:
                 logger.info(f"Successfully updated book {book_id_str} status to 'processing'.")
             else:
                 logger.error(f"Failed to update book {book_id_str} status to 'processing'.")
        else:
            logger.info(f"PDF service status '{pdf_service_status}' for job {job_id} does not require DB update (DB status is '{current_db_status}' or book not found).")

        # --- Return the PDF service response directly to the frontend ---
        return pdf_service_response

    except requests.exceptions.RequestException as e:
        logger.error(f"Error connecting to PDF service during status check for job {job_id}: {e}")
        # Return a simulated 'failed' status if the PDF service is unreachable
        # Include book title if we found the book record earlier
        return {
            "success": False,
            "message": f"Could not connect to PDF processing service for status check: {e}",
            "job_id": job_id,
            "status": "failed", # Report as failed from backend perspective
            "title": book_title, # Use the title fetched earlier
            "file_path": None, # PDF service returns file_path, keep this key for frontend
            "images": [] # PDF service returns images, keep this key for frontend
        }
    except Exception as e:
        logger.error(f"Error during PDF service status check for job {job_id}: {e}", exc_info=True)
        # Return a simulated 'failed' status for other errors
        # Include book title if we found the book record earlier
        return {
            "success": False,
            "message": f"Error checking PDF service status: {e}",
            "job_id": job_id,
            "status": "failed", # Report as failed from backend perspective
            "title": book_title, # Use the title fetched earlier
            "file_path": None, # PDF service returns file_path, keep this key for frontend
            "images": [] # PDF service returns images, keep this key for frontend
        }

# ... (rest of the file) ...
