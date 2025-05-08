import asyncio
import os
import logging
from datetime import datetime, timedelta
from backend.db.mongodb import get_database, update_book # Import necessary DB functions

logger = logging.getLogger(__name__)

# Configuration for the cleanup task
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", 3600)) # Default: 1 hour
STUCK_JOB_THRESHOLD_SECONDS = int(os.getenv("STUCK_JOB_THRESHOLD_SECONDS", 24 * 3600)) # Default: 24 hours (corrected from 16400)
# Add configuration for deleting old records
OLD_RECORD_THRESHOLD_SECONDS = int(os.getenv("OLD_RECORD_THRESHOLD_SECONDS", 6 * 3600)) # Default: 6 hours

async def run_cleanup_task():
    """
    Periodically checks for:
    1. PDF processing jobs that appear stuck ('processing' status) and updates them to 'failed'.
    2. Old book records ('pending' or 'failed' status) and deletes them.
    """
    logger.info(f"Cleanup task started. Checking every {CLEANUP_INTERVAL_SECONDS} seconds.")
    logger.info(f" - Stuck 'processing' jobs older than {STUCK_JOB_THRESHOLD_SECONDS} seconds will be marked 'failed'.")
    logger.info(f" - Old 'pending' or 'failed' records older than {OLD_RECORD_THRESHOLD_SECONDS} seconds (based on created_at) will be deleted.")


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

            # --- Part 2: Delete old 'pending' or 'failed' records ---
            logger.info("Checking for old 'pending' or 'failed' records to delete...")
            old_record_delete_threshold_time = datetime.utcnow() - timedelta(seconds=OLD_RECORD_THRESHOLD_SECONDS)

            # Find books with 'pending' or 'failed' status created before the threshold time
            # We use 'created_at' for this, as 'updated_at' might change if a 'pending' job is retried or a 'failed' job is inspected.
            old_records_to_delete_cursor = db.books.find({
                "status": {"$in": ["pending", "failed"]},
                "created_at": {"$lt": old_record_delete_threshold_time}
            })

            records_to_delete = await old_records_to_delete_cursor.to_list(length=100) # Process in batches

            if records_to_delete:
                logger.warning(f"Found {len(records_to_delete)} old 'pending' or 'failed' records to delete (created_at < {old_record_delete_threshold_time}).")
                for record in records_to_delete:
                    book_id_to_delete_str = str(record["_id"])
                    record_status = record.get("status")
                    record_title = record.get("title", "Untitled")
                    record_job_id = record.get("job_id", "N/A")

                    logger.warning(f"Deleting old record (Book ID: {book_id_to_delete_str}, Job ID: {record_job_id}, Status: '{record_status}', Title: '{record_title}') as it's older than threshold.")
                    
                    # Perform the deletion
                    delete_result = await db.books.delete_one({"_id": record["_id"]})
                    
                    if delete_result.deleted_count > 0:
                        logger.info(f"Successfully deleted old record (Book ID: {book_id_to_delete_str}).")
                    else:
                        logger.error(f"Failed to delete old record (Book ID: {book_id_to_delete_str}). Record might have been deleted by another process.")
            else:
                logger.info("No old 'pending' or 'failed' records found for deletion.")

        except Exception as e:
            logger.error(f"An error occurred during cleanup task: {e}", exc_info=True)
