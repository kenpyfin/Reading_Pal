# backend/api/books.py

# Add necessary imports at the top
import asyncio # Import asyncio
import os
import logging
import hmac
import hashlib
import time
import urllib.parse
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status, Body, Response, Depends, Request, Query
from fastapi.responses import FileResponse
from pathlib import Path
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
    count_books,
    get_book_by_job_id,
    update_book,
    delete_book_record, # Add delete_book_record
    get_database
)
from backend.auth.auth_handler import auth_handler_instance # For decoding JWT
from backend.services.llm_service import llm_service # For Reading Guide (Import instance)
from backend.services.pdf_client import process_document_with_service
import json # For parsing LLM response for Reading Guide

# Import new model and DB functions for page-specific reading guides
from backend.models.reading_guide import (
    ReadingGuidePageInDB,
    ReadingGuideInDB,
    ReadingGuideProgressUpdate,
)
from backend.db.mongodb import (
    upsert_reading_guide_page,
    get_reading_guide_page,
    upsert_reading_guide,
    get_reading_guide,
    get_reading_guide_progress,
    update_reading_guide_progress,
)


logger = logging.getLogger(__name__)
router = APIRouter()

SUPPORTED_BOOK_EXTENSIONS = {
    ".pdf",
    ".epub",
    ".mobi",
    ".azw",
    ".azw3",
    ".docx",
    ".txt",
    ".html",
    ".htm",
}


