import os
import logging
import sys
import uuid # Import uuid for generating job IDs
from typing import Optional, List, Dict, Any # Import Dict and Any
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks # Import BackgroundTasks
from pydantic import BaseModel
import torch
from dotenv import load_dotenv
from magic_pdf.data.data_reader_writer import FileBasedDataWriter, FileBasedDataReader
from magic_pdf.config.make_content_config import DropMode, MakeMode
from magic_pdf.pipe.OCRPipe import OCRPipe
from torch.cuda.amp import autocast
import re # Import the regex module
from contextlib import nullcontext # Import nullcontext for Python 3.7+
import ollama # Import the ollama library
import asyncio # Import asyncio for background tasks

# Initialize FastAPI app
app = FastAPI(title="PDF Processing Service")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
# Only load dotenv if running directly, not when imported by uvicorn
if __name__ == "__main__":
    load_dotenv()
else:
    # When run by uvicorn, env vars are typically set externally (e.g., docker-compose)
    # Ensure they are available, but don't re-load from .env file
    pass # Assume env vars are already loaded

# Get paths from environment variables
PDF_STORAGE_PATH = os.getenv('PDF_STORAGE_PATH')
MARKDOWN_PATH = os.getenv('MARKDOWN_PATH')
IMAGES_PATH = os.getenv('IMAGES_PATH')

# Get Ollama configuration from environment variables
OLLAMA_API_BASE = os.getenv('OLLAMA_API_BASE')
# Use LLM_MODEL from .env for the reformatting model
OLLAMA_REFORMAT_MODEL = os.getenv('OLLAMA_REFORMAT_MODEL') # Use the general LLM_MODEL setting


# --- In-memory storage for job status and results ---
# In a production system, this should be a persistent store (DB, Redis, etc.)
# as restarting the service will lose job information.
job_status: Dict[str, Dict[str, Any]] = {}

# --- Helper function to sanitize filename ---
def sanitize_filename(filename: str) -> str:
    """Replaces spaces with underscores and removes potentially problematic characters."""
    # Replace spaces with underscores
    sanitized = filename.replace(' ', '_')
    # Remove characters that are not alphanumeric, underscores, hyphens, or periods
    # Keep periods for file extensions
    sanitized = re.sub(r'[^\w.-]', '', sanitized)
    # Optional: Limit length or handle leading/trailing periods/underscores
    return sanitized

def ensure_storage_paths():
    """Ensure all required storage directories exist with proper permissions"""
    paths = [PDF_STORAGE_PATH, MARKDOWN_PATH, IMAGES_PATH]
    for path in paths:
        if not path:
             logger.critical(f"Storage path environment variable is not set: {path}")
             raise ValueError(f"Storage path environment variable is not set.")
        try:
            os.makedirs(path, exist_ok=True)
            # Set permissions - 0o755 means owner can read/write/execute, group/others can read/execute
            # This is often sufficient for shared volumes
            os.chmod(path, 0o755)
            logger.info(f"Storage directory ensured: {path}")
        except Exception as e:
            logger.error(f"Error creating/configuring directory {path}: {e}")
            raise RuntimeError(f"Failed to setup storage directory {path}: {e}")

# Ensure storage paths with error handling
try:
    ensure_storage_paths()
except Exception as e:
    logger.critical(f"Failed to initialize storage paths: {e}")
    sys.exit(1)

class ImageInfo(BaseModel):
    filename: str
    path: str

# --- Updated ProcessResponse model for async initiation ---
class ProcessResponse(BaseModel):
    success: bool
    message: str
    job_id: str
    status: str # e.g., "pending", "processing"

# --- New StatusResponse model for checking job status ---
class StatusResponse(BaseModel):
    success: bool
    message: str
    job_id: str
    status: str # e.g., "pending", "processing", "completed", "failed"
    title: Optional[str] = None
    file_path: Optional[str] = None # Path to the saved markdown file
    images: Optional[List[ImageInfo]] = None # List of image info


