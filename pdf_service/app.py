import os
import logging
import sys
import uuid # Import uuid for generating job IDs
from typing import Optional, List, Dict, Any # Import Dict and Any
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks # Import BackgroundTasks
from pydantic import BaseModel
import torch
from dotenv import load_dotenv # Keep this import
from magic_pdf.data.data_reader_writer import FileBasedDataWriter, FileBasedDataReader
from magic_pdf.config.make_content_config import DropMode, MakeMode
from magic_pdf.pipe.OCRPipe import OCRPipe
from torch.cuda.amp import autocast
import re # Import the regex module
from contextlib import nullcontext # Import nullcontext for Python 3.7+
import ollama # Import the ollama library
import asyncio # Import asyncio for background tasks
import requests # Import requests for making HTTP calls in background task
import google.generativeai as genai # ADD THIS LINE

# Initialize FastAPI app
app = FastAPI(title="PDF Processing Service")

# Configure logging using the LOG_LEVEL environment variable
# Ensure this block is right after imports and app initialization
log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, log_level_str, logging.INFO)

logging.basicConfig(
    level=log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__) # Keep this line as it is

# --- Load environment variables here, outside of __main__ ---
# This ensures they are loaded when the module is imported by uvicorn
load_dotenv() # ADD this line here

# Get paths from environment variables
PDF_STORAGE_PATH = os.getenv('PDF_STORAGE_PATH')
MARKDOWN_PATH = os.getenv('MARKDOWN_PATH')
IMAGES_PATH = os.getenv('IMAGES_PATH')

# Get Ollama configuration from environment variables
OLLAMA_API_BASE = os.getenv('OLLAMA_API_BASE')
# Use LLM_MODEL from .env for the reformatting model
OLLAMA_REFORMAT_MODEL = os.getenv('OLLAMA_REFORMAT_MODEL') # Use the general LLM_MODEL setting

# Get Backend Callback URL from environment variables
BACKEND_CALLBACK_URL = os.getenv("BACKEND_CALLBACK_URL")

# Get Gemini API Key
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") # ADD THIS LINE to load Gemini key

# Configure Gemini API if key is present
if GEMINI_API_KEY:
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        logger.info("Google Gemini API configured successfully.")
    except Exception as e:
        logger.warning(f"Failed to configure Google Gemini API: {e}. Gemini reformatting will not be available.")
        GEMINI_API_KEY = None # Ensure it's None if configuration fails
else:
    logger.info("GEMINI_API_KEY not found. Google Gemini reformatting will not be available.")


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


# RENAME function and update logic to use Ollama
def reformat_markdown_with_ollama(md_text):
    # Check if Ollama configuration is available
    if not OLLAMA_API_BASE or not OLLAMA_REFORMAT_MODEL:
        logger.warning("OLLAMA_API_BASE or LLM_MODEL not set. Skipping markdown reformatting.")
        return md_text # Return original text if config is not available

    try:
        # Use the synchronous Ollama client
        logger.info(f"Attempting to initialize Ollama client at {OLLAMA_API_BASE}...")
        client = ollama.Client(host=OLLAMA_API_BASE)
        # Optional: Check if the model exists (can add overhead)
        # client.show(OLLAMA_REFORMAT_MODEL) # This would raise an error if model doesn't exist
        logger.info(f"Ollama client initialized successfully for reformatting at {OLLAMA_API_BASE} using model {OLLAMA_REFORMAT_MODEL}.")
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

    logger.info(f"Splitting markdown into chunks for Ollama reformatting (max_chunk_size={MAX_CHUNK_CHARS})...")
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS, max_chunks=10) # max_chunks default is 10
    logger.info(f"Markdown split into {len(chunks)} chunks.")

    reformatted_chunks = []
    # Adjust prompt for a general Ollama model
    system_prompt = "You are a helpful assistant that reformats markdown text to be more readable and \
        consistent. Preserve all original content, including text, headings, lists, code blocks, and image \
            links. Only output the reformatted markdown without any conversational filler."

    logger.info(f"Starting reformatting loop for {len(chunks)} chunks...")
    for i, chunk in enumerate(chunks):
        try:
            logger.info(f"Sending chunk {i+1}/{len(chunks)} to Ollama. Length: {len(chunk)} characters.")
            # Use the chat endpoint
            response = client.chat(
                model=OLLAMA_REFORMAT_MODEL,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': f" Reformat this markdown:\n\n{chunk}"}
                ],
                options={
                    'temperature': 0.1, # Keep temperature low for consistent reformatting
                    'num_predict': -1, # Generate until the model stops (within context limits)
                    'context_length': 68888
                }
            )
            reformatted_chunk = response['message']['content'] if response and 'message' in response else ""
            logger.info(f"Received response for chunk {i+1}. Reformatted length: {len(reformatted_chunk)} characters.")
            # Log if chunk significantly shrunk (e.g., by more than 50%)
            if len(reformatted_chunk) < len(chunk) * 0.5 and len(chunk) > 100: # Avoid noise for tiny chunks
                logger.warning(f"Chunk {i+1} significantly shrunk after reformatting. Original: {len(chunk)}, Reformatted: {len(reformatted_chunk)}")
            reformatted_chunks.append(reformatted_chunk)
        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Ollama: {e}", exc_info=True)
            # Fallback: return the original chunk if reformatting fails
            logger.info(f"Appending original chunk {i+1} due to error. Length: {len(chunk)} characters.")
            reformatted_chunks.append(chunk)

    logger.info(f"Finished reformatting loop. Combining reformatted chunks...")
    # Combine all reformatted chunks
    combined_text = "\n\n".join(reformatted_chunks)
    logger.info(f"Reformatting complete.")
    return combined_text


