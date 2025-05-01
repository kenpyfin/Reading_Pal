import os
import logging
import requests # Import requests for the status check proxy
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from typing import List
from bson import ObjectId
from fastapi.concurrency import run_in_threadpool

# Assuming pdf_client is correctly imported
from backend.services.pdf_client import process_pdf_with_service
# Assuming mongodb functions are correctly imported
from backend.db.mongodb import save_book, get_book, get_database
# Assuming Book model is correctly imported
from backend.models.book import Book

logger = logging.getLogger(__name__)
router = APIRouter()

# Retrieve container paths from environment variables
CONTAINER_IMAGES_PATH = "/app/storage/images"
CONTAINER_MARKDOWN_PATH = "/app/storage/markdown"

logger.info(f"API Books: CONTAINER_IMAGES_PATH = {CONTAINER_IMAGES_PATH}")
logger.info(f"API Books: CONTAINER_MARKDOWN_PATH = {CONTAINER_MARKDOWN_PATH}")

# Get PDF Service URL from environment variables
PDF_CLIENT_URL = os.getenv("PDF_CLIENT_URL")
if not PDF_CLIENT_URL:
    logger.error("PDF_CLIENT_URL environment variable is not set.")
    # Depending on severity, you might want to raise an error here or handle it per request
    # For now, log and handle per request.


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
        # process_pdf_with_service returns the *initial* response from the PDF service
        # which includes job_id and initial status (e.g., 'pending')
        # This call is synchronous, so run it in a threadpool
        processed_data = await run_in_threadpool(process_pdf_with_service, file, title)

        # Add logging for the initial response from PDF service
        logger.info(f"Upload endpoint: Received initial response from PDF service: {processed_data}")

        if not processed_data or not processed_data.get("success"):
             # Use the message from the PDF service if available
             error_detail = processed_data.get("message", "PDF processing initiation failed")
             logger.error(f"PDF service initiation failed: {error_detail}")
             raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=error_detail)

        # --- Correctly extract initial data ---
        job_id = processed_data.get("job_id")
        initial_status = processed_data.get("status", "pending") # Default to 'pending' if not provided

        if not job_id:
            logger.error("PDF service did not return a job_id.")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="PDF processing service failed to return a job ID.")

        # Determine the title to save
        book_title = title if title else os.path.splitext(file.filename)[0]

        # --- Prepare data for initial database save ---
        # Store only the essential info needed to track the job initially
        book_data = {
            "title": book_title,
            "original_filename": file.filename,
            "job_id": job_id, # Store the job ID for status polling
            "status": initial_status, # Store the initial status
            # These will be populated later when processing is complete via the status check endpoint
            "markdown_filename": None,
            "image_filenames": [],
        }

        logger.info(f"Upload endpoint: Data prepared for DB save: {book_data}")

        # Save the initial book record
        book_id_obj = await save_book(book_data) # save_book should return the ObjectId
        book_id_str = str(book_id_obj)
        logger.info(f"Book saved with ID: {book_id_str}")

        # --- Return the newly created book record ---
        # Construct the response based on the data we just saved
        response_data = {
            "_id": book_id_str,
            "title": book_title,
            "original_filename": file.filename,
            "job_id": job_id,
            "status": initial_status,
            "markdown_content": None, # Not available yet
            "image_urls": [] # Not available yet
        }

        logger.info(f"Upload endpoint: Returning initial book data for ID {book_id_str}")
        # Use the Book model to validate and structure the response
        return Book(**response_data)

    except HTTPException as e:
        # Re-raise FastAPI HTTPExceptions
        raise e
    except Exception as e:
        logger.error(f"Error during PDF upload initiation: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error during upload: {e}")