# RENAME function and update logic to use Ollama
def reformat_markdown_with_ollama(md_text):
    # Check if Ollama configuration is available
    if not OLLAMA_API_BASE or not OLLAMA_REFORMAT_MODEL:
        logger.warning("OLLAMA_API_BASE or LLM_MODEL not set. Skipping markdown reformatting.")
        return md_text # Return original text if config is not available

    try:
        # Use the synchronous Ollama client
        client = ollama.Client(host=OLLAMA_API_BASE)
        # Optional: Check if the model exists (can add overhead)
        # client.show(OLLAMA_REFORMAT_MODEL) # This would raise an error if model doesn't exist
        logger.info(f"Ollama client initialized for reformatting at {OLLAMA_API_BASE} using model {OLLAMA_REFORMAT_MODEL}.")
    except Exception as e:
        logger.error(f"Failed to initialize Ollama client or check model: {e}. Skipping markdown reformatting.")
        return md_text # Return original text if client initialization fails


    # Approximate tokens per character (this is a rough estimate)
    TOKENS_PER_CHAR = 0.25
    # Leave room for system prompt and other message components
    # Adjust max tokens based on typical Ollama model context windows (e.g., 8192, 32768)
    # Let's use a conservative chunk size, but allow larger if needed.
    # Max tokens for response + prompt should fit within model context.
    # Assuming a model with at least 8192 context, leave ~6000 for the chunk.
    MAX_CHUNK_CHARS = int(6000 / TOKENS_PER_CHAR) # Roughly 24000 characters per chunk

    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS)
    reformatted_chunks = []
    # Adjust prompt for a general Ollama model
    system_prompt = "You are a helpful assistant that reformats markdown text to be more readable and consistent. Preserve all original content, including text, headings, lists, code blocks, and image links. Only output the reformatted markdown without any conversational filler."

    for i, chunk in enumerate(chunks):
        try:
            logger.info(f"Reformatting markdown chunk {i+1}/{len(chunks)} using Ollama...")
            # Use the chat endpoint
            response = client.chat(
                model=OLLAMA_REFORMAT_MODEL,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': f"Reformat this markdown:\n\n{chunk}"}
                ],
                options={
                    'temperature': 0.1, # Keep temperature low for consistent reformatting
                    'num_predict': -1 # Generate until the model stops (within context limits)
                }
            )
            reformatted_chunk = response['message']['content'] if response and 'message' in response else ""
            reformatted_chunks.append(reformatted_chunk)
            logger.info(f"Finished reformatting chunk {i+1}.")
        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Ollama: {e}")
            # Fallback: return the original chunk if reformatting fails
            reformatted_chunks.append(chunk)

    # Combine all reformatted chunks
    return "\n\n".join(reformatted_chunks)


def split_markdown_into_chunks(md_text: str, max_chunk_size: int = 10000, max_chunks: int = 10) -> List[str]:
    """Split markdown text into chunks based on max_chunk_size and limit to max_chunks."""
    """Split markdown text into chunks based on max_chunk_size and limit to max_chunks."""
    # Initial splitting based on max_chunk_size
    chunks = []
    current_chunk = ''

    # Split by lines first
    lines = md_text.split('\n')

    for line in lines:
        # Check if adding the current line plus a newline separator exceeds the max size
        # Add 1 for the potential newline character
        if len(current_chunk) + len(line) + 1 > max_chunk_size and current_chunk:
            chunks.append(current_chunk.strip())
            current_chunk = line
        else:
            # Add newline before the line if current_chunk is not empty
            current_chunk += ('\n' + line) if current_chunk else line

    # Add the last chunk if it's not empty
    if current_chunk:
        chunks.append(current_chunk.strip())

    # If the number of chunks exceeds max_chunks, recombine them
    # This part aims to merge smaller chunks if the initial split was too granular
    if len(chunks) > max_chunks:
        logger.warning(f"Initial markdown split resulted in {len(chunks)} chunks, exceeding max_chunks {max_chunks}. Recombining...")
        combined_chunks = []
        current_chunk = ''
        chunk_count = 0

        # Calculate an approximate target length per chunk after combining
        total_length = sum(len(chunk) for chunk in chunks)
        avg_length = total_length // max_chunks if max_chunks > 0 else total_length # Avoid division by zero

        for chunk in chunks:
             # Check if adding the current chunk exceeds the average length AND we haven't reached the max chunk count yet
             # This heuristic tries to make chunks roughly equal, but respects the max_chunks limit
            if len(current_chunk) + len(chunk) + 1 > avg_length and chunk_count < max_chunks - 1:
                combined_chunks.append(current_chunk.strip())
                current_chunk = chunk
                chunk_count += 1
            else:
                current_chunk += ('\n\n' + chunk) if current_chunk else chunk # Use double newline for separation

        # Add the last combined chunk
        if current_chunk:
            combined_chunks.append(current_chunk.strip())

        # If after combining we still have more than max_chunks (shouldn't happen with the logic above, but as a safeguard)
        # or if the combining logic resulted in fewer than max_chunks, just use the combined list.
        # If combined_chunks is empty but original chunks wasn't, add the original text as a single chunk.
        if not combined_chunks and chunks:
             return [md_text] # Fallback to single chunk if combining failed

        chunks = combined_chunks
        logger.warning(f"Recombined into {len(chunks)} chunks.")

    # Final check to ensure no empty chunks are returned
    return [chunk for chunk in chunks if chunk]


