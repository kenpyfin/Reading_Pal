import asyncio
import os
import logging
from datetime import datetime, timedelta
from backend.db.mongodb import get_database, update_book # delete_book_record is not directly used here for deletion, we use db.books.delete_one
from fastapi.concurrency import run_in_threadpool # For async file operations

logger = logging.getLogger(__name__)

# Configuration for the cleanup task
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", 3600)) # Default: 1 hour
STUCK_JOB_THRESHOLD_SECONDS = int(os.getenv("STUCK_JOB_THRESHOLD_SECONDS", 24 * 3600))
OLD_RECORD_THRESHOLD_SECONDS = int(os.getenv("OLD_RECORD_THRESHOLD_SECONDS", 6 * 3600)) # Default: 6 hours

# Get container paths for file deletion
# These must be the paths accessible from within the backend container
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH") # e.g., /app/storage/markdown
CONTAINER_IMAGES_PATH = os.getenv("IMAGES_PATH")   # e.g., /app/storage/images

async def delete_file_async(file_path: str):
    """Asynchronously deletes a file if it exists."""
    try:
        if await run_in_threadpool(os.path.exists, file_path):
            await run_in_threadpool(os.remove, file_path)
            logger.info(f"Cleanup: Successfully deleted file: {file_path}")
        else:
            logger.info(f"Cleanup: File not found, skipping deletion: {file_path}")
    except Exception as e:
        logger.error(f"Cleanup: Error deleting file {file_path}: {e}", exc_info=True)

async def run_cleanup_task():
    """
    Periodically checks for:
    1. PDF processing jobs that appear stuck ('processing' status) and updates them to 'failed'.
    2. Old book records ('pending' or 'failed' status) and deletes them along with associated files.
    """
    logger.info(f"Cleanup task started. Checking every {CLEANUP_INTERVAL_SECONDS} seconds.")
    logger.info(f" - Stuck 'processing' jobs older than {STUCK_JOB_THRESHOLD_SECONDS} seconds will be marked 'failed'.")
    logger.info(f" - Old 'pending' or 'failed' records older than {OLD_RECORD_THRESHOLD_SECONDS} seconds (based on created_at) will be deleted with their files.")
    if not CONTAINER_MARKDOWN_PATH:
        logger.warning("Cleanup task: MARKDOWN_PATH (for container) is not set. Markdown file cleanup will be skipped.")
    if not CONTAINER_IMAGES_PATH:
        logger.warning("Cleanup task: IMAGES_PATH (for container) is not set. Image file cleanup will be skipped.")


    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        logger.info("Running cleanup cycle...")

        try:
            db = get_database()
            if db is None:
                logger.error("Cleanup task: Database not initialized.")
                continue

            # --- Part 1: Mark stuck 'processing' jobs as 'failed' ---
            logger.info("Checking for stuck 'processing' jobs...")
            stuck_threshold_time = datetime.utcnow() - timedelta(seconds=STUCK_JOB_THRESHOLD_SECONDS)
            
            stuck_jobs_cursor = db.books.find({
                "status": "processing",
                "updated_at": {"$lt": stuck_threshold_time}
            })
            
            stuck_jobs_to_update = await stuck_jobs_cursor.to_list(length=100) # Process in batches

            if stuck_jobs_to_update:
                logger.warning(f"Found {len(stuck_jobs_to_update)} potentially stuck 'processing' jobs. Attempting to mark as failed.")
                for job in stuck_jobs_to_update:
                    book_id_str = str(job["_id"])
                    job_id_val = job.get("job_id", "N/A") # Renamed to avoid conflict
                    title_val = job.get("title", "Untitled") # Renamed to avoid conflict

                    logger.warning(f"Marking 'processing' job {job_id_val} (Book ID: {book_id_str}, Title: '{title_val}') as failed due to timeout (updated_at < {stuck_threshold_time}).")
                    
                    update_result = await update_book( # update_book should ideally return a boolean or modified_count
                        book_id_str,
                        {
                            "status": "failed",
                            "processing_error": f"Processing timed out after {STUCK_JOB_THRESHOLD_SECONDS} seconds (based on updated_at).",
                            "updated_at": datetime.utcnow() # Explicitly set updated_at
                        }
                    )
                    if update_result: # Assuming update_book returns something truthy on success
                        logger.info(f"Successfully marked 'processing' job {job_id_val} (Book ID: {book_id_str}) as failed.")
                    else:
                        logger.error(f"Failed to mark 'processing' job {job_id_val} (Book ID: {book_id_str}) as failed in DB.")
            else:
                logger.info("No stuck 'processing' jobs found.")

            # --- Part 2: Delete old 'pending' or 'failed' records AND THEIR FILES ---
            logger.info("Checking for old 'pending' or 'failed' records to delete...")
            old_record_delete_threshold_time = datetime.utcnow() - timedelta(seconds=OLD_RECORD_THRESHOLD_SECONDS)

            old_records_to_delete_cursor = db.books.find({
                "status": {"$in": ["pending", "failed"]},
                "created_at": {"$lt": old_record_delete_threshold_time}
            })

            records_to_delete = await old_records_to_delete_cursor.to_list(length=100)

            if records_to_delete:
                logger.warning(f"Found {len(records_to_delete)} old 'pending' or 'failed' records to delete (created_at < {old_record_delete_threshold_time}).")
                for record_doc in records_to_delete: # Renamed to avoid conflict
                    book_id_to_delete_str = str(record_doc["_id"])
                    record_status = record_doc.get("status")
                    record_title = record_doc.get("title", "Untitled")
                    record_job_id = record_doc.get("job_id", "N/A")
                    markdown_filename = record_doc.get("markdown_filename")
                    image_filenames = record_doc.get("image_filenames", [])

                    logger.warning(f"Preparing to delete old record (Book ID: {book_id_to_delete_str}, Job ID: {record_job_id}, Status: '{record_status}', Title: '{record_title}') and its files.")

                    # Delete associated files first
                    # 1. Delete Markdown file
                    if markdown_filename and CONTAINER_MARKDOWN_PATH:
                        md_file_path = os.path.join(CONTAINER_MARKDOWN_PATH, markdown_filename)
                        await delete_file_async(md_file_path)
                    elif markdown_filename and not CONTAINER_MARKDOWN_PATH:
                        logger.warning(f"Cleanup: Cannot delete markdown file for Book ID {book_id_to_delete_str} because CONTAINER_MARKDOWN_PATH is not set.")

                    # 2. Delete Image files
                    if image_filenames and CONTAINER_IMAGES_PATH:
                        for img_fn in image_filenames:
                            if img_fn: # Ensure filename is not empty
                                img_file_path = os.path.join(CONTAINER_IMAGES_PATH, img_fn)
                                await delete_file_async(img_file_path)
                    elif image_filenames and not CONTAINER_IMAGES_PATH:
                        logger.warning(f"Cleanup: Cannot delete image files for Book ID {book_id_to_delete_str} because CONTAINER_IMAGES_PATH is not set.")

                    # Perform the database record deletion
                    delete_db_result = await db.books.delete_one({"_id": record_doc["_id"]})

                    if delete_db_result.deleted_count > 0:
                        logger.info(f"Successfully deleted old DB record (Book ID: {book_id_to_delete_str}).")
                    else:
                        logger.error(f"Failed to delete old DB record (Book ID: {book_id_to_delete_str}). Record might have been deleted by another process.")
            else:
                logger.info("No old 'pending' or 'failed' records found for deletion.")

        except Exception as e:
            logger.error(f"An error occurred during cleanup task: {e}", exc_info=True)