def split_markdown_into_chunks(md_text: str, max_chunk_size: int = 10000, max_chunks: int = 10) -> List[str]:
    """Split markdown text into chunks based on max_chunk_size and limit to max_chunks."""
    logger.info(f"Original md_text length: {len(md_text)} characters.")
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
    
    logger.info(f"Initial split resulted in {len(chunks)} chunks.")
    for i, chunk_item in enumerate(chunks):
        logger.info(f"  Initial chunk {i} length: {len(chunk_item)} characters.")

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
        logger.info(f"Recombining: total_length={total_length}, avg_length_target_per_chunk={avg_length}")

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
             logger.warning("Recombination resulted in empty combined_chunks, falling back to single chunk of original text.")
             return [md_text] # Fallback to single chunk if combining failed

        chunks = combined_chunks
        logger.warning(f"Recombined into {len(chunks)} chunks.")
        for i, chunk_item in enumerate(chunks):
            logger.info(f"  Recombined chunk {i} length: {len(chunk_item)} characters.")


    # Final check to ensure no empty chunks are returned
    final_chunks = [chunk for chunk in chunks if chunk]
    logger.info(f"Returning {len(final_chunks)} final chunks.")
    return final_chunks


def reformat_markdown_with_gemini(md_text: str) -> str:
    """
    Reformats markdown text using the Google Gemini API.
    """
    if not GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY not set or configuration failed. Skipping Gemini markdown reformatting.")
        return md_text

    try:
        # Initialize the Gemini model
        # You can choose different models like 'gemini-1.5-flash-latest' for speed/cost
        # or 'gemini-1.0-pro' / 'gemini-1.5-pro-latest' for potentially higher quality.
        model = genai.GenerativeModel('gemini-1.5-flash-latest')
        logger.info("Google Gemini model initialized for reformatting.")
    except Exception as e:
        logger.error(f"Failed to initialize Google Gemini model: {e}. Skipping markdown reformatting.")
        return md_text

    # Approximate tokens per character (this is a rough estimate for Gemini)
    # Gemini models have larger context windows, e.g., gemini-1.5-flash has 1M tokens.
    # However, processing very large single chunks can be slow or hit other limits.
    # Let's use a generous chunk character size, e.g., 100k characters.
    # Max input tokens for gemini-1.5-flash is 1,048,576.
    # Let's aim for chunks well under this, e.g., ~200k characters.
    # 1 token ~ 4 chars. So 200k chars ~ 50k tokens.
    MAX_CHUNK_CHARS_GEMINI = 200000 # Roughly 200,000 characters per chunk

    logger.info(f"Splitting markdown into chunks for Gemini reformatting (max_chunk_size={MAX_CHUNK_CHARS_GEMINI})...")
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS_GEMINI, max_chunks=20) # Allow more chunks if needed
    logger.info(f"Markdown split into {len(chunks)} chunks for Gemini.")

    reformatted_chunks = []
    system_instruction = """You are an expert in Markdown. Your task is to reformat the given Markdown text to improve its readability, consistency, and structure.
Strictly adhere to the following:
1.  Preserve ALL original content, including text, headings, lists, code blocks, tables, and image links (e.g., ![](image.png)). Do NOT alter or remove any content.
2.  Ensure standard Markdown syntax is used. Correct any non-standard or malformed Markdown.
3.  Improve formatting for lists, code blocks, and blockquotes for clarity.
4.  Maintain the original heading levels.
5.  Do NOT add any conversational text, apologies, or explanations. Output ONLY the reformatted Markdown text.
6.  If the input is already well-formatted, return it as is.
7.  Pay close attention to image links like `![](path/to/image.png)` or `![alt text](path/to/image.png)` and ensure they are preserved exactly as they appear in the input.
Reformat this markdown:
"""

    # Safety settings can be adjusted if needed, though default might be fine for reformatting.
    # Example:
    # safety_settings = [
    #     {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    #     {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    #     {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    #     {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
    # ]
    # generation_config = genai.types.GenerationConfig(temperature=0.1)


    logger.info(f"Starting Gemini reformatting loop for {len(chunks)} chunks...")
    for i, chunk in enumerate(chunks):
        if not chunk.strip(): # Skip empty chunks
            reformatted_chunks.append(chunk)
            continue
        try:
            logger.info(f"Sending chunk {i+1}/{len(chunks)} to Gemini. Length: {len(chunk)} characters.")
            
            # Construct the prompt for Gemini
            full_prompt = system_instruction + "\n\n" + chunk
            
            response = model.generate_content(
                full_prompt,
                # generation_config=generation_config, # If using custom config
                # safety_settings=safety_settings, # If using custom safety settings
            )
            
            reformatted_chunk = response.text
            logger.info(f"Received response for chunk {i+1}. Reformatted length: {len(reformatted_chunk)} characters.")
            
            if len(reformatted_chunk) < len(chunk) * 0.5 and len(chunk) > 100:
                logger.warning(f"Gemini Chunk {i+1} significantly shrunk. Original: {len(chunk)}, Reformatted: {len(reformatted_chunk)}")
            reformatted_chunks.append(reformatted_chunk)
        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Gemini: {e}", exc_info=True)
            # Fallback: return the original chunk if reformatting fails
            logger.info(f"Appending original chunk {i+1} due to Gemini error. Length: {len(chunk)} characters.")
            reformatted_chunks.append(chunk)

    logger.info("Finished Gemini reformatting loop. Combining reformatted chunks...")
    combined_text = "\n\n".join(reformatted_chunks) # Ensure good separation
    logger.info("Gemini reformatting complete.")
    return combined_text