# --- Background task function for PDF processing ---
async def perform_pdf_processing(job_id: str, temp_pdf_path: str, sanitized_title: str):
    """
    Performs the actual PDF processing in a background task.
    Updates the global job_status dictionary upon completion or failure.
    """
    logger.info(f"Job {job_id}: Starting background PDF processing for {temp_pdf_path}")
    job_status[job_id]["status"] = "processing"

    try:
        # Read PDF bytes
        reader = FileBasedDataReader("")
        # Use sync file read in threadpool if needed, but magic_pdf might handle async internally
        # For simplicity here, assuming magic_pdf can work with the file path directly or sync read is okay in background task
        pdf_bytes = reader.read(temp_pdf_path)

        # Configure CUDA if available
        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
            torch.backends.cudnn.benchmark = True
            torch.backends.cudnn.enabled = True
            torch.set_default_dtype(torch.float32)
            torch.set_default_tensor_type(torch.cuda.FloatTensor)
            logger.info(f"Job {job_id}: CUDA available and configured.")
        else:
            logger.warning(f"Job {job_id}: CUDA not available. Using CPU.")


        # Initialize and run OCR pipeline
        # Use autocast only if CUDA is available
        context_manager = autocast(dtype=torch.float16) if torch.cuda.is_available() else nullcontext() # Need nullcontext from contextlib

        with context_manager:
            model_list = [] # Configure models if needed
            image_writer = FileBasedDataWriter(IMAGES_PATH)
            pipe = OCRPipe(pdf_bytes, model_list, image_writer)
            logger.info(f"Job {job_id}: Running OCRPipe pipeline...")
            pipe.pipe_classify()
            pipe.pipe_analyze()
            pipe.pipe_parse()
            logger.info(f"Job {job_id}: OCRPipe analysis complete.")

            # Generate markdown content
            md_content = pipe.pipe_mk_markdown(
                IMAGES_PATH, # Pass the image directory path
                drop_mode=DropMode.NONE,
                md_make_mode=MakeMode.MM_MD
            )
            logger.info(f"Job {job_id}: Initial markdown generated.")

        # Ensure md_content is a string
        if isinstance(md_content, list):
            md_text = "\n".join(md_content)
        elif isinstance(md_content, str):
            md_text = md_content
        else:
            logger.error(f"Job {job_id}: Unexpected markdown content type: {type(md_content)}")
            md_text = "" # Default to empty string on unexpected type

        # Reformat markdown using Ollama (UPDATED CALL)
        logger.info(f"Job {job_id}: Reformatting markdown with Ollama...")
        reformatted_md_text = reformat_markdown_with_ollama(md_text) # Call the new function
        logger.info(f"Job {job_id}: Markdown reformatting complete.")

        # Save markdown content to a file using the sanitized title
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}.md") # Use the sanitized title
        logger.info(f"Job {job_id}: Saving reformatted markdown to: {markdown_file_path}")

        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text)

        logger.info(f"Job {job_id}: PDF processed and converted to markdown successfully")

        # Get list of generated images
        images = []
        if os.path.exists(IMAGES_PATH):
            # Image files generated by OCRPipe use the base filename as a prefix
            # We need to look for files starting with the sanitized title
            image_prefix = sanitized_title
            logger.info(f"Job {job_id}: Looking for images with prefix: {image_prefix} in {IMAGES_PATH}")
            try:
                for img_file in os.listdir(IMAGES_PATH):
                    # Check if the file starts with the sanitized prefix and is a PNG
                    # OCRPipe typically generates PNGs
                    if img_file.startswith(image_prefix) and img_file.lower().endswith('.png'):
                        full_img_path = os.path.join(IMAGES_PATH, img_file)
                        images.append(ImageInfo(
                            filename=img_file,
                            path=full_img_path # This is the path on the PDF service host
                        ))
                logger.info(f"Job {job_id}: Found {len(images)} image files matching prefix '{image_prefix}'.")
            except Exception as e:
                 logger.error(f"Job {job_id}: Error listing images in {IMAGES_PATH}: {e}")


        # Update job status with completion details
        job_status[job_id]["status"] = "completed"
        job_status[job_id]["success"] = True
        job_status[job_id]["message"] = "Processing complete"
        job_status[job_id]["file_path"] = markdown_file_path
        job_status[job_id]["images"] = images
        job_status[job_id]["title"] = sanitized_title # Store sanitized title for status response

    except Exception as e:
        logger.error(f"Job {job_id}: Error during background PDF processing: {e}", exc_info=True)
        # Update job status with failure details
        job_status[job_id]["status"] = "failed"
        job_status[job_id]["success"] = False
        job_status[job_id]["message"] = f"Processing failed: {e}"
    finally:
        # Cleanup temporary file regardless of success or failure
        try:
            if os.path.exists(temp_pdf_path):
                os.remove(temp_pdf_path)
                logger.info(f"Job {job_id}: Cleaned up temporary file: {temp_pdf_path}")
        except Exception as e:
            logger.error(f"Job {job_id}: Failed to cleanup temp file {temp_pdf_path}: {e}")


