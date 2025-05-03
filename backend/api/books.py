# backend/api/books.py

# Add necessary imports at the top
import asyncio # Import asyncio
import os
import logging
import requests
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
            markdown_filename=None, # Initialize as None
            image_filenames=[], # Initialize as empty list
            processing_error=None, # Initialize as None
            # Timestamps will be added by default_factory or save_book
            # Response-only fields are not included here
            id=None # Explicitly set to None or omit if using default=None in model
        )

        # Convert model to dict for saving, excluding unset/None fields and handling alias
        # Use exclude_none=True to avoid saving fields that are None initially
        save_data = book_to_save.model_dump(by_alias=True, exclude_none=True)

        logger.info(f"Upload endpoint: Data prepared for DB save: {save_data}")

        # Save the initial book record
        inserted_id_str = await save_book(save_data) # save_book returns string ID or None
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

        # --- FIX: Convert ObjectId to string before Pydantic validation ---
        if '_id' in created_book_doc:
            created_book_doc['_id'] = str(created_book_doc['_id'])
        # --- END FIX ---

        # Convert the retrieved document back to the Book model for response
        # Pydantic should now handle the string _id alias correctly
        response_book = Book(**created_book_doc)

        logger.info(f"Upload endpoint: Returning initial book data for ID {inserted_id_str}")
        return response_book

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload initiation: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error during upload: {e}")