@router.get("/", response_model=List[Book])
async def list_books():
    """
    Retrieves a list of all books from the database, including status and job_id.
    Does NOT include full markdown content or image URLs in the list view.
    """
    logger.info("Received request to list all books")
    database = get_database()
    if database is None:
         logger.error("Database not initialized for list_books.")
         raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database not initialized.")

    try:
        # Fetch all book documents. Project necessary fields for the list view.
        # Include _id, title, original_filename, status, job_id
        books_cursor = database.books.find({}, {
            "title": 1,
            "original_filename": 1,
            "status": 1, # Include status
            "job_id": 1 # Include job_id
        })
        books_list = await books_cursor.to_list(length=1000) # Adjust length as needed

        response_list = []
        for book_doc in books_list:
             # Ensure default values if fields are missing, though they should exist
             response_data = {
                 "_id": str(book_doc["_id"]), # Convert ObjectId to string
                 "title": book_doc.get("title", "Untitled"),
                 "original_filename": book_doc.get("original_filename", "N/A"),
                 "status": book_doc.get("status"), # Get status
                 "job_id": book_doc.get("job_id"), # Get job_id
                 # These fields are not needed/available for the list view
                 "markdown_content": None,
                 "image_urls": []
             }
             # Validate with the Pydantic model before appending
             response_list.append(Book(**response_data))

        logger.info(f"Returning list of {len(response_list)} books.")
        return response_list

    except Exception as e:
        logger.error(f"Error listing books: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error retrieving books: {e}")


# --- get_book_by_id remains largely the same, but ensure it handles cases ---
# --- where markdown_filename might still be None if processing failed ---
@router.get("/{book_id}", response_model=Book)
async def get_book_by_id(book_id: str):
    """
    Retrieves book data by its ID, reads markdown content from file if available.
    """
    logger.info(f"Received request for book ID: {book_id}")
    if not ObjectId.is_valid(book_id):
        logger.warning(f"Invalid book ID format received: {book_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    # get_book should fetch the full document
    book_data_doc = await get_book(book_id)

    logger.info(f"Get endpoint: Retrieved book document from DB: {book_data_doc}")

    if book_data_doc:
        logger.info(f"Get endpoint: Book found in DB for ID: {book_id}")

        # Retrieve filenames, status, and job_id from the DB document
        stored_markdown_filename = book_data_doc.get("markdown_filename")
        stored_image_filenames = book_data_doc.get("image_filenames", [])
        book_status = book_data_doc.get("status") # Get the status
        job_id = book_data_doc.get("job_id") # Get the job_id

        logger.info(f"Get endpoint: Retrieved markdown_filename from DB: {stored_markdown_filename}")
        logger.info(f"Get endpoint: Retrieved image_filenames from DB: {stored_image_filenames}")
        logger.info(f"Get endpoint: Retrieved status from DB: {book_status}")
        logger.info(f"Get endpoint: Retrieved job_id from DB: {job_id}")


        markdown_content = None # Default to None
        image_urls = [] # Default to empty list

        # Only attempt to read markdown and generate URLs if processing is completed
        # And the markdown filename exists (it should if status is completed)
        if book_status == 'completed' and stored_markdown_filename:
            container_markdown_path = None
            if CONTAINER_MARKDOWN_PATH: # Ensure base path is set
                container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, stored_markdown_filename)

            logger.info(f"Get endpoint: Constructed container markdown path: {container_markdown_path}")

            if container_markdown_path and os.path.exists(container_markdown_path):
                logger.info(f"Get endpoint: Markdown file found at container path: {container_markdown_path}. Attempting to read...")
                try:
                    # Use run_in_threadpool for file I/O
                    markdown_content = await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), container_markdown_path)
                    logger.info(f"Get endpoint: Successfully read markdown content (length: {len(markdown_content)}) from {container_markdown_path}")
                    if not markdown_content.strip():
                         logger.warning(f"Get endpoint: Markdown content read from {container_markdown_path} is empty or only whitespace.")
                except Exception as file_read_error:
                    logger.error(f"Get endpoint: Failed to read markdown file {container_markdown_path} for book ID {book_id}: {file_read_error}", exc_info=True)
                    markdown_content = f"Error: Could not read processed content. {file_read_error}" # Provide error in content
            else:
                 logger.error(f"Get endpoint: Markdown file path missing or file not found: {container_markdown_path} for completed book ID {book_id}.")
                 markdown_content = "Error: Processed content file not found." # Provide error in content

            # Generate image URLs only if processing completed and image filenames are stored
            if stored_image_filenames:
                 image_urls = [f"/images/{filename}" for filename in stored_image_filenames]
                 logger.info(f"Get endpoint: Generated {len(image_urls)} image URLs: {image_urls}")
            else:
                 logger.info(f"Get endpoint: No image filenames stored for completed book ID {book_id}.")


        elif book_status != 'completed':
             logger.info(f"Get endpoint: Book status is '{book_status}'. Not attempting to read markdown or generate image URLs.")
             # Optionally set markdown_content to a message indicating status
             # markdown_content = f"Book status: {book_status}. Content not available yet."


        # Construct the response model including status and job_id
        response_data = {
            "_id": str(book_data_doc["_id"]),
            "title": book_data_doc.get("title"),
            "original_filename": book_data_doc.get("original_filename"),
            "job_id": job_id, # Include job_id
            "status": book_status, # Include status
            "markdown_content": markdown_content, # Include content (read from file) or error/status message
            "image_urls": image_urls # Include generated URLs or empty list
        }
        logger.info(f"Get endpoint: Returning book data for ID {book_id}")

        # Validate response with the model
        return Book(**response_data)
    else:
        logger.warning(f"Get endpoint: Book not found in DB for ID: {book_id}")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")


