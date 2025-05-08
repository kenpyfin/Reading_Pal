import asyncio
import os
import logging
from datetime import datetime, timedelta
from backend.db.mongodb import get_database, update_book # Import necessary DB functions

logger = logging.getLogger(__name__)

# Configuration for the cleanup task
# Read from environment variables, provide defaults
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", 3600)) # Default: 1 hour
STUCK_JOB_THRESHOLD_SECONDS = int(os.getenv("STUCK_JOB_THRESHOLD_SECONDS", 86400)) # Default: 24 hours

async def run_cleanup_task():
    """
    Periodically checks for PDF processing jobs that appear stuck
    and updates their status to 'failed'.
    """
    logger.info(f"Cleanup task started. Checking every {CLEANUP_INTERVAL_SECONDS} seconds for jobs stuck for over {STUCK_JOB_THRESHOLD_SECONDS} seconds.")

    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        logger.info("Running cleanup check for stuck jobs...")

        try:
            db = get_database()
            if db is None:
                logger.error("Cleanup task: Database not initialized.")
                continue # Skip this cycle if DB is not ready

            # Calculate the time threshold
            stuck_threshold_time = datetime.utcnow() - timedelta(seconds=STUCK_JOB_THRESHOLD_SECONDS)

            # Find books with status 'processing' that haven't been updated recently
            # We use 'updated_at' to determine if the job is actively being worked on
            stuck_jobs_cursor = db.books.find({
                "status": "processing",
                "updated_at": {"$lt": stuck_threshold_time}
            })

            stuck_jobs = await stuck_jobs_cursor.to_list(length=100) # Limit the number of jobs processed per cycle

            if not stuck_jobs:
                logger.info("No stuck jobs found.")
                continue

            logger.warning(f"Found {len(stuck_jobs)} potentially stuck jobs. Attempting to mark as failed.")

            for job in stuck_jobs:
                book_id = str(job["_id"]) # Get the string ID
                job_id = job.get("job_id", "N/A")
                title = job.get("title", "Untitled")

                logger.warning(f"Marking job {job_id} (Book ID: {book_id}, Title: '{title}') as failed due to timeout.")

                # Update the book status to 'failed'
                update_success = await update_book(
                    book_id,
                    {
                        "status": "failed",
                        "processing_error": f"Processing timed out after {STUCK_JOB_THRESHOLD_SECONDS} seconds."
                    }
                )

                if update_success:
                    logger.info(f"Successfully marked job {job_id} (Book ID: {book_id}) as failed.")
                else:
                    logger.error(f"Failed to mark job {job_id} (Book ID: {book_id}) as failed in DB.")

        except Exception as e:
            logger.error(f"An error occurred during cleanup task: {e}", exc_info=True)

# Note: This function is intended to be run as an asyncio background task.
# It should NOT be called directly in a way that blocks the event loop.
# backend/main.py already includes the necessary asyncio.create_task call.
