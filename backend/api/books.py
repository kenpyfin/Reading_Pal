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
CONTAINER_IMAGES_PATH = os.getenv("IMAGES_PATH", "/app/storage/images")
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH", "/app/storage/markdown")

logger.info(f"API Books: CONTAINER_IMAGES_PATH = {CONTAINER_IMAGES_PATH}")
logger.info(f"API Books: CONTAINER_MARKDOWN_PATH = {CONTAINER_MARKDOWN_PATH}")

# Get PDF Service URL from environment variables
PDF_CLIENT_URL = os.getenv("PDF_CLIENT_URL")
if not PDF_CLIENT_URL:
    logger.error("PDF_CLIENT_URL environment variable is not set.")
    # Handle as needed, maybe raise on startup or per request

# --- Add helper function for sanitizing filenames ---
def sanitize_filename(filename: str) -> str:
    """Replaces spaces with underscores and removes potentially problematic characters."""
    # Replace spaces with underscores
    sanitized = filename.replace(' ', '_')
    # Remove characters that are not alphanumeric, underscores, hyphens, or periods
    # Keep periods for file extensions
    sanitized = re.sub(r'[^\w.-]', '', sanitized)
    # Optional: Limit length or handle leading/trailing periods/underscores
    # Remove leading/trailing periods/underscores that might cause issues
    sanitized = sanitized.strip('._-')
    # Ensure filename is not empty after sanitization
    if not sanitized:
        # Fallback to a generic name if sanitization results in empty string
        sanitized = "sanitized_file"
    return sanitized

# --- Helper function (optional) for PDF service call ---
async def call_pdf_service_upload(file: UploadFile, title: Optional[str]):
    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL environment variable is not set.")
        raise HTTPException(status_code=500, detail="PDF processing service URL is not configured.")

    pdf_service_upload_url = f"{PDF_CLIENT_URL}/process-pdf"
    logger.info(f"Forwarding PDF to PDF service at {pdf_service_upload_url}")

    # Read file content once
    file_content = await file.read()
    # Reset pointer if needed, though reading again shouldn't be necessary
    # await file.seek(0)

    # Prepare file data for the PDF service request
    files = {'file': (file.filename, file_content, file.content_type)}
    data = {'title': title} if title else {} # Pass title only if provided

    try:
        # Use run_in_threadpool for the synchronous requests call
        def send_to_pdf_service():
            response = requests.post(pdf_service_upload_url, files=files, data=data)
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
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
    title: str = Form(None) # Use Form for title when sending multipart/form-data
):
    """
    Uploads a PDF file, sends it to the processing service to start background processing,
    saves the initial book record with job_id and status, and returns the book data.
    """
    logger.info(f"Received upload request for file: {file.filename}")
    try:
        # Call the PDF service to initiate processing
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
        # --- Generate sanitized title ---
        sanitized_book_title = sanitize_filename(book_title) # <<< ADD THIS LINE

        # --- Prepare data using the Book model structure ---
        # Include all fields defined in the model, initializing appropriately
        book_to_save = Book(
            title=book_title,
            original_filename=file.filename,
            job_id=job_id,
            sanitized_title=sanitized_book_title, # <<< ADD THIS FIELD
            status=initial_status,
            # FIX: Use correct field names from the Book model
            markdown_filepath=None, # Initialize as None
            image_filepaths=[], # Initialize as empty list
            error_message=None, # Use error_message as per model
            # Timestamps will be added by default_factory or save_book
            # Response-only fields are not included here
            id=None # Explicitly set to None or omit if using default=None in model
        )

        # Convert model to dict for saving, excluding unset/None fields and handling alias
        # Use exclude_none=True to avoid saving fields that are None initially
        # FIX: Ensure model_dump correctly maps 'id' alias '_id' for saving
        # Pydantic v2 model_dump(by_alias=True) should handle this.
        save_data = book_to_save.model_dump(by_alias=True, exclude_none=True)

        logger.info(f"Upload endpoint: Data prepared for DB save: {save_data}")

        # Save the initial book record
        # Assuming save_book handles inserting the document and returns the string ID
        inserted_id_str = await save_book(save_data)
        if not inserted_id_str:
             logger.error("Failed to save initial book record to database.")
             raise HTTPException(status_code=500, detail="Failed to save initial book record.")

        logger.info(f"Book saved with ID: {inserted_id_str}")

        # --- Return the newly created book record ---
        # Fetch the created book data to ensure consistency and include generated _id/timestamps
        # get_book returns the raw document (dict)
        created_book_doc = await get_book(inserted_id_str)
        if not created_book_doc:
             logger.error(f"Failed to retrieve created book record with ID: {inserted_id_str}")
             raise HTTPException(status_code=500, detail="Failed to retrieve created book record.")

        # Convert the retrieved document back to the Book model for response
        # Pydantic model_validate should handle the _id alias and ObjectId conversion
        # No need to manually stringify _id here if model_validate is used correctly
        try:
            response_book = Book.model_validate(created_book_doc)
        except Exception as validation_error:
            logger.error(f"Upload endpoint: Failed to validate retrieved book data for ID {inserted_id_str}: {validation_error}", exc_info=True)
            # Return the raw doc or raise error depending on desired strictness
            # For now, raise error as response_model=Book expects a valid Book instance
            raise HTTPException(status_code=500, detail="Failed to validate created book data.")


        logger.info(f"Upload endpoint: Returning initial book data for ID {inserted_id_str}")
        return response_book # Return the validated Book model instance