# --- Add the status endpoint ---
@router.get("/status/{job_id}")
async def get_book_status_by_job_id(job_id: str):
    """
    Proxies the status request to the PDF processing service and updates the DB
    if the job is completed or failed.
    Returns the PDF service's status format.
    """
    logger.info(f"Received status check request for job_id: {job_id}")
    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL is not set for status check.")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="PDF processing service URL is not configured.")

    pdf_service_status_url = f"{PDF_CLIENT_URL}/status/{job_id}"

    try:
        # Use run_in_threadpool for the synchronous requests call
        async def fetch_status():
            response = requests.get(pdf_service_status_url)
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
            return response.json()

        status_data = await run_in_threadpool(fetch_status)
        logger.info(f"Received status data from PDF service for job_id {job_id}: {status_data}")

        # --- IMPORTANT: Update DB if status is completed or failed ---
        # This is where the backend learns about the final filenames and status
        current_status = status_data.get("status")
        if current_status in ["completed", "failed"]:
            database = get_database()
            if database:
                # Find the book by job_id
                book_doc = await database.books.find_one({"job_id": job_id})
                if book_doc:
                    # Only update if the status in the DB is different
                    if book_doc.get("status") != current_status:
                        update_fields = {"status": current_status}
                        if current_status == "completed":
                            # Extract filenames from the PDF service response
                            markdown_host_path = status_data.get("file_path")
                            images_info = status_data.get("images", []) # List of {'filename': '...', 'path': '...'}

                            if markdown_host_path:
                                update_fields["markdown_filename"] = os.path.basename(markdown_host_path)
                            if images_info:
                                update_fields["image_filenames"] = [img.get("filename") for img in images_info if img.get("filename")]

                            logger.info(f"Updating book record for completed job {job_id} with fields: {update_fields}")
                            await database.books.update_one({"job_id": job_id}, {"$set": update_fields})
                        elif current_status == "failed":
                             logger.info(f"Updating book record for failed job {job_id} with status: failed")
                             await database.books.update_one({"job_id": job_id}, {"$set": update_fields})
                    else:
                         logger.info(f"Book record for job {job_id} already has status '{current_status}'. No DB update needed.")
                else:
                    logger.warning(f"Book record with job_id {job_id} not found in DB for status update.")
            else:
                 logger.error(f"Database not available to update status for job_id {job_id}")


        # Return the raw status data from the PDF service
        return status_data

    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            logger.warning(f"Job ID {job_id} not found in PDF service.")
            # Return a 404 response matching the PDF service's likely behavior
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job ID {job_id} not found in processing service.")
        else:
            logger.error(f"HTTP error fetching status for job_id {job_id} from PDF service: {e}", exc_info=True)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Error fetching status from PDF service: {e}")
    except requests.exceptions.RequestException as e:
        logger.error(f"Connection error fetching status for job_id {job_id} from PDF service: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=f"Could not connect to PDF processing service: {e}")
    except Exception as e:
        logger.error(f"Unexpected error fetching status for job_id {job_id}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"An unexpected error occurred: {e}")