@app.post("/process-pdf", response_model=ProcessResponse)
async def process_pdf(
    background_tasks: BackgroundTasks, # Inject BackgroundTasks
    file: UploadFile = File(...),
    title: Optional[str] = None
):
    """
    Receives a PDF file, saves it temporarily, starts a background processing task,
    and immediately returns a job ID and status.
    """
    logger.info(f"Received request to process PDF: {file.filename}")
    job_id = str(uuid.uuid4()) # Generate a unique job ID
    base_title = title if title else os.path.splitext(file.filename)[0]
    sanitized_title = sanitize_filename(base_title)

    # Initialize job status
    job_status[job_id] = {
        "status": "pending",
        "success": False, # Default to False
        "message": "Job queued",
        "title": base_title, # Store original title for response
        "file_path": None,
        "images": None,
    }
    logger.info(f"Created job {job_id} for file {file.filename}")

    # Save uploaded file temporarily using the original filename
    # Use the original filename for the temporary file to avoid issues if the PDF library
    # expects the original name or extension.
    temp_path = os.path.join(PDF_STORAGE_PATH, file.filename)
    logger.info(f"Job {job_id}: Saving temporary file to: {temp_path}")
    try:
        # Ensure the file pointer is at the beginning if it was read elsewhere
        await file.seek(0)
        with open(temp_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        logger.info(f"Job {job_id}: Temporary file saved: {temp_path}")
    except Exception as e:
        logger.error(f"Job {job_id}: Failed to save temporary file {temp_path}: {e}")
        # Update job status to failed if saving fails
        job_status[job_id]["status"] = "failed"
        job_status[job_id]["message"] = f"Failed to save temporary file: {e}"
        raise HTTPException(status_code=500, detail=f"Failed to save temporary file: {e}")

    # Add the processing task to background tasks
    # Pass the temporary file path and sanitized title to the background task
    background_tasks.add_task(perform_pdf_processing, job_id, temp_path, sanitized_title)
    logger.info(f"Job {job_id}: Added background task for processing.")

    # Return immediate response with job ID
    return ProcessResponse(
        success=True,
        message="Processing job started",
        job_id=job_id,
        status="pending" # Or "processing" if task starts immediately
    )

# --- New endpoint to check job status ---
@app.get("/status/{job_id}", response_model=StatusResponse)
async def get_job_status(job_id: str):
    """
    Checks the status of a PDF processing job.
    """
    logger.info(f"Received status request for job ID: {job_id}")
    job_info = job_status.get(job_id)

    if not job_info:
        logger.warning(f"Status request for unknown job ID: {job_id}")
        raise HTTPException(status_code=404, detail="Job ID not found")

    # Return the current status and results (if available)
    return StatusResponse(
        success=job_info.get("success", False),
        message=job_info.get("message", "Status available"),
        job_id=job_id,
        status=job_info.get("status", "unknown"),
        title=job_info.get("title"),
        file_path=job_info.get("file_path"),
        images=job_info.get("images")
    )


if __name__ == "__main__":
    import uvicorn
    # Ensure env vars are loaded before running uvicorn
    load_dotenv()
    # Re-ensure paths in case running directly
    try:
        ensure_storage_paths()
    except Exception as e:
        logger.critical(f"Failed to initialize storage paths before running server: {e}")
        sys.exit(1)

    uvicorn.run(app, host="0.0.0.0", port=8502)
