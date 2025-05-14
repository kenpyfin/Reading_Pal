# backend/api/books.py

# Add necessary imports at the top
import asyncio # Import asyncio
import os
import logging
import requests # Import requests
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status, Body
from typing import List, Optional, Dict, Any 
from bson import ObjectId # Keep ObjectId import
from bson.errors import InvalidId # Import InvalidId
from fastapi.concurrency import run_in_threadpool
from datetime import datetime 
import re 
from pydantic import BaseModel, Field 

from backend.models.book import Book
from backend.db.mongodb import (
    save_book,
    get_book,
    get_books, 
    get_book_by_job_id, 
    update_book, 
    delete_book_record, # Add delete_book_record
    get_database
)

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
        # REMOVE id=None from the constructor
        book_to_save = Book(
            title=book_title,
            original_filename=file.filename,
            job_id=job_id,
            sanitized_title=sanitized_book_title,
            status=initial_status,
            markdown_filename=None,
            image_filenames=[],
            processing_error=None,
            # REMOVE THIS LINE: id=None
        )

        # Convert model to dict for saving, excluding unset/None fields and handling alias
        # model_dump(by_alias=True, exclude_none=True) will produce a dict without _id
        # since id was not explicitly set and exclude_none=True is used.
        save_data = book_to_save.model_dump(by_alias=True, exclude_none=True)

        logger.info(f"Upload endpoint: Data prepared for DB save: {save_data}")

        # Save the initial book record
        # save_book should insert the document and MongoDB will add the _id
        inserted_id_str = await save_book(save_data)
        if not inserted_id_str:
             logger.error("Failed to save initial book record to database.")
             raise HTTPException(status_code=500, detail="Failed to save initial book record.")

        logger.info(f"Book saved with ID: {inserted_id_str}")

        # --- Return the newly created book record ---
        # Fetch the created book data to ensure consistency and include generated _id/timestamps
        # get_book will retrieve the document *with* the _id
        created_book_doc = await get_book(inserted_id_str)
        if not created_book_doc:
             logger.error(f"Failed to retrieve created book record with ID: {inserted_id_str}")
             raise HTTPException(status_code=500, detail="Failed to retrieve created book record.")

        # Convert the retrieved document back to the Book model for response
        # model_validate will handle the _id alias and ObjectId conversion correctly now
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
    Retrieves a list of all books, excluding those with 'failed' status.
    """
    logger.info("Fetching list of books (excluding failed)...")
    try:
        # Define the projection to fetch only necessary fields
        projection = {
            "_id": 1,
            "title": 1,
            "original_filename": 1,
            "status": 1,
            "job_id": 1,
            "sanitized_title": 1,
            "markdown_filename": 1,
            "image_filenames": 1,
            "created_at": 1,
            "updated_at": 1,
            "processing_error": 1
        }

        # Call get_books with a filter to exclude status 'failed' and include the projection
        books_docs = await get_books(filter={"status": {"$ne": "failed"}}, projection=projection)

        logger.info(f"Fetched {len(books_docs)} book documents from DB (excluding failed).")

        response_list = []
        for book_doc in books_docs:
            # Ensure _id is present and convert ObjectId to string for the 'id' field in the response
            if '_id' in book_doc:
                book_id_str = str(book_doc['_id'])
            else:
                logger.warning(f"Skipping book document due to missing _id: {book_doc}")
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

    # --- REMOVE LOGGING for book.processed_images_info ---
    # logger.info(f"Get endpoint: Book ID {book_id} - processed_images_info from DB: {book.processed_images_info}")

    markdown_content = None
    image_urls_for_response = [] 

    # Only attempt to read/generate if processing is completed and markdown_filename exists
    if book.status == 'completed' and book.markdown_filename:
        if not CONTAINER_MARKDOWN_PATH:
            logger.error("CONTAINER_MARKDOWN_PATH is not set. Cannot read markdown file.")
            markdown_content = "Error: Markdown storage path not configured on server."
        else:
            container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)
            logger.info(f"Get endpoint: Constructed container markdown path: {container_markdown_path}")

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

            # Log raw markdown content before replacement
            if isinstance(markdown_content, str) and not markdown_content.startswith("Error:"):
                logger.info(f"Get endpoint: Book ID {book_id} - Raw markdown before replacement (first 500 chars): {markdown_content[:500]}")
                # Log a few image paths found in raw markdown for direct comparison
                raw_md_img_paths = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", markdown_content)
                raw_html_img_paths = re.findall(r"<img [^>]*src\s*=\s*['\"]([^'\"]+)['\"][^>]*>", markdown_content)
                logger.info(f"Get endpoint: Book ID {book_id} - Image paths in RAW markdown (MD syntax): {raw_md_img_paths[:5]}")
                logger.info(f"Get endpoint: Book ID {book_id} - Image paths in RAW markdown (MD syntax): {raw_md_img_paths[:5]}")
                logger.info(f"Get endpoint: Book ID {book_id} - Image paths in RAW markdown (HTML syntax): {raw_html_img_paths[:5]}")
            
            # --- REMOVE THE ENTIRE IMAGE PATH REWRITING BLOCK ---
            # if markdown_content and isinstance(markdown_content, str) and book.processed_images_info:
            #    ... (all the re.subn logic) ...
            # elif markdown_content and isinstance(markdown_content, str) and not book.processed_images_info:
            #    logger.info(f"Get endpoint: Book {book_id} has markdown content but no processed_images_info. Skipping new replacement logic.")
            logger.info(f"Get endpoint: Markdown content for book {book_id} is now assumed to have web-ready image paths from the file itself.")


    if book.status == 'completed' and book.image_filenames:
         image_urls_for_response = [f"/images/{filename}" for filename in book.image_filenames if filename]
         logger.info(f"Get endpoint: Generated {len(image_urls_for_response)} image URLs for response model from image_filenames.")
    elif book.status == 'completed' and not book.image_filenames:
         logger.info(f"Get endpoint: Book ID {book_id} completed but no image filenames stored.")
    elif book.status != 'completed':
         logger.info(f"Get endpoint: Book status is '{book.status}'. Not reading markdown or generating image URLs.")


    # Populate the response-only fields in the model instance
    book.markdown_content = markdown_content
    book.image_urls = image_urls_for_response # Use the correctly named variable

    book.markdown_content = markdown_content
    book.image_urls = image_urls_for_response # Use the correctly named variable

    # --- ADDED LOGGING ---
    if book.markdown_content:
        logger.info(f"Get endpoint: Final markdown_content being sent to frontend (first 500 chars): {book.markdown_content[:500]}")
        html_img_tags_found = re.findall(r"<img [^>]*src\s*=\s*['\"]([^'\"]+)['\"][^>]*>", book.markdown_content)
        logger.info(f"Get endpoint: Found HTML <img src=...> attributes in final markdown: {html_img_tags_found[:5]}")
        markdown_img_tags_found = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", book.markdown_content)
        logger.info(f"Get endpoint: Found Markdown ![]() image links in final markdown: {markdown_img_tags_found[:5]}")
    else:
        logger.info("Get endpoint: Final markdown_content is None.")
    # --- END OF ADDED LOGGING ---

    logger.info(f"Get endpoint: Returning book data for ID {book_id}")
    return book


# --- Add this helper function if it's not already present in this file ---
# --- Or ensure it's imported if defined elsewhere and accessible ---
async def get_effective_book_status_async(db_book_status: Optional[str], markdown_filename: Optional[str]) -> str:
    """
    Determines the effective status of a book asynchronously.
    "completed" if markdown file exists.
    "failed" if DB status is "failed".
    Otherwise, returns the DB status (or "pending" if None/empty).
    """
    if markdown_filename and CONTAINER_MARKDOWN_PATH: # Ensure CONTAINER_MARKDOWN_PATH is accessible
        file_path = os.path.join(CONTAINER_MARKDOWN_PATH, markdown_filename)
        
        # Use run_in_threadpool for the blocking os.path.exists call
        file_exists = await run_in_threadpool(os.path.exists, file_path)
        if file_exists:
            return "completed"
    
    if db_book_status == "failed":
        return "failed"
    
    return db_book_status if db_book_status else "pending"


@router.get("/status/{job_id}") # Removed response_model, will return a Dict
async def get_book_status_by_job_id(job_id: str) -> Dict[str, Any]:
    """
    Checks the status of a book processing job by its job_id.
    Status is determined by database record, which is updated by the PDF service callback.
    This endpoint NO LONGER proxies to the PDF service.
    """
    logger.info(f"Received status check for job_id: {job_id} (local check).")

    if not job_id: # Basic validation
        logger.warning("Status check requested with no job_id.")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="job_id is required")

    book_doc = await get_book_by_job_id(job_id)

    if not book_doc:
        logger.warning(f"Status check: Book record with job_id {job_id} not found in DB.")
        # If the frontend polls this, a 404 might stop polling.
        # The PDF service callback is responsible for creating/updating the record.
        # If the record doesn't exist, it implies the callback hasn't happened or failed very early,
        # or the job_id is invalid.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job ID {job_id} not found.")

    # Use the helper to determine the status to be reported based on DB and file existence
    # This provides a consistent view, especially if there's a slight delay in DB update vs file creation.
    effective_status = await get_effective_book_status_async(
        book_doc.get("status"),
        book_doc.get("markdown_filename")
    )
    
    # Construct a response similar to what the frontend might expect
    # (previously from PDF service, now generated locally based on DB state)
    response_data = {
        "job_id": job_id,
        "status": effective_status, # Use the effective status
        "success": effective_status == "completed", # Assuming success means completed
        "title": book_doc.get("title", "Unknown Title"),
        "message": f"Processing status: {effective_status}.",
        # These fields might be expected by frontend if it was parsing PDF service response
        "file_path": None, 
        "images": [] 
    }

    if effective_status == "completed":
        response_data["message"] = "Processing completed successfully."
        if book_doc.get("markdown_filename"):
            # Provide the filename if useful for frontend, not the full server path
            response_data["file_path"] = book_doc.get("markdown_filename") 
        if book_doc.get("image_filenames"):
            # Provide simplified image info (just filenames)
            response_data["images"] = [{"filename": fn} for fn in book_doc.get("image_filenames")]
    elif effective_status == "failed":
        response_data["message"] = book_doc.get("processing_error") or "Processing failed."
    
    # If the DB status is 'processing' but file doesn't exist yet, effective_status will be 'processing'.
    # If DB status is 'pending' and file doesn't exist, effective_status will be 'pending'.

    # The PDF service callback is the sole mechanism for updating the DB from 'pending'/'processing'
    # to 'completed' (with file paths) or 'failed'. This polling endpoint is just for status reporting.
    # No DB updates should happen here anymore.

    logger.info(f"Returning local status for job {job_id}: {response_data}")
    return response_data

# --- Pydantic model for PDF Service Callback ---
class PDFServiceImageInfo(BaseModel):
    filename: str # This is the final, sanitized filename that the PDF service saved the image as.
    path: str # This is the original path of the image as embedded in the raw markdown by magic_pdf (e.g., "images/figure1.png" or an absolute path if magic_pdf used that)

class PDFServiceCallbackData(BaseModel):
    job_id: str
    status: str # "completed" or "failed"
    message: Optional[str] = None
    file_path: Optional[str] = None # Full path to markdown file on PDF service
    images: Optional[List[PDFServiceImageInfo]] = []
    processing_error: Optional[str] = None


@router.post("/callback", status_code=status.HTTP_200_OK)
async def pdf_processing_callback(payload: PDFServiceCallbackData = Body(...)):
    """
    Receives callback from PDF processing service upon job completion or failure.
    Updates the book record in the database.
    """
    logger.info(f"Received PDF processing callback for job_id: {payload.job_id}")
    logger.debug(f"Callback payload: {payload.model_dump_json(indent=2)}")

    book_doc = await get_book_by_job_id(payload.job_id)

    if not book_doc:
        logger.error(f"Callback: Book with job_id {payload.job_id} not found. Cannot update.")
        # Return 200 to acknowledge receipt and prevent PDF service retries for this specific error.
        # The error is on our side (missing job_id) or a race condition.
        return {"message": "Callback received, but job_id not found or already processed."}

    book_id_str = str(book_doc["_id"])
    logger.info(f"Callback: Found book with ID {book_id_str} for job_id {payload.job_id}.")

    update_data = {
        "status": payload.status,
        "updated_at": datetime.utcnow() # Always update the timestamp
    }

    if payload.status == "completed":
        if payload.file_path:
            update_data["markdown_filename"] = os.path.basename(payload.file_path)
            logger.info(f"Callback: Extracted markdown_filename: {update_data['markdown_filename']}")
        else:
            logger.warning(f"Callback: Job {payload.job_id} completed but no file_path provided.")
            # Potentially mark as failed if markdown_filename is critical
            update_data["status"] = "failed"
            update_data["processing_error"] = "Processing reported as completed by PDF service, but no markdown file path was provided."
        
        if payload.images:
            image_filenames = []
            processed_images_info_for_db = []
            for img_info in payload.images:
                if img_info.filename and img_info.path: # Ensure both filename and original path are present
                    image_filenames.append(img_info.filename)
                    processed_images_info_for_db.append({
                        "filename": img_info.filename,
                        "original_path_in_markdown": img_info.path # Store the original path
                    })
                else:
                    logger.warning(f"Callback: Job {payload.job_id} - Skipping image info due to missing filename or path: {img_info.model_dump_json()}")
            
            # We only need to store the final filenames now
            image_filenames = [img_info.filename for img_info in payload.images if img_info.filename]
            update_data["image_filenames"] = image_filenames
            logger.info(f"Callback: Extracted {len(image_filenames)} image filenames.")
        else:
            update_data["image_filenames"] = []
        
        # --- REMOVE processed_images_info logic ---
        # update_data["processed_images_info"] = [] # This line is removed

    elif payload.status == "failed":
        update_data["processing_error"] = payload.processing_error or "Processing failed without specific error message from PDF service."
        logger.warning(f"Callback: Job {payload.job_id} failed. Error: {update_data['processing_error']}")
        update_data["markdown_filename"] = None
        update_data["image_filenames"] = []
        # update_data["processed_images_info"] = [] # This line is removed

    else: 
        logger.warning(f"Callback: Received unexpected status '{payload.status}' for job_id {payload.job_id}. Treating as failed.")
        update_data["status"] = "failed"
        update_data["processing_error"] = f"Received unexpected status '{payload.status}' from PDF service. Original message: {payload.message}"
        update_data["markdown_filename"] = None 
        update_data["image_filenames"] = []     

    try:
        updated_count = await update_book(book_id_str, update_data)
        if updated_count: # update_book should return modified_count or similar
            logger.info(f"Callback: Successfully updated book {book_id_str} (job_id: {payload.job_id}) with status '{update_data['status']}'.")
            return {"message": "Callback processed successfully."}
        else:
            logger.error(f"Callback: Failed to update book {book_id_str} (job_id: {payload.job_id}) in DB, or no changes were made.")
            # This could happen if the document was already in the target state or deleted.
            # Still return 200 to PDF service.
            return {"message": "Callback received, but DB update failed or no changes needed."}

    except Exception as e:
        logger.error(f"Callback: Exception updating book {book_id_str} (job_id: {payload.job_id}): {e}", exc_info=True)
        # Even on internal error, acknowledge to PDF service to prevent retries if the issue is persistent.
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
                            detail="Internal server error processing callback.")

# ... (rest of the file) ...