# Dependency to get current user_id from token
async def get_current_user_id(request: Request) -> str:
    auth_header = request.headers.get("Authorization")

    if not auth_header:
        logger.warning("get_current_user_id: Authorization header is missing for %s", request.url.path)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated", # This is the detail the client will see
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    parts = auth_header.split()
    if parts[0].lower() != "bearer" or len(parts) == 1 or len(parts) > 2:
        logger.warning("get_current_user_id: Invalid Authorization header format for %s", request.url.path)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token format",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    token = parts[1]
    logger.debug(f"get_current_user_id: Extracted token: {token[:20]}...") # Log only a portion for security

    payload = auth_handler_instance.decode_token(token)
    if not payload: # decode_token returns None on failure
        logger.warning("get_current_user_id: Token decoding failed or returned no payload.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token", # More specific detail
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    user_id = payload.get("user_id")
    if not user_id:
        logger.warning(f"get_current_user_id: 'user_id' not found in token payload. Payload: {payload}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User ID missing in token", # More specific detail
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    logger.debug(f"get_current_user_id: Successfully obtained user_id: {user_id}")
    return user_id

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

# --- Helper function for document service call ---
async def call_document_service_upload(file: UploadFile, title: Optional[str]):
    try:
        response_data = await run_in_threadpool(process_document_with_service, file, title)
        logger.info(f"Received response from document service upload: {response_data}")
        return response_data
    except ValueError as e:
        logger.error("Document service configuration error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    except RuntimeError as e:
        logger.error("Error connecting to document service during upload: %s", e)
        raise HTTPException(status_code=503, detail=f"Could not connect to document processing service: {e}")
    except Exception as e:
        logger.error(f"Error in document service call: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error calling document service: {e}")


@router.post("/upload", response_model=Book)
async def upload_document(
    file: UploadFile = File(...),
    title: str = Form(None),
    current_user_id: str = Depends(get_current_user_id)
):
    """
    Uploads a supported document for the current user, sends it to the processing
    service to start background processing, saves the initial book record with
    job_id/status, and returns the new book data.
    """
    logger.info(f"Received upload request for file: {file.filename}")
    try:
        file_ext = os.path.splitext(file.filename or "")[1].lower()
        if file_ext not in SUPPORTED_BOOK_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Unsupported book format. "
                    f"Supported formats: {', '.join(sorted(SUPPORTED_BOOK_EXTENSIONS))}"
                ),
            )

        processed_data = await call_document_service_upload(file, title)

        if not processed_data or not processed_data.get("success"):
             error_detail = processed_data.get("message", "Document processing initiation failed")
             logger.error(f"Document service initiation failed: {error_detail}")
             raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=error_detail)

        job_id = processed_data.get("job_id")
        initial_status = processed_data.get("status", "pending")

        if not job_id:
            logger.error("Document service did not return a job_id.")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Document processing service failed to return a job ID.")

        book_title = title if title else os.path.splitext(file.filename)[0]
        sanitized_book_title = sanitize_filename(book_title)

        # --- Prepare data using the Book model structure, matching DB schema ---
        # REMOVE id=None from the constructor
        book_to_save = Book(
            user_id=current_user_id, # Associate book with the current user
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
        logger.error(f"Unexpected error during document upload: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"An unexpected error occurred during upload: {e}")


@router.get("/", response_model=List[Book], response_model_by_alias=False)
async def list_books(
    response: Response,
    current_user_id: str = Depends(get_current_user_id),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
):
    """
    Retrieves a list of books for the current user, excluding those with 'failed' status.
    Supports pagination via skip/limit. Total count for the current filter is returned in
    the X-Total-Count response header (for the book list UI).
    Setting response_model_by_alias=False ensures that if the Book model
    has a field named 'id' (e.g., id: SomeType = Field(alias='_id')),
    the output JSON key will be 'id', not '_id'.
    """
    logger.info("Fetching list of books (excluding failed, by_alias=False for response)...")
    try:
        # Define the projection to fetch only necessary fields
        projection = {
            "_id": 1,
            "user_id": 1, # Include user_id in projection
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

        book_filter = {"user_id": current_user_id, "status": {"$ne": "failed"}}
        total = await count_books(book_filter)
        response.headers["X-Total-Count"] = str(total)

        books_docs = await get_books(
            filter=book_filter, projection=projection, skip=skip, limit=limit
        )
        logger.info(
            f"Fetched {len(books_docs)} book documents from DB for user {current_user_id} "
            f"(excluding failed, skip={skip}, limit={limit}, total={total})."
        )

        # The list_books function currently constructs dictionaries with an "id" key.
        # When response_model=List[Book] and response_model_by_alias=False are used:
        # 1. FastAPI takes each dictionary from response_list.
        # 2. It validates/parses this dictionary into a Book model instance.
        #    The dict has "id", which should map to the Book model's 'id' field.
        # 3. It then serializes this Book model instance using by_alias=False.
        #    This means it will use the actual field name from the Book model (assumed to be 'id')
        #    instead of its alias (assumed to be '_id').

        response_list = []
        for book_doc in books_docs:
            if '_id' not in book_doc:
                logger.warning(f"Skipping book document due to missing _id: {book_doc}")
                continue
            
            # Create a dictionary that can be validated by the Book model.
            # The Book model expects fields according to its definition.
            # If Book model's ID field is named 'id' and aliased to '_id',
            # then passing 'id' here is correct for validation.
            item_for_validation = {
                "id": str(book_doc['_id']), # For Book model's 'id' field
                "user_id": book_doc.get("user_id"), # Include user_id
                "title": book_doc.get("title"),
                "original_filename": book_doc.get("original_filename"),
                "status": book_doc.get("status"),
                "job_id": book_doc.get("job_id"),
                "sanitized_title": book_doc.get("sanitized_title"),
                "markdown_filename": book_doc.get("markdown_filename"),
                "image_filenames": book_doc.get("image_filenames", []),
                "created_at": book_doc.get("created_at"),
                "updated_at": book_doc.get("updated_at"),
                "processing_error": book_doc.get("processing_error"),
                # Response-only fields in Book model like markdown_content, image_urls
                # will be handled by the model's defaults or excluded if not in this dict.
            }
            response_list.append(item_for_validation)
            # FastAPI will take this list of dicts, validate each against Book,
            # then serialize each Book instance using by_alias=False.

        logger.info(f"Returning list of {len(response_list)} dictionaries for Book model processing.")
        return response_list

    except Exception as e:
        logger.error(f"Error listing books: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error retrieving books: {e}")


@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str, current_user_id: str = Depends(get_current_user_id)):
    """
    Retrieves book data by its ID for the current user, reads markdown content from file if available.
    """
    logger.info(f"Received request for book ID: {book_id} by user {current_user_id}")

    book_data_doc = await get_book(book_id, current_user_id) # Fetches the raw document (dict) for the user

    if not book_data_doc:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id} and user {current_user_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")

    logger.info(f"Get endpoint: Book found in DB for ID: {book_id} and user {current_user_id}")

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

            # Replace /images/app/ and /api/books/images/app/ paths in markdown with signed URLs
            if isinstance(markdown_content, str) and not markdown_content.startswith("Error:"):
                markdown_content = _sign_app_image_urls_in_markdown(markdown_content)
                logger.info(f"Get endpoint: Replaced image paths in markdown with signed URLs for book {book_id}")


    if book.status == 'completed' and book.image_filenames:
         # App images (from PDF processing) are stored in /images/app/ subdirectory
         # Generate signed URLs that expire after 1 hour to prevent direct URL access
         image_urls_for_response = [generate_signed_image_url(filename) for filename in book.image_filenames if filename]
         logger.info(f"Get endpoint: Generated {len(image_urls_for_response)} signed image URLs for response model from image_filenames (app images).")
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

@router.post("/{book_id}/refresh-image-urls")
async def refresh_image_urls(book_id: str, current_user_id: str = Depends(get_current_user_id)):
    """
    Refreshes signed URLs for all images in the book's markdown content.
    Returns the markdown content with fresh signed URLs.
    This is called when user navigates pages to ensure URLs don't expire.
    """
    logger.info(f"Refresh image URLs request for book ID: {book_id} by user {current_user_id}")
    
    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")
    
    book = Book.model_validate(book_data_doc)
    
    # Read markdown content
    markdown_content = None
    if book.status == 'completed' and book.markdown_filename:
        container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)
        
        def read_markdown_file(path):
            if os.path.exists(path) and os.path.isfile(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        return f.read()
                except Exception as file_read_error:
                    logger.error(f"Error reading markdown file {path}: {file_read_error}")
                    return f"Error: Could not read processed content. {file_read_error}"
            else:
                logger.error(f"Markdown file not found at container path: {path}")
                return "Error: Processed content file not found."
        
        markdown_content = await run_in_threadpool(read_markdown_file, container_markdown_path)
    
    if not markdown_content or isinstance(markdown_content, str) and markdown_content.startswith("Error:"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown content not found")
    
    # Replace app image paths with fresh signed URLs
    if isinstance(markdown_content, str):
        markdown_content = _sign_app_image_urls_in_markdown(markdown_content)
        logger.info(f"Refreshed signed URLs in markdown for book {book_id}")
    
    return {"markdown_content": markdown_content}


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
    path: str # Original image path as embedded in raw markdown prior to path rewriting.

class PDFServiceCallbackData(BaseModel):
    job_id: str
    status: str # "completed" or "failed"
    message: Optional[str] = None
    file_path: Optional[str] = None # Full path to markdown file on PDF service
    images: List[PDFServiceImageInfo] = Field(default_factory=list)
    processing_error: Optional[str] = None


def _extract_image_filenames_from_markdown(markdown_path: str) -> List[str]:
    """Fallback for legacy callbacks without image metadata."""
    if not markdown_path or not os.path.exists(markdown_path):
        return []
    try:
        with open(markdown_path, "r", encoding="utf-8") as f:
            content = f.read()
        matches = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", content or "")
        filenames: List[str] = []
        for image_path in matches:
            rel = _extract_app_image_relative_path(image_path)
            if rel:
                filenames.append(rel)
        # Preserve insertion order while deduplicating
        return list(dict.fromkeys(filenames))
    except Exception as exc:
        logger.warning(f"Failed to extract image filenames from markdown fallback: {exc}")
        return []

# Pydantic Models for Reading Guide - OLD, TO BE REMOVED
# class ReadingGuideItem(BaseModel):
# title: str
# summary: str
# estimated_page: int

# class ReadingGuideResponse(BaseModel):
# guide: List[ReadingGuideItem]


class ReadingGuideGenerateBody(BaseModel):
    """Optional body for POST reading-guide; guide_type controls brevity."""
    guide_type: Optional[str] = Field(default="summary", description="summary, comprehensive, or quick_reference")


# Define APPROX_CHARS_PER_PAGE, must match frontend's BookView.js (APPROX_CHARS_PER_PAGE)
# This is crucial for consistency.
APPROX_CHARS_PER_PAGE_FOR_GUIDE = 8000

def _calculate_page_boundaries(markdown: str, target_chars_per_page: int) -> List[Dict[str, int]]:
    """
    Calculates page boundaries respecting word breaks, mirroring frontend logic.
    """
    if not markdown:
        logger.warning("[_calculate_page_boundaries] Markdown content is invalid or empty.")
        return []
    
    boundaries = []
    current_offset = 0
    total_length = len(markdown)
    min_page_chars = target_chars_per_page * 0.5

    while current_offset < total_length:
        page_start = current_offset
        potential_end = min(page_start + target_chars_per_page, total_length)
        actual_end = potential_end

        if potential_end < total_length:
            boundary_found = False
            # Search backwards from potential_end for a natural break (space)
            for i in range(potential_end, int(page_start), -1):
                if markdown[i-1].isspace():
                    actual_end = i
                    boundary_found = True
                    break
            
            if not boundary_found:
                # No space found searching backwards. Try to find the *next* space *after* potential_end
                next_space_search_limit = min(potential_end + int(target_chars_per_page * 0.25), total_length)
                found_next_space = False
                for i in range(potential_end, next_space_search_limit):
                    if markdown[i].isspace():
                        actual_end = i + 1
                        found_next_space = True
                        break
                if not found_next_space:
                    actual_end = potential_end

            if (actual_end - page_start) < min_page_chars and (total_length - page_start) > target_chars_per_page:
                actual_end = potential_end

        if actual_end <= page_start and page_start < total_length:
            logger.warning(f"[_calculate_page_boundaries] actual_end ({actual_end}) did not advance from page_start ({page_start}). Forcing advance.")
            actual_end = min(page_start + target_chars_per_page, total_length)

        actual_end = min(actual_end, total_length)
        
        boundaries.append({"start": page_start, "end": actual_end})
        current_offset = actual_end

        if len(boundaries) > 10000:
            logger.error("[_calculate_page_boundaries] Exceeded 10000 page boundaries, breaking loop.")
            break
            
    logger.info(f"[_calculate_page_boundaries] Calculated {len(boundaries)} pages.")
    return boundaries


def _extract_heading_sections(markdown: str, page_start: int, page_end: int) -> List[Dict[str, Any]]:
    """
    Extract sections based on markdown headings that overlap the given page range.
    Returns list of {"text": str, "level": int, "start_offset": int, "end_offset": int}.
    Offsets are global (relative to full markdown). Sections are content from one heading to the next.
    If no headings fall in range, returns empty list (caller should use single page chunk).
    """
    if not markdown or page_start < 0 or page_end > len(markdown) or page_start >= page_end:
        return []
    heading_re = re.compile(r"^(#+)\s+(.*)$")
    headings: List[Dict[str, Any]] = []
    current_offset = 0
    lines = markdown.split("\n")
    for line in lines:
        match = heading_re.match(line)
        if match:
            level = len(match.group(1))
            text = match.group(2).strip()
            headings.append({"text": text, "level": level, "start_offset": current_offset})
        current_offset += len(line) + 1
    if not headings:
        return []
    # Assign end_offset for each heading (start of next heading or end of document)
    total_len = len(markdown)
    for i in range(len(headings)):
        if i + 1 < len(headings):
            headings[i]["end_offset"] = headings[i + 1]["start_offset"]
        else:
            headings[i]["end_offset"] = total_len
    # Filter to sections that overlap [page_start, page_end]
    overlapping = [
        h for h in headings
        if h["start_offset"] < page_end and h["end_offset"] > page_start
    ]
    logger.info(f"[_extract_heading_sections] Found {len(headings)} headings, {len(overlapping)} overlap page [{page_start}, {page_end}].")
    return overlapping


def _extract_whole_book_heading_nodes(markdown: str) -> List[Dict[str, Any]]:
    """
    Extract heading-aligned nodes across the entire markdown with offsets and snippets.
    Heuristically skips obvious non-content front matter segments.
    """
    if not markdown:
        return []
    heading_re = re.compile(r"^(#{1,6})\s+(.*)$")
    lines = markdown.split("\n")
    headings: List[Dict[str, Any]] = []
    offset = 0
    for line in lines:
        m = heading_re.match(line)
        if m:
            headings.append({
                "level": len(m.group(1)),
                "title": m.group(2).strip(),
                "start_offset": offset,
            })
        offset += len(line) + 1
    if not headings:
        snippet = markdown[:700]
        return [{
            "id": "s1",
            "level": 1,
            "title": "Book content",
            "start_offset": 0,
            "end_offset": len(markdown),
            "snippet": snippet,
        }]

    nodes: List[Dict[str, Any]] = []
    for i, h in enumerate(headings):
        start = h["start_offset"]
        end = headings[i + 1]["start_offset"] if i + 1 < len(headings) else len(markdown)
        title = h["title"]
        content = markdown[start:end]
        # Quick deterministic non-book-content skip at extraction stage.
        low = f"{title}\n{content[:500]}".lower()
        if any(token in low for token in ["copyright", "all rights reserved", "isbn", "published by", "table of contents"]):
            continue
        nodes.append({
            "id": f"s{i + 1}",
            "level": h["level"],
            "title": title,
            "start_offset": start,
            "end_offset": end,
            "snippet": content[:700],
        })
    return nodes


def _find_roadmap_item(items: List[Dict[str, Any]], item_id: str) -> Optional[Dict[str, Any]]:
    for item in items or []:
        if item.get("id") == item_id:
            return item
        child = _find_roadmap_item(item.get("children") or [], item_id)
        if child:
            return child
    return None


def _set_roadmap_item_graph(items: List[Dict[str, Any]], item_id: str, graph_url: str) -> bool:
    for item in items or []:
        if item.get("id") == item_id:
            item["graph_image_url"] = graph_url
            return True
        if _set_roadmap_item_graph(item.get("children") or [], item_id, graph_url):
            return True
    return False


def _set_roadmap_item_alternative_reading(items: List[Dict[str, Any]], item_id: str, alternative_reading: str) -> bool:
    for item in items or []:
        if item.get("id") == item_id:
            item["alternative_reading"] = alternative_reading
            return True
        if _set_roadmap_item_alternative_reading(item.get("children") or [], item_id, alternative_reading):
            return True
    return False


def _extract_graph_filepath(graph_image_url: Optional[str]) -> Optional[str]:
    """Normalize stored graph URL/path to relative filepath under /images/app/."""
    if not graph_image_url or not isinstance(graph_image_url, str):
        return None

    parsed = urllib.parse.urlparse(graph_image_url)
    path = parsed.path or graph_image_url

    if path.startswith("/api/books/images/app/"):
        return path.replace("/api/books/images/app/", "", 1).lstrip("/")
    if path.startswith("/images/app/"):
        return path.replace("/images/app/", "", 1).lstrip("/")

    # Backward-compatible fallback: treat non-URL values as relative file paths.
    if "://" not in graph_image_url and not graph_image_url.startswith("data:"):
        return graph_image_url.lstrip("/")
    return None


def _refresh_roadmap_graph_urls(items: List[Dict[str, Any]]) -> None:
    """Recursively replace stored graph path/URL with a fresh signed URL."""
    for item in items or []:
        filepath = _extract_graph_filepath(item.get("graph_image_url"))
        if filepath:
            item["graph_image_url"] = generate_signed_image_url(filepath)
        _refresh_roadmap_graph_urls(item.get("children") or [])


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
        return {"message": "Callback received, but job_id not found or already processed."}

    book_id_str = str(book_doc["_id"])
    db_user_id = book_doc.get("user_id")
    current_db_sanitized_title = book_doc.get("sanitized_title")

    if not db_user_id:
        logger.error(f"Callback: Book with job_id {payload.job_id} (DB ID {book_id_str}) is missing user_id. Update cannot proceed.")
        return {"message": "Callback received, but book record is missing user_id. Update skipped."}

    logger.info(f"Callback: Found book with ID {book_id_str} for job_id {payload.job_id}, user_id {db_user_id}.")

    update_data = {
        "status": payload.status,
        "updated_at": datetime.utcnow()
    }

    if payload.status == "completed":
        if payload.file_path:
            pdf_service_markdown_filename = os.path.basename(payload.file_path)
            final_markdown_filename_for_db = pdf_service_markdown_filename

            if current_db_sanitized_title:
                expected_markdown_filename_based_on_db = f"{current_db_sanitized_title}.md"
                if CONTAINER_MARKDOWN_PATH and pdf_service_markdown_filename != expected_markdown_filename_based_on_db:
                    old_file_on_disk_path = os.path.join(CONTAINER_MARKDOWN_PATH, pdf_service_markdown_filename)
                    new_file_on_disk_path = os.path.join(CONTAINER_MARKDOWN_PATH, expected_markdown_filename_based_on_db)
                    try:
                        if await run_in_threadpool(os.path.exists, old_file_on_disk_path):
                            await run_in_threadpool(os.rename, old_file_on_disk_path, new_file_on_disk_path)
                            logger.info(f"Callback: Renamed processed file from {old_file_on_disk_path} to {new_file_on_disk_path} to match current DB title.")
                            final_markdown_filename_for_db = expected_markdown_filename_based_on_db
                        else:
                            logger.warning(f"Callback: PDF service reported file {pdf_service_markdown_filename} at {old_file_on_disk_path}, but it was not found. Cannot rename to {new_file_on_disk_path}.")
                            # If the original file isn't there, we can't rename it.
                            # The DB will store pdf_service_markdown_filename, but it points to a non-existent file.
                            # This might indicate an issue in the PDF service or file system.
                    except OSError as e:
                        logger.error(f"Callback: Error renaming file {old_file_on_disk_path} to {new_file_on_disk_path}: {e}", exc_info=True)
                        # File rename failed. DB will store pdf_service_markdown_filename.
            else:
                logger.warning(f"Callback: Job {payload.job_id} - current_db_sanitized_title is missing. Cannot determine expected filename for potential rename.")

            update_data["markdown_filename"] = final_markdown_filename_for_db
            logger.info(f"Callback: Set markdown_filename for DB: {update_data['markdown_filename']}")
        else:
            logger.warning(f"Callback: Job {payload.job_id} completed but no file_path provided.")
            update_data["status"] = "failed"
            update_data["processing_error"] = "Processing reported as completed by PDF service, but no markdown file path was provided."
            update_data["markdown_filename"] = None # Ensure it's cleared

        image_filenames = [img_info.filename for img_info in payload.images if img_info and img_info.filename]
        if not image_filenames and update_data.get("markdown_filename") and CONTAINER_MARKDOWN_PATH:
            markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, update_data["markdown_filename"])
            image_filenames = _extract_image_filenames_from_markdown(markdown_path)
            if image_filenames:
                logger.info(
                    f"Callback: Recovered {len(image_filenames)} image filenames from markdown fallback."
                )
        update_data["image_filenames"] = image_filenames
        logger.info(f"Callback: Extracted {len(image_filenames)} image filenames.")

    elif payload.status == "failed":
        update_data["processing_error"] = payload.processing_error or "Processing failed without specific error message from PDF service."
        logger.warning(f"Callback: Job {payload.job_id} failed. Error: {update_data['processing_error']}")
        update_data["markdown_filename"] = None
        update_data["image_filenames"] = []
    else:
        logger.warning(f"Callback: Received unexpected status '{payload.status}' for job_id {payload.job_id}. Treating as failed.")
        update_data["status"] = "failed"
        update_data["processing_error"] = f"Received unexpected status '{payload.status}' from PDF service. Original message: {payload.message}"
        update_data["markdown_filename"] = None
        update_data["image_filenames"] = []

    try:
        updated_count = await update_book(book_id_str, db_user_id, update_data) # Pass db_user_id
        if updated_count:
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

# Add this new Pydantic model for the rename payload
class BookRenamePayload(BaseModel):
    new_title: str

# Add new endpoint for renaming a book
@router.put("/{book_id}/rename", response_model=Book)
async def rename_book(book_id: str, payload: BookRenamePayload = Body(...), current_user_id: str = Depends(get_current_user_id)):
    logger.info(f"Attempting to rename book ID: {book_id} to '{payload.new_title}' for user {current_user_id}")
    # db = get_database() # get_database() is not used directly here, db functions are.
    
    try:
        # Validate ObjectId
        if not ObjectId.is_valid(book_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    except InvalidId: # Catch InvalidId specifically if ObjectId.is_valid doesn't catch all cases or for robustness
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")

    existing_book_data = await get_book(book_id, current_user_id) # Fetches raw dict for the user
    if not existing_book_data:
        logger.warning(f"Rename: Book not found in DB for ID: {book_id} and user {current_user_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")

    try:
        existing_book = Book.model_validate(existing_book_data)
    except Exception as e:
        logger.error(f"Rename: Error converting existing book data (ID: {book_id}) to Book model: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error processing book data")

    # old_sanitized_title = existing_book.sanitized_title # Not strictly needed anymore
    # old_markdown_filename = existing_book.markdown_filename # Not strictly needed anymore

    new_sanitized_title = sanitize_filename(payload.new_title)
    # The markdown_filename will not be changed. File system operations are removed.

    update_data_for_db = {
        "title": payload.new_title,
        "sanitized_title": new_sanitized_title,
        # "markdown_filename" is intentionally omitted to keep it unchanged in the database.
        "updated_at": datetime.utcnow()
    }

    updated_count = await update_book(book_id, current_user_id, update_data_for_db)
    if not updated_count:
        logger.warning(f"Rename: Book with ID {book_id} for user {current_user_id} was not updated in DB. It might have been deleted or data was identical (except updated_at).")
    
    updated_book_data = await get_book(book_id, current_user_id) # Re-fetch the book for the user
    if not updated_book_data:
        logger.error(f"Rename: Book with ID {book_id} for user {current_user_id} not found after update attempt.")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found after update attempt.")
        
    try:
        response_book = Book.model_validate(updated_book_data)
    except Exception as validation_error:
        logger.error(f"Rename: Failed to validate re-fetched book data for ID {book_id}: {validation_error}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to validate updated book data.")
    
    logger.info(f"Book ID {book_id} successfully renamed to '{response_book.title}'.")
    return response_book


# Add new endpoint for deleting a book
@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_book_route(book_id: str, current_user_id: str = Depends(get_current_user_id)):
    logger.info(f"Attempting to delete book ID: {book_id} for user {current_user_id}")
    # db = get_database() # Not used directly

    try:
        if not ObjectId.is_valid(book_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    except InvalidId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")

    book_data = await get_book(book_id, current_user_id) # Fetches raw dict for the user
    if not book_data:
        logger.warning(f"Delete: Book not found in DB for ID: {book_id} and user {current_user_id}. No action taken.")
        # Return 204 as per HTTP spec for DELETE if resource is already gone or not owned
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    book_to_delete = None # Initialize to None
    try:
        book_to_delete = Book.model_validate(book_data)
    except Exception as e:
        logger.error(f"Delete: Error converting book data (ID: {book_id}) for deletion to Book model: {e}", exc_info=True)
        # If model conversion fails but data was fetched, we might still want to proceed with deletion
        # based on book_id and whatever info we have (like filenames from the raw dict).
        # For now, let's assume if model validation fails, we might not have reliable filenames.
        # A safer approach might be to just delete the DB record if model validation fails.
        # However, the current logic tries to use book_to_delete.markdown_filename etc.
        # Let's make book_to_delete from the raw dict if model validation fails.
        book_to_delete_dict = book_data # Use the raw dict
        logger.warning(f"Delete: Using raw dict for book ID {book_id} due to model validation error. File cleanup might be incomplete if filenames are missing/incorrect in raw data.")
        # To allow file cleanup attempt, we'll use the dict directly for attributes if book_to_delete is None
        markdown_filename_to_delete = book_to_delete_dict.get("markdown_filename")
        image_filenames_to_delete = book_to_delete_dict.get("image_filenames")

    if book_to_delete: # If model validation was successful
        markdown_filename_to_delete = book_to_delete.markdown_filename
        image_filenames_to_delete = book_to_delete.image_filenames


    # Delete markdown file
    if CONTAINER_MARKDOWN_PATH and markdown_filename_to_delete:
        markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, markdown_filename_to_delete)
        try:
            if await run_in_threadpool(os.path.exists, markdown_file_path):
                await run_in_threadpool(os.remove, markdown_file_path)
                logger.info(f"Deleted markdown file: {markdown_file_path}")
            else:
                logger.warning(f"Markdown file not found for deletion: {markdown_file_path}. Book ID: {book_id}")
        except OSError as e:
            logger.error(f"Error deleting markdown file {markdown_file_path} for book ID {book_id}: {e}", exc_info=True)

    # Delete image files
    if CONTAINER_IMAGES_PATH and image_filenames_to_delete and isinstance(image_filenames_to_delete, list):
        for image_filename in image_filenames_to_delete:
            if image_filename: # Ensure filename is not empty or None
                image_file_path = os.path.join(CONTAINER_IMAGES_PATH, image_filename)
                try:
                    if await run_in_threadpool(os.path.exists, image_file_path):
                        await run_in_threadpool(os.remove, image_file_path)
                        logger.info(f"Deleted image file: {image_file_path}")
                    else:
                        logger.warning(f"Image file not found for deletion: {image_file_path}. Book ID: {book_id}")
                except OSError as e:
                    logger.error(f"Error deleting image file {image_file_path} for book ID {book_id} user {current_user_id}: {e}", exc_info=True)

    deleted_count = await delete_book_record(book_id, current_user_id)
    if not deleted_count:
        logger.warning(f"Delete: No book record found to delete with ID: {book_id} for user {current_user_id}, or delete operation failed in DB (already deleted or not owned?).")
        # Still return 204 as the resource is gone or not accessible to this user.
    else:
        logger.info(f"Successfully deleted book record with ID: {book_id} for user {current_user_id} from database.")

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/features", response_model=Dict[str, bool])
async def get_features():
    """
    Returns the status of various feature flags.
    """
    rewrite_enabled = os.getenv("FEATURE_FLAG_ENABLE_REWRITE", "false").lower() == "true"
    return {"rewrite_enabled": rewrite_enabled}


class ReformatPayload(BaseModel):
    selected_text: Optional[str] = None
    global_char_offset: Optional[int] = None

@router.post("/{book_id}/reformat-page/{page_number}", response_model=Book)
async def reformat_page_content(book_id: str, page_number: int, payload: ReformatPayload = Body(default=ReformatPayload()), current_user_id: str = Depends(get_current_user_id)):
    """
    Reformats either a selection of text or a single page of the book's markdown content using an LLM.
    This action overwrites the existing markdown file with the updated full content.
    """
    rewrite_enabled = os.getenv("FEATURE_FLAG_ENABLE_REWRITE", "false").lower() == "true"
    if not rewrite_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feature not available")
        
    logger.info(f"User {current_user_id} requested to reformat content for book {book_id}, page {page_number}")

    # 1. Get book from DB and validate
    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")
    
    book = Book.model_validate(book_data_doc)

    if book.status != 'completed' or not book.markdown_filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book content is not available for reformatting.")

    if not CONTAINER_MARKDOWN_PATH:
        logger.error("CONTAINER_MARKDOWN_PATH is not set. Cannot read or write markdown file.")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server storage is not configured.")

    # 2. Read current markdown file
    markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)
    logger.info(f"Reading content from {markdown_file_path} for page-reformat.")
    
    try:
        def read_file_sync(path):
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        full_content = await run_in_threadpool(read_file_sync, markdown_file_path)
    except FileNotFoundError:
        logger.error(f"Markdown file not found at {markdown_file_path} for book {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown file not found.")

    content_to_reformat = ""
    is_selection_reformat = False
    # Store the length of the text that will be replaced.
    original_selection_len_for_splicing = 0

    if payload and payload.selected_text and payload.global_char_offset is not None:
        is_selection_reformat = True
        offset = payload.global_char_offset
        # The length of the text from the frontend reflects the user's selection length.
        text_len_from_frontend = len(payload.selected_text)
        
        # Basic validation for the offset.
        if not (0 <= offset < len(full_content)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid character offset provided.")
        
        # Define the slice of original content to be replaced, using frontend's length as a guide.
        end_offset_of_original = min(offset + text_len_from_frontend, len(full_content))
        content_to_reformat = full_content[offset:end_offset_of_original]
        original_selection_len_for_splicing = len(content_to_reformat) # This is the length we'll replace.
        
        # Log a warning if there's a mismatch, but don't error out.
        if content_to_reformat != payload.selected_text:
            logger.warning(f"Reformat selection mismatch for book {book_id}. Frontend text differs from backend content at offset {offset}. Proceeding with backend content for reformatting.")
            logger.debug(f"Frontend text (len {len(payload.selected_text)}): '{payload.selected_text[:100]}...'")
            logger.debug(f"Backend content (len {original_selection_len_for_splicing}): '{content_to_reformat[:100]}...'")
        
        logger.info(f"Reformatting a selection of text (len: {len(content_to_reformat)}) for book {book_id}.")
    else:
        # 3. Calculate page boundaries to find the correct page content (whole page reformat)
        boundaries = _calculate_page_boundaries(full_content, APPROX_CHARS_PER_PAGE_FOR_GUIDE)
        if not (1 <= page_number <= len(boundaries)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid page number. Must be between 1 and {len(boundaries)}.")

        page_index = page_number - 1
        page_boundary = boundaries[page_index]
        start_offset, end_offset = page_boundary['start'], page_boundary['end']
        
        content_to_reformat = full_content[start_offset:end_offset]
        logger.info(f"Reformatting whole page {page_number} content (len: {len(content_to_reformat)}) for book {book_id}.")

    # 4. Call LLM service to reformat the content
    reformatted_content = await llm_service.reformat_content(content_to_reformat)
    if not reformatted_content or reformatted_content.startswith("Error:"):
        logger.error(f"LLM service failed to reformat content for book {book_id}. Response: {reformatted_content}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"LLM service failed to reformat content. {reformatted_content}")
    logger.info(f"Received reformatted content for book {book_id}. New length: {len(reformatted_content)}")

    # 5. Splice the reformatted content back into the full markdown
    if is_selection_reformat:
        start_offset = payload.global_char_offset
        # Use the length of the text we actually extracted from the original file.
        end_offset = start_offset + original_selection_len_for_splicing
        new_full_content = full_content[:start_offset] + reformatted_content + full_content[end_offset:]
    else: # Whole page reformat
        page_boundary = _calculate_page_boundaries(full_content, APPROX_CHARS_PER_PAGE_FOR_GUIDE)[page_number - 1]
        start_offset, end_offset = page_boundary['start'], page_boundary['end']
        new_full_content = full_content[:start_offset] + reformatted_content + full_content[end_offset:]

    new_full_content = _sign_app_image_urls_in_markdown(new_full_content)

    # 6. Overwrite the markdown file with the new full content
    try:
        def write_file_sync(path, content):
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
        await run_in_threadpool(write_file_sync, markdown_file_path, new_full_content)
        logger.info(f"Successfully overwrote markdown file at {markdown_file_path} with reformatted content.")
    except Exception as e:
        logger.error(f"Failed to write reformatted content to {markdown_file_path}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save reformatted content.")

    # 7. Update timestamp and return book object with new full content
    now = datetime.utcnow()
    await update_book(book_id, current_user_id, {"updated_at": now})
    
    book.updated_at = now
    book.markdown_content = new_full_content

    return book


@router.post("/{book_id}/pages/{page_number}/reading-guide", response_model=ReadingGuidePageInDB, response_model_by_alias=False)
async def generate_page_reading_guide(
    book_id: str,
    page_number: int,
    body: Optional[ReadingGuideGenerateBody] = Body(None),
    current_user_id: str = Depends(get_current_user_id)
):
    guide_type = (body.guide_type if body else None) or "summary"
    if guide_type not in ("summary", "comprehensive", "quick_reference"):
        guide_type = "summary"
    logger.info(f"Request to generate reading guide for book {book_id}, page {page_number}, guide_type={guide_type} by user {current_user_id}")
    
    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")

    try:
        book = Book.model_validate(book_data_doc)
    except Exception as validation_error:
        logger.error(f"Generate Guide: Failed to validate book data from DB for ID {book_id}: {validation_error}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Invalid book data found in database.")

    if book.status != 'completed' or not book.markdown_filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book processing not complete or markdown not available")

    if not CONTAINER_MARKDOWN_PATH:
        logger.error("CONTAINER_MARKDOWN_PATH is not set. Cannot read markdown file for guide.")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server configuration error: Markdown path not set.")

    markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)
    
    page_content_text = None
    page_global_start_offset = 0
    page_global_end_offset = 0
    try:
        def read_file_sync(path):
            if not os.path.exists(path):
                logger.error(f"Markdown file not found at {path} for reading guide generation.")
                return None
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        
        full_markdown_content = await run_in_threadpool(read_file_sync, markdown_file_path)

        if not full_markdown_content:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown content not found or empty.")

        boundaries = _calculate_page_boundaries(full_markdown_content, APPROX_CHARS_PER_PAGE_FOR_GUIDE)
        if not (1 <= page_number <= len(boundaries)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid page number. Must be between 1 and {len(boundaries)}.")

        page_boundary = boundaries[page_number - 1]
        page_global_start_offset = page_boundary["start"]
        page_global_end_offset = page_boundary["end"]
        page_content_text = full_markdown_content[page_global_start_offset:page_global_end_offset]
        total_pages = len(boundaries)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading or processing markdown for guide: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error processing book content for guide.")

    # Heading-based segmentation: sections overlapping this page
    heading_sections = _extract_heading_sections(full_markdown_content, page_global_start_offset, page_global_end_offset)
    if heading_sections:
        segments = [
            {"section_title": h["text"], "content": full_markdown_content[h["start_offset"]:h["end_offset"]]}
            for h in heading_sections
        ]
        segment_bounds = [(h["start_offset"], h["end_offset"]) for h in heading_sections]
    else:
        segments = [{"section_title": "Page content", "content": page_content_text}]
        segment_bounds = [(page_global_start_offset, page_global_end_offset)]

    try:
        logger.info(f"Generating structured reading guide for book {book.id}, page {page_number} ({len(segments)} segments)")
        structured_guide = await llm_service.generate_structured_reading_guide(
            segments=segments,
            book_title=book.title,
            page_number=page_number,
            total_pages=total_pages,
            guide_type=guide_type,
        )
        
        from backend.models.reading_guide import ReadingGuideSection, TextLink
        
        sections = []
        llm_sections = structured_guide.get("sections") or []
        for i, section_data in enumerate(llm_sections):
            if i >= len(segment_bounds):
                break
            global_start_offset, global_end_offset = segment_bounds[i]
            segment_content = full_markdown_content[global_start_offset:global_end_offset]
            preview_length = min(200, len(segment_content))
            original_text_preview = segment_content[:preview_length] if segment_content else ""
            context_before = None
            if global_start_offset > 0:
                context_before = full_markdown_content[max(0, global_start_offset - 50):global_start_offset]
            context_after = None
            if global_end_offset < len(full_markdown_content):
                context_after = full_markdown_content[global_end_offset:min(len(full_markdown_content), global_end_offset + 50)]
            
            primary_link = TextLink(
                start_offset=global_start_offset,
                end_offset=global_end_offset,
                preview_text=original_text_preview,
                context_before=context_before,
                context_after=context_after,
            )
            key_takeaway = section_data.get("key_takeaway")
            raw_rewritten = section_data.get("rewritten_content", "")
            # LLM may return rewritten_content as a list (e.g. bullet points); normalize to string
            if isinstance(raw_rewritten, list):
                rewritten_content = "\n".join(str(item) for item in raw_rewritten)
            else:
                rewritten_content = str(raw_rewritten) if raw_rewritten is not None else ""
            section = ReadingGuideSection(
                section_title=section_data.get("section_title", ""),
                rewritten_content=rewritten_content,
                original_start_offset=global_start_offset,
                original_end_offset=global_end_offset,
                original_text_preview=original_text_preview,
                primary_link=primary_link,
                key_takeaway=key_takeaway,
            )
            sections.append(section)
            logger.debug(f"Converted section '{section.section_title}': global [{global_start_offset}-{global_end_offset}]")
        
        simple_content = ""
        if sections:
            parts = []
            for section in sections:
                block = f"## {section.section_title}\n\n"
                if section.key_takeaway:
                    block += f"**Key idea:** {section.key_takeaway}\n\n"
                block += section.rewritten_content
                parts.append(block)
            simple_content = "\n\n".join(parts)
        else:
            simple_content = "No guide sections were generated for this page."
            logger.warning(f"No guide sections generated for book {book.id}, page {page_number}")
        
        db_guide_page = await upsert_reading_guide_page(
            book_id=str(book.id),
            user_id=current_user_id,
            page_number=page_number,
            content=simple_content,
            sections=sections,
            document_structure_map=structured_guide.get("document_structure_map", {}),
        )
        
    except Exception as e:
        logger.error(f"LLM service error for book {book.id}, page {page_number}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="LLM service unavailable or failed.")

    if not db_guide_page:
        logger.error(f"Failed to save reading guide for book {book.id}, page {page_number} to DB.")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save reading guide.")
    
    logger.info(f"Successfully generated and saved reading guide for book {book.id}, page {page_number}")
    return db_guide_page


@router.get("/{book_id}/pages/{page_number}/reading-guide", response_model=Optional[ReadingGuidePageInDB], response_model_by_alias=False)
async def get_page_reading_guide(
    book_id: str,
    page_number: int,
    current_user_id: str = Depends(get_current_user_id)
):
    logger.info(f"Request to get reading guide for book {book_id}, page {page_number} by user {current_user_id}")
    
    if not ObjectId.is_valid(book_id):
        logger.warning(f"Get Page Guide: Invalid book_id format: {book_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")

    db_guide_page = await get_reading_guide_page(
        book_id=book_id, user_id=current_user_id, page_number=page_number
    )
    if not db_guide_page:
        logger.info(f"No reading guide found for book {book_id}, page {page_number}")
        return None 
    
    logger.info(f"Successfully retrieved reading guide for book {book_id}, page {page_number}")
    return db_guide_page


@router.post("/{book_id}/reading-guide", response_model=ReadingGuideInDB, response_model_by_alias=False)
async def generate_whole_book_reading_guide(
    book_id: str,
    current_user_id: str = Depends(get_current_user_id)
):
    """Generate or regenerate semantic whole-book roadmap."""
    logger.info(f"Request to generate whole-book reading roadmap for book {book_id} by user {current_user_id}")
    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")
    try:
        book = Book.model_validate(book_data_doc)
    except Exception as e:
        logger.error(f"Failed to validate book for roadmap generation: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Invalid book data.")

    if book.status != "completed" or not book.markdown_filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book processing not complete or markdown unavailable")
    if not CONTAINER_MARKDOWN_PATH:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server configuration error.")

    markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename)

    def read_file_sync(path):
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    full_markdown = await run_in_threadpool(read_file_sync, markdown_file_path)
    if not full_markdown:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown content not found.")

    heading_nodes = _extract_whole_book_heading_nodes(full_markdown)
    if not heading_nodes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid book content sections found.")

    items = await llm_service.generate_whole_book_reading_roadmap(
        heading_nodes=heading_nodes,
        book_title=book.title,
        full_markdown=full_markdown,
    )
    if not items:
        # deterministic fallback
        items = [{
            "id": n["id"],
            "title": n["title"],
            "takeaway": (n.get("snippet") or "")[:500],
            "thought_process": [],
            "reading_summary": (n.get("snippet") or "")[:280],
            "reading_bullets": [],
            "preview_text": (n.get("snippet") or "")[:250],
            "start_offset": n["start_offset"],
            "end_offset": n["end_offset"],
            "level": 1,
            "children": [],
            "key_term": None,
            "enriched": False,
        } for n in heading_nodes]

    db_guide = await upsert_reading_guide(book_id=book_id, user_id=current_user_id, items=items)
    if not db_guide:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save reading roadmap.")
    return db_guide


@router.get("/{book_id}/reading-guide", response_model=Optional[ReadingGuideInDB], response_model_by_alias=False)
async def get_whole_book_reading_guide(
    book_id: str,
    current_user_id: str = Depends(get_current_user_id)
):
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    guide = await get_reading_guide(book_id=book_id, user_id=current_user_id)
    if not guide:
        return None

    guide_dict = guide.model_dump(by_alias=True)
    items = guide_dict.get("items") or []
    _refresh_roadmap_graph_urls(items)
    guide_dict["items"] = items
    return guide_dict


@router.get("/{book_id}/reading-guide/progress")
async def get_whole_book_reading_guide_progress(
    book_id: str,
    current_user_id: str = Depends(get_current_user_id)
):
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    completed_ids = await get_reading_guide_progress(book_id=book_id, user_id=current_user_id)
    return {"completed_ids": completed_ids}


@router.post("/{book_id}/reading-guide/progress")
async def update_whole_book_reading_guide_progress(
    book_id: str,
    payload: ReadingGuideProgressUpdate = Body(...),
    current_user_id: str = Depends(get_current_user_id)
):
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    completed_ids = await update_reading_guide_progress(
        book_id=book_id,
        user_id=current_user_id,
        item_id=payload.item_id,
        completed=payload.completed,
    )
    return {"completed_ids": completed_ids}


@router.post("/{book_id}/reading-guide/cards/{card_id}/graph")
async def generate_roadmap_card_graph(
    book_id: str,
    card_id: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Generate an inline concept graph image for one roadmap card."""
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    guide = await get_reading_guide(book_id=book_id, user_id=current_user_id)
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reading roadmap not found.")

    item = _find_roadmap_item([i.model_dump() for i in guide.items], card_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card not found in roadmap.")

    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")
    book = Book.model_validate(book_data_doc)
    markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename) if CONTAINER_MARKDOWN_PATH else None
    if not markdown_file_path:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server configuration error.")

    def read_file_sync(path):
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    full_markdown = await run_in_threadpool(read_file_sync, markdown_file_path)
    if not full_markdown:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown content not found.")

    start = int(item.get("start_offset", 0))
    end = int(item.get("end_offset", min(len(full_markdown), start + 1200)))
    source_excerpt = full_markdown[max(0, start):min(len(full_markdown), end)]
    image_bytes = await llm_service.generate_graph_image_bytes(
        card_title=item.get("title", "Concept"),
        key_idea=item.get("takeaway", "") or item.get("reading_summary", "") or "",
        source_excerpt=source_excerpt,
    )
    if not image_bytes:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Graph generation failed.")

    app_images_path = os.path.join(CONTAINER_IMAGES_PATH, "app")
    relative_dir = os.path.join("guides", book_id)
    output_dir = os.path.join(app_images_path, relative_dir)
    os.makedirs(output_dir, exist_ok=True)
    safe_card = re.sub(r"[^a-zA-Z0-9_.-]+", "_", card_id)
    filename = f"{safe_card}_{int(time.time())}.png"
    full_path = os.path.join(output_dir, filename)
    with open(full_path, "wb") as f:
        f.write(image_bytes)

    relative_file = os.path.join(relative_dir, filename).replace("\\", "/")
    stable_graph_path = f"/images/app/{relative_file}"
    signed_url = generate_signed_image_url(relative_file)

    # Store a stable app-image path in DB; sign it on read/response.
    items = [i.model_dump() for i in guide.items]
    _set_roadmap_item_graph(items, card_id, stable_graph_path)
    await upsert_reading_guide(book_id=book_id, user_id=current_user_id, items=items)

    return {"card_id": card_id, "graph_image_url": signed_url}


@router.post("/{book_id}/reading-guide/cards/{card_id}/alternative-reading")
async def generate_roadmap_card_alternative_reading(
    book_id: str,
    card_id: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Generate and persist alternative reading text for one roadmap card."""
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format.")
    guide = await get_reading_guide(book_id=book_id, user_id=current_user_id)
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reading roadmap not found.")

    item = _find_roadmap_item([i.model_dump() for i in guide.items], card_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card not found in roadmap.")

    book_data_doc = await get_book(book_id, current_user_id)
    if not book_data_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found or not owned by user")
    book = Book.model_validate(book_data_doc)
    markdown_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, book.markdown_filename) if CONTAINER_MARKDOWN_PATH else None
    if not markdown_file_path:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server configuration error.")

    def read_file_sync(path):
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    full_markdown = await run_in_threadpool(read_file_sync, markdown_file_path)
    if not full_markdown:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Markdown content not found.")

    start = int(item.get("start_offset", 0))
    end = int(item.get("end_offset", min(len(full_markdown), start + 1800)))
    if end <= start:
        end = min(len(full_markdown), start + 1800)
    source_excerpt = full_markdown[max(0, start):min(len(full_markdown), end)]
    alternative_reading = await llm_service.generate_alternative_reading(
        card_title=item.get("title", "Section"),
        source_excerpt=source_excerpt,
    )
    if not alternative_reading:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Alternative reading generation failed.")

    items = [i.model_dump() for i in guide.items]
    _set_roadmap_item_alternative_reading(items, card_id, alternative_reading)
    saved_guide = await upsert_reading_guide(book_id=book_id, user_id=current_user_id, items=items)
    if not saved_guide:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to persist alternative reading.")

    return {"card_id": card_id, "alternative_reading": alternative_reading}


# Shared secret for app image HMAC signing (<img> cannot send Bearer). Set in .env for production.
APP_IMAGE_SECRET = os.getenv("APP_IMAGE_SECRET", "")
logger.info(
    f"App image secret configured: {bool(APP_IMAGE_SECRET)} "
    f"(length: {len(APP_IMAGE_SECRET) if APP_IMAGE_SECRET else 0}); "
    "without it, signed URLs in markdown cannot be verified."
)

# Signed URL TTL for embedded book images (refreshed on page navigation via refresh-image-urls).
SIGNED_URL_EXPIRATION = 3600  # seconds (1 hour)

def generate_signed_image_url(filepath: str) -> str:
    """
    Generate a signed URL for an app image that expires after SIGNED_URL_EXPIRATION seconds.
    The signature is based on filepath + timestamp + secret.
    """
    if not APP_IMAGE_SECRET:
        # Fallback to simple secret if signing not configured
        return f"/api/books/images/app/{filepath}?secret={urllib.parse.quote(APP_IMAGE_SECRET)}"
    
    # Generate expiration timestamp
    expires = int(time.time()) + SIGNED_URL_EXPIRATION
    
    # Create message to sign: filepath + expiration timestamp
    message = f"{filepath}:{expires}"
    
    # Generate HMAC signature
    signature = hmac.new(
        APP_IMAGE_SECRET.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    # Return signed URL
    return f"/api/books/images/app/{filepath}?expires={expires}&signature={signature}"

def verify_signed_url(filepath: str, expires: Optional[str], signature: Optional[str]) -> bool:
    """
    Verify that a signed URL is valid and not expired.
    """
    if not APP_IMAGE_SECRET or not expires or not signature:
        return False
    
    try:
        expires_int = int(expires)
        # Check if URL has expired
        if time.time() > expires_int:
            logger.debug(f"Signed URL expired: {filepath} (expired at {expires_int}, current time {int(time.time())})")
            return False
        
        # Recreate the message
        message = f"{filepath}:{expires_int}"
        
        # Recompute the signature
        expected_signature = hmac.new(
            APP_IMAGE_SECRET.encode('utf-8'),
            message.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        # Compare signatures (use constant-time comparison to prevent timing attacks)
        return hmac.compare_digest(signature, expected_signature)
    except (ValueError, TypeError):
        return False


def _extract_app_image_relative_path(image_path_raw: str) -> Optional[str]:
    """Normalize markdown/HTML image URL to filepath under app images (basename path, no leading slash)."""
    if not image_path_raw or not isinstance(image_path_raw, str):
        return None
    s = image_path_raw.strip()
    if not s:
        return None
    if s.startswith("<") and s.endswith(">"):
        s = s[1:-1].strip()
    parsed = urllib.parse.urlparse(s)
    path = (parsed.path or "").strip()
    if not path:
        path = s.split("?", 1)[0].strip()
    if not path:
        return None
    api_prefix = "/api/books/images/app/"
    img_prefix = "/images/app/"
    if path.startswith(api_prefix):
        rel = path[len(api_prefix) :].lstrip("/")
        return rel or None
    if path.startswith(img_prefix):
        rel = path[len(img_prefix) :].lstrip("/")
        return rel or None
    return None


def _sign_app_image_urls_in_markdown(markdown: str) -> str:
    """Replace /images/app/... and /api/books/images/app/... image references with freshly signed URLs."""

    def replace_md_image(match):
        full_match = match.group(0)
        image_path_raw = match.group(2)
        filename = _extract_app_image_relative_path(image_path_raw)
        if not filename:
            return full_match
        signed_url = generate_signed_image_url(filename)
        return full_match.replace(image_path_raw, signed_url)

    def replace_html_image(match):
        full_match = match.group(0)
        image_path_raw = match.group(2)
        filename = _extract_app_image_relative_path(image_path_raw)
        if not filename:
            return full_match
        signed_url = generate_signed_image_url(filename)
        return full_match.replace(image_path_raw, signed_url)

    out = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", replace_md_image, markdown)
    out = re.sub(r"<img ([^>]*src\s*=\s*['\"])([^'\"]+)(['\"][^>]*)>", replace_html_image, out)
    return out


@router.get("/images/app/{filepath:path}")
async def serve_app_image(
    filepath: str,
    request: Request,
    expires: Optional[str] = Query(None),
    signature: Optional[str] = Query(None),
    secret: Optional[str] = Query(None)  # Legacy support
):
    """
    Serves an app image file (from PDF processing).
    These images are only accessible through the reading_pal app.
    Accepts either:
    - Bearer token authentication (via Authorization header)
    - Signed URL with expiration (expires + signature query parameters)
    - Legacy: Shared secret key (via secret query parameter, deprecated)
    """
    logger.debug(f"App image request received - filepath: '{filepath}', has_signed_url: {bool(expires and signature)}, has_legacy_secret: {bool(secret)}")
    
    # Try to get user_id from token first (optional - won't raise if missing)
    current_user_id = None
    try:
        current_user_id = await get_current_user_id(request)
    except HTTPException:
        # No valid token, will check signed URL or legacy secret instead
        pass
    
    # Check authentication: Bearer token OR signed URL OR legacy secret
    is_authenticated = False
    
    if current_user_id:
        # User authenticated via Bearer token
        is_authenticated = True
        logger.debug(f"Serving app image: {filepath} for authenticated user: {current_user_id}")
    elif expires and signature:
        # Verify signed URL
        if verify_signed_url(filepath, expires, signature):
            is_authenticated = True
            logger.debug(f"Serving app image: {filepath} with valid signed URL")
        else:
            logger.warning(f"App image request denied - invalid or expired signed URL: {filepath}")
    elif APP_IMAGE_SECRET and secret == APP_IMAGE_SECRET:
        # Legacy: Valid secret key provided (deprecated, but kept for backward compatibility)
        is_authenticated = True
        logger.debug(f"Serving app image: {filepath} with legacy secret key")
    
    if not is_authenticated:
        logger.warning(f"App image request denied - no valid authentication: {filepath} (has_signed_url: {bool(expires and signature)}, has_legacy_secret: {bool(secret)}, current_user_id: {current_user_id})")
        raise HTTPException(
            status_code=403,
            detail="Access denied. App images require authentication or a valid signed URL.",
        )
    
    try:
        # Construct the full path to the app image file
        app_images_path = os.path.join(CONTAINER_IMAGES_PATH, "app")
        image_file_path = Path(app_images_path) / filepath

        logger.debug(f"App image request - filepath: {filepath}, full_path: {image_file_path}")

        if not image_file_path.exists() or not image_file_path.is_file():
            logger.warning(f"App image not found: {image_file_path} (exists: {image_file_path.exists()}, is_file: {image_file_path.is_file() if image_file_path.exists() else 'N/A'})")
            raise HTTPException(status_code=404, detail="Image not found")

        # Security check: ensure the resolved path is still within the app directory
        app_images_path_resolved = Path(app_images_path).resolve()
        if not image_file_path.resolve().is_relative_to(app_images_path_resolved):
            logger.error(f"Path traversal attempt detected: {filepath} resolved outside {app_images_path_resolved}")
            raise HTTPException(status_code=403, detail="Forbidden")

        return FileResponse(image_file_path)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Error serving app image {filepath}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")