@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database.
    Explicitly constructs response dictionaries with 'id' as string.
    """
    logger.info("Received request to list all books")
    try:
        # Projection remains the same
        projection = {
            "_id": 1,
            "title": 1,
            "original_filename": 1,
            "status": 1,
            "job_id": 1,
            "upload_timestamp": 1, # Use upload_timestamp
            "completion_timestamp": 1, # Use completion_timestamp
            "error_message": 1, # Use error_message
            "sanitized_title": 1, # Include if projected/needed
            "markdown_filepath": 1, # Include if projected/needed
            "image_filepaths": 1 # Include if projected/needed
        }

        books_docs = await get_books(projection=projection)
        logger.info(f"Fetched {len(books_docs)} book documents from DB.")

        # --- START CHANGE ---
        response_list = []
        for book_doc in books_docs:
            # Ensure _id exists and convert it
            if '_id' in book_doc and isinstance(book_doc['_id'], ObjectId):
                book_id_str = str(book_doc['_id'])
            elif '_id' in book_doc and isinstance(book_doc['_id'], str):
                 # If it's already a string for some reason, use it
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
                "upload_timestamp": book_doc.get("upload_timestamp"), # Use upload_timestamp
                "completion_timestamp": book_doc.get("completion_timestamp"), # Use completion_timestamp
                "error_message": book_doc.get("error_message"), # Use error_message
                "sanitized_title": book_doc.get("sanitized_title"), # Include if projected/needed
                # FIX: Use correct field names from the Book model
                "markdown_filepath": book_doc.get("markdown_filepath"), # Use markdown_filepath
                "image_filepaths": book_doc.get("image_filepaths", []), # Use image_filepaths
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
        # Return the list of dictionaries. FastAPI still uses response_model=List[Book] to validate that each dictionary in the list conforms to the Book model structure (including the presence of the `id` field) and for generating OpenAPI docs, but it serializes the list of dictionaries directly, avoiding potential issues with serializing aliased model fields.
        return response_list
        # --- END CHANGE ---

    except Exception as e:
        logger.error(f"Error listing books: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error retrieving books: {e}")


@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str):
    """
    Retrieves book data by its ID, reads markdown content from file if available.
    """
    logger.info(f"Received request for book ID: {book_id}")
    # Validation happens implicitly in get_book when converting to ObjectId

    book_data_doc = await get_book(book_id) # Fetches the raw document (dict)

    if not book_data_doc:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

    # Convert raw doc to Book model to work with typed fields
    # Ensure _id is handled correctly for Pydantic model instantiation
    # No need to manually stringify _id here if model_validate is used
    try:
        book = Book.model_validate(book_data_doc)
    except Exception as validation_error:
         logger.error(f"Failed to validate book data from DB for ID {book_id}: {validation_error}", exc_info=True)
         raise HTTPException(status_code=500, detail="Invalid book data found in database.")


    markdown_content = None
    image_urls = []

    # Only attempt to read/generate if processing is completed and filepaths exist
    # FIX: Use book.markdown_filepath
    if book.status == 'completed' and book.markdown_filepath:
        # Construct the full path to the markdown file on the container's filesystem
        # Use os.path.basename() to get just the filename part from the stored path
        # FIX: Use book.markdown_filepath
        container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, os.path.basename(book.markdown_filepath))
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

        # Generate image URLs from stored filepaths
        # FIX: Use book.image_filepaths
        if book.image_filepaths:
             # Convert server-side filepaths to public URLs using basename
             image_urls = [f"/images/{os.path.basename(fp)}" for fp in book.image_filepaths]
             logger.info(f"Get endpoint: Generated {len(image_urls)} image URLs.")
        else:
             logger.info(f"Get endpoint: No image filepaths stored for completed book ID {book_id}.")

    elif book.status != 'completed':
         logger.info(f"Get endpoint: Book status is '{book.status}'. Not reading markdown or generating image URLs.")
         # Optionally provide status message in content
         # markdown_content = f"Book status: {book.status}. Content not available."

    # Populate the response-only fields in the model instance
    book.markdown_content = markdown_content
    book.image_urls = image_urls

    logger.info(f"Get endpoint: Returning book data for ID {book_id}")
    return book # Return the populated Book model instance


@router.get("/status/{job_id}")
# Remove response_model=StatusResponse if it exists, return dict directly
# The PDF service returns a dict, so we should return a dict.
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
        # Use run_in_threadpool for the synchronous requests call
        def get_status_from_pdf_service():
            response = requests.get(pdf_service_status_url)
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
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
                "completion_timestamp": datetime.utcnow() if pdf_service_status == "completed" else None,
                "error_message": pdf_service_response.get("message") if pdf_service_status == "failed" else None,
                # Store the file paths returned by the PDF service
                # FIX: Use correct field names from the Book model
                "markdown_filepath": pdf_service_response.get("file_path"), # Store the path from PDF service
                # The PDF service returns a list of dicts with 'filename' and 'path'.
                # We need to store the 'path' for each image.
                "image_filepaths": [img_info.get("path") for img_info in pdf_service_response.get("images", []) if img_info.get("path")] # Store image paths from PDF service
            }
            # Remove None values from update_data to avoid overwriting existing data with None
            update_data = {k: v for k, v in update_data.items() if v is not None}

            updated = await update_book(book_id_str, update_data)
            if updated:
                logger.info(f"Successfully updated book {book_id_str} status to '{pdf_service_status}'.")
            else:
                logger.error(f"Failed to update book {book_id_str} status to '{pdf_service_status}' despite PDF service completion.")
        elif book_doc and pdf_service_status == "processing" and current_db_status == "pending":
             # Optionally update DB status from pending to processing if PDF service reports processing
             logger.info(f"PDF service reported status '{pdf_service_status}' for job {job_id}. Updating DB record {book_id_str} from '{current_db_status}'.")
             update_data = {"status": "processing"}
             updated = await update_book(book_id_str, update_data)
             if updated:
                 logger.info(f"Successfully updated book {book_id_str} status to 'processing'.")
             else:
                 logger.error(f"Failed to update book {book_id_str} status to 'processing'.")
        else:
            logger.info(f"PDF service status '{pdf_service_status}' for job {job_id} does not require DB update (DB status is '{current_db_status}' or book not found).")


        # --- Return the PDF service response directly to the frontend ---
        # The frontend expects the PDF service's status format
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
            "file_path": None,
            "images": []
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
            "file_path": None,
            "images": []
        }

# ... (rest of the file) ...