# --- Background task function for PDF processing ---
async def perform_pdf_processing(job_id: str, temp_pdf_path: str, sanitized_title: str):
    """
    Performs the actual PDF processing in a background task and sends a callback.
    """
    logger.info(f"Job {job_id}: Starting background PDF processing for {temp_pdf_path}")

    # Initialize local variables for callback data
    callback_status = "processing" # Default status
    callback_message = "Processing started"
    callback_file_path = None
    callback_images_data = [] # Will store list of image dicts
    processing_error_detail = None

    try:
        # Read PDF bytes
        logger.info(f"Job {job_id}: Reading PDF bytes from {temp_pdf_path}...")
        reader = FileBasedDataReader("")
        pdf_bytes = reader.read(temp_pdf_path)
        logger.info(f"Job {job_id}: PDF bytes read successfully.")

        # Configure CUDA if available
        logger.info(f"Job {job_id}: Checking CUDA availability...")
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
        logger.info(f"Job {job_id}: CUDA setup complete.")


        # Initialize and run OCR pipeline
        # Use autocast only if CUDA is available
        context_manager = autocast(dtype=torch.float16) if torch.cuda.is_available() else nullcontext()

        logger.info(f"Job {job_id}: Initializing OCRPipe...")
        with context_manager:
            model_list = [] # Configure models if needed
            image_writer = FileBasedDataWriter(IMAGES_PATH)
            pipe = OCRPipe(pdf_bytes, model_list, image_writer)
            logger.info(f"Job {job_id}: OCRPipe initialized.")

            logger.info(f"Job {job_id}: Running pipe_classify...")
            pipe.pipe_classify()
            logger.info(f"Job {job_id}: pipe_classify complete.")

            logger.info(f"Job {job_id}: Running pipe_analyze...")
            pipe.pipe_analyze()
            logger.info(f"Job {job_id}: pipe_analyze complete.")

            logger.info(f"Job {job_id}: Running pipe_parse...")
            pipe.pipe_parse()
            logger.info(f"Job {job_id}: pipe_parse complete.")

            # Generate markdown content
            logger.info(f"Job {job_id}: Running pipe_mk_markdown...")
            md_content = pipe.pipe_mk_markdown(
                IMAGES_PATH, # Pass the image directory path
                drop_mode=DropMode.NONE,
                md_make_mode=MakeMode.MM_MD
            )
            logger.info(f"Job {job_id}: pipe_mk_markdown complete. Initial markdown generated.")

        # Ensure md_content is a string
        if isinstance(md_content, list):
            md_text = "\n".join(md_content)
        elif isinstance(md_content, str):
            md_text = md_content
        else:
            logger.error(f"Job {job_id}: Unexpected markdown content type: {type(md_content)}")
            md_text = "" # Default to empty string on unexpected type
        
        logger.info(f"Job {job_id}: Markdown content prepared for reformatting. Length: {len(md_text)} chars.")

        # --- TEMPORARY DEBUGGING: Save raw markdown from magic_pdf ---
        raw_markdown_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}_raw_magic_pdf.md")
        try:
            with open(raw_markdown_path, 'w', encoding='utf-8') as raw_f:
                raw_f.write(md_text)
            logger.info(f"Job {job_id}: Saved raw markdown from magic_pdf to {raw_markdown_path}")
        except Exception as e_raw_save:
            logger.error(f"Job {job_id}: Failed to save raw markdown: {e_raw_save}")
        # --- END TEMPORARY DEBUGGING ---

        # Reformat markdown
        reformatted_md_text = ""
        if GEMINI_API_KEY: # Check if Gemini API key is available and configured
            logger.info(f"Job {job_id}: Attempting markdown reformatting with Google Gemini...")
            reformatted_md_text = reformat_markdown_with_gemini(md_text)
        elif OLLAMA_API_BASE and OLLAMA_REFORMAT_MODEL: # Fallback to Ollama if configured
            logger.info(f"Job {job_id}: Gemini not available/configured. Attempting markdown reformatting with Ollama...")
            reformatted_md_text = reformat_markdown_with_ollama(md_text)
        else:
            logger.warning(f"Job {job_id}: Neither Gemini nor Ollama reformatting services are configured. Using raw markdown.")
            reformatted_md_text = md_text
        
        logger.info(f"Job {job_id}: Markdown reformatting process chosen. Result length: {len(reformatted_md_text)} chars.")


        # Save markdown content to a file using the sanitized title
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}.md")
        logger.info(f"Job {job_id}: Preparing to save reformatted markdown to: {markdown_file_path}")

        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text)

        logger.info(f"Job {job_id}: Reformatted markdown saved.")
        logger.info(f"Job {job_id}: PDF processed and converted to markdown successfully")

        # Get list of generated images
        images = [] # This list will hold ImageInfo objects
        if os.path.exists(IMAGES_PATH):
            image_prefix = sanitized_title
            logger.info(f"Job {job_id}: Looking for images with prefix: '{image_prefix}' in {IMAGES_PATH}")
            try:
                for img_file in os.listdir(IMAGES_PATH):
                    if img_file.startswith(image_prefix) and img_file.lower().endswith('.png'):
                        full_img_path = os.path.join(IMAGES_PATH, img_file)
                        images.append(ImageInfo(
                            filename=img_file,
                            path=full_img_path
                        ))
                logger.info(f"Job {job_id}: Found {len(images)} image files matching prefix '{image_prefix}'.")
            except Exception as e:
                 logger.error(f"Job {job_id}: Error listing images in {IMAGES_PATH}: {e}")
        else:
             logger.warning(f"Job {job_id}: Images directory not found: {IMAGES_PATH}")

        # Update local variables for successful callback
        callback_status = "completed"
        callback_message = "Processing complete"
        callback_file_path = markdown_file_path
        callback_images_data = [img.model_dump() for img in images] # Convert ImageInfo objects to dicts

    except Exception as e:
        logger.error(f"Job {job_id}: Error during background PDF processing: {e}", exc_info=True)
        # Update local variables for failed callback
        callback_status = "failed"
        callback_message = f"Processing failed: {str(e)}"
        processing_error_detail = str(e)
    finally:
        # Cleanup temporary file regardless of success or failure
        try:
            if os.path.exists(temp_pdf_path):
                os.remove(temp_pdf_path)
                logger.info(f"Job {job_id}: Cleaned up temporary file: {temp_pdf_path}")
        except Exception as e:
            logger.error(f"Job {job_id}: Failed to cleanup temp file {temp_pdf_path}: {e}")

    # Prepare and send callback
    logger.info(f"Job {job_id}: Attempting to send callback to backend with status: {callback_status}")
    
    if not BACKEND_CALLBACK_URL:
        logger.error(f"Job {job_id}: BACKEND_CALLBACK_URL is not set. Cannot send callback.")
    else:
        callback_url = f"{BACKEND_CALLBACK_URL}" 

        # Prepare data for the callback using local variables
        callback_data = {
            "job_id": job_id,
            "status": callback_status,
            "message": callback_message,
            "processing_error": processing_error_detail, # This will be None if status is not 'failed'
        }

        if callback_status == "completed":
            callback_data["file_path"] = callback_file_path
            callback_data["images"] = callback_images_data # Already a list of dicts
        
        try:
            response = requests.post(callback_url, json=callback_data, timeout=10) # Add a timeout
            response.raise_for_status() # Raise an exception for bad status codes
            logger.info(f"Job {job_id}: Callback sent successfully to {callback_url}. Backend response status: {response.status_code}")
        except requests.exceptions.RequestException as e:
            logger.error(f"Job {job_id}: Failed to send callback to backend {callback_url}: {e}")
        except Exception as e:
            logger.error(f"Job {job_id}: An unexpected error occurred while sending callback: {e}", exc_info=True)


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

    logger.info(f"Created job {job_id} for file {file.filename} with sanitized title {sanitized_title}")

    # Save uploaded file temporarily using the original filename
    temp_path = os.path.join(PDF_STORAGE_PATH, file.filename) # Using original filename for temp storage
    logger.info(f"Job {job_id}: Saving temporary file to: {temp_path}")
    try:
        await file.seek(0)
        with open(temp_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        logger.info(f"Job {job_id}: Temporary file saved: {temp_path}")
    except Exception as e:
        logger.error(f"Job {job_id}: Failed to save temporary file {temp_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save temporary file: {e}")

    # Add the processing task to background tasks
    background_tasks.add_task(perform_pdf_processing, job_id, temp_path, sanitized_title)
    logger.info(f"Job {job_id}: Added background task for processing.")

    # Return immediate response with job ID
    return ProcessResponse(
        success=True,
        message="Processing job started",
        job_id=job_id,
        status="pending" 
    )

# --- Removed /status/{job_id} endpoint and its associated StatusResponse model ---

if __name__ == "__main__":
    import uvicorn
    # Ensure env vars are loaded before running uvicorn when running directly
    # load_dotenv() # REMOVE this line from here - it's now at the top level
    # Re-ensure paths in case running directly
    try:
        ensure_storage_paths()
    except Exception as e:
        logger.critical(f"Failed to initialize storage paths before running server: {e}")
        sys.exit(1)
    
    if not BACKEND_CALLBACK_URL:
        logger.warning("BACKEND_CALLBACK_URL environment variable is not set. Callbacks will not be sent.")


    uvicorn.run(app, host="0.0.0.0", port=8502)