@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database.
    Response includes basic info, status, and job_id.
    """
    logger.info("Received request to list all books")
    try:
        # Define projection for list view (optional, but good practice)
        projection = {
            "title": 1,
            "original_filename": 1,
            "status": 1,
            "job_id": 1,
            "created_at": 1, # Include timestamps if desired
            "updated_at": 1,
            "processing_error": 1 # Include error status in list view
            # Exclude large fields like markdown_filename, image_filenames
        }
        # Use the new get_books function
        books_docs = await get_books(projection=projection)

        response_list = []
        for book_doc in books_docs:
             # Convert the document to the Book model
             # Pydantic handles the _id alias and default values for missing fields
             try:
                 # Ensure _id is stringified if needed (get_books returns dicts)
                 if '_id' in book_doc and not isinstance(book_doc['_id'], str):
                      book_doc['_id'] = str(book_doc['_id'])
                 # Set response-only fields to default for list view
                 book_doc['markdown_content'] = None
                 book_doc['image_urls'] = []
                 response_list.append(Book(**book_doc))
             except Exception as validation_error:
                 logger.warning(f"Skipping book due to validation error: {validation_error}. Data: {book_doc}")


        logger.info(f"Returning list of {len(response_list)} books.")
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
    # Validation happens implicitly in get_book when converting to ObjectId

    book_data_doc = await get_book(book_id) # Fetches the raw document (dict)

    if not book_data_doc:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

    # Convert raw doc to Book model to work with typed fields
    # Ensure _id is handled correctly for Pydantic model instantiation
    if '_id' in book_data_doc:
         book_data_doc['_id'] = str(book_data_doc['_id']) # Ensure ID is string for model

    try:
        book = Book(**book_data_doc)
    except Exception as validation_error:
         logger.error(f"Failed to validate book data from DB for ID {book_id}: {validation_error}", exc_info=True)
         raise HTTPException(status_code=500, detail="Invalid book data found in database.")


    markdown_content = None
    image_urls = []

    # Only attempt to read/generate if processing is completed and filenames exist
    if book.status == 'completed' and book.markdown_filename:
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
        if book.image_filenames:
             image_urls = [f"/images/{filename}" for filename in book.image_filenames]
             logger.info(f"Get endpoint: Generated {len(image_urls)} image URLs.")
        else:
             logger.info(f"Get endpoint: No image filenames stored for completed book ID {book_id}.")

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
async def get_book_status_by_job_id(job_id: str) -> Dict[str, Any]:
    """
    Checks processing status by looking for the expected output markdown file
    based on the sanitized title stored in the database. Updates DB if file found.
    Returns a dictionary simulating the PDF service status response.
    """
    logger.info(f"Received status check request for job_id: {job_id} (using file check)")

    # --- Get Book Record ---
    book_doc = await get_book_by_job_id(job_id)
    if not book_doc:
        logger.warning(f"File Check Status: Book record with job_id {job_id} not found in DB.")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job ID {job_id} not associated with any known book.")

    # Convert raw doc to Book model to work with typed fields (optional, but good for type safety)
    # Ensure _id is stringified if needed (get_book_by_job_id returns dict)
    if '_id' in book_doc and not isinstance(book_doc['_id'], str):
         book_doc['_id'] = str(book_doc['_id'])
    try:
        book = Book(**book_doc)
    except Exception as validation_error:
         logger.error(f"Failed to validate book data from DB for job ID {job_id}: {validation_error}", exc_info=True)
         # Log error but continue with raw doc if validation fails
         book = None # Indicate model validation failed

    current_db_status = book_doc.get("status", "unknown")
    book_id_str = str(book_doc["_id"])
    book_title = book_doc.get("title", "Unknown Title") # Get title for response

    logger.info(f"File Check Status: Found book {book_id_str}, current DB status: '{current_db_status}'")

    # --- If already completed or failed, return status from DB ---
    if current_db_status in ["completed", "failed"]:
        logger.info(f"File Check Status: Status for job {job_id} is already '{current_db_status}'. Returning stored status.")
        # Simulate the PDF service response structure
        return {
            "success": current_db_status == "completed",
            "message": book_doc.get("processing_error") if current_db_status == "failed" else "Processing complete (retrieved from DB)",
            "job_id": job_id,
            "status": current_db_status,
            "title": book_title,
            # Include filenames if completed
            "file_path": os.path.join(CONTAINER_MARKDOWN_PATH, book_doc.get("markdown_filename")) if current_db_status == "completed" and book_doc.get("markdown_filename") else None,
            "images": [{"filename": fname, "path": os.path.join(CONTAINER_IMAGES_PATH, fname)} for fname in book_doc.get("image_filenames", [])] if current_db_status == "completed" else []
        }

    # --- If pending/processing, check for the output file ---
    sanitized_title_from_db = book_doc.get("sanitized_title")
    if not sanitized_title_from_db:
        logger.error(f"File Check Status: Cannot check file for job {job_id} because 'sanitized_title' is missing in the database record.")
        # Return current status, cannot proceed with file check
        return {
            "success": False,
            "message": "Cannot determine completion status: sanitized title missing.",
            "job_id": job_id,
            "status": current_db_status,
            "title": book_title,
            "file_path": None,
            "images": []
        }

    expected_md_filename = f"{sanitized_title_from_db}.md"
    expected_md_path = os.path.join(CONTAINER_MARKDOWN_PATH, expected_md_filename)
    image_prefix = sanitized_title_from_db # Images start with the sanitized title

    logger.info(f"File Check Status: Checking for markdown file: {expected_md_path}")
    logger.info(f"File Check Status: Checking for images with prefix '{image_prefix}' in {CONTAINER_IMAGES_PATH}")

    # --- Perform file system checks in threadpool ---
    def check_files_exist(md_path_to_check, img_dir_to_check, img_prefix_to_check):
        md_exists = os.path.exists(md_path_to_check)
        found_images = []
        if md_exists: # Only look for images if markdown exists (assumption: md is written last or concurrently)
             try:
                 if os.path.exists(img_dir_to_check) and os.path.isdir(img_dir_to_check):
                     for item in os.listdir(img_dir_to_check):
                         # Check prefix and common image extensions (adjust as needed)
                         if item.startswith(img_prefix_to_check) and item.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
                             found_images.append(item)
             except Exception as list_dir_error:
                 logger.error(f"File Check Status: Error listing image directory {img_dir_to_check}: {list_dir_error}", exc_info=True)
                 # Continue without images if listing fails
        return md_exists, found_images

    try:
        markdown_exists, image_filenames_found = await run_in_threadpool(
            check_files_exist, expected_md_path, CONTAINER_IMAGES_PATH, image_prefix
        )
    except Exception as check_error:
        logger.error(f"File Check Status: Error during file system check for job {job_id}: {check_error}", exc_info=True)
        # Return current status if check fails
        return {
            "success": False,
            "message": f"Error checking file status: {check_error}",
            "job_id": job_id,
            "status": current_db_status,
            "title": book_title,
            "file_path": None,
            "images": []
        }

    # --- Process check results ---
    if markdown_exists:
        logger.info(f"File Check Status: Markdown file found for job {job_id}. Found {len(image_filenames_found)} associated image(s). Marking as completed.")
        # Update DB to completed status
        update_data = {
            "status": "completed",
            "markdown_filename": expected_md_filename,
            "image_filenames": image_filenames_found,
            "processing_error": None # Clear any previous potential error
        }
        updated = await update_book(book_id_str, update_data)
        if not updated:
            logger.error(f"File Check Status: Found markdown file, but failed to update book status in DB for {book_id_str}.")
            # Return 'completed' status anyway, but log the DB error
            return {
                "success": True, # File exists, so processing likely succeeded
                "message": "Processing complete (file found), but DB update failed.",
                "job_id": job_id,
                "status": "completed",
                "title": book_title,
                "file_path": expected_md_path, # Return container path
                "images": [{"filename": fname, "path": os.path.join(CONTAINER_IMAGES_PATH, fname)} for fname in image_filenames_found]
            }
        else:
             logger.info(f"File Check Status: Successfully updated book {book_id_str} status to completed.")
             # Return 'completed' status
             return {
                "success": True,
                "message": "Processing complete (file found).",
                "job_id": job_id,
                "status": "completed",
                "title": book_title,
                "file_path": expected_md_path, # Return container path
                "images": [{"filename": fname, "path": os.path.join(CONTAINER_IMAGES_PATH, fname)} for fname in image_filenames_found]
            }
    else:
        # Markdown file not found, assume still processing (or failed, which we can't detect)
        logger.info(f"File Check Status: Markdown file not found for job {job_id}. Assuming status is still '{current_db_status}'.")
        return {
            "success": False,
            "message": f"Processing status is '{current_db_status}'. Output file not found yet.",
            "job_id": job_id,
            "status": current_db_status, # Return the status currently in the DB
            "title": book_title,
            "file_path": None,
            "images": []
        }

# ... (rest of the file: list_books, get_book_by_id) ...
