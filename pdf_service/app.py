import os
import logging
import sys
from typing import Optional, List
from fastapi import FastAPI, UploadFile, File, HTTPException
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
OLLAMA_REFORMAT_MODEL = os.getenv('LLM_MODEL') # Use the general LLM_MODEL setting


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

class ProcessResponse(BaseModel):
    success: bool
    message: str
    title: str
    markdown_content: Optional[str] = None
    images: Optional[List[ImageInfo]] = None
    file_path: str # This will be the path on the PDF service host

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


def process_pdf_to_markdown(file_path: str, title: str) -> Optional[str]:
    """Process PDF using OCRPipe and convert to markdown format."""
    try:
        # Read PDF bytes
        reader = FileBasedDataReader("")
        pdf_bytes = reader.read(file_path)

        # Configure CUDA if available
        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
            torch.backends.cudnn.benchmark = True
            torch.backends.cudnn.enabled = True
            torch.set_default_dtype(torch.float32)
            torch.set_default_tensor_type(torch.cuda.FloatTensor)
            logger.info("CUDA available and configured.")
        else:
            logger.warning("CUDA not available. Using CPU.")


        # Initialize and run OCR pipeline
        # Use autocast only if CUDA is available
        context_manager = autocast(dtype=torch.float16) if torch.cuda.is_available() else nullcontext() # Need nullcontext from contextlib

        with context_manager:
            model_list = [] # Configure models if needed
            image_writer = FileBasedDataWriter(IMAGES_PATH)
            pipe = OCRPipe(pdf_bytes, model_list, image_writer)
            logger.info("Running OCRPipe pipeline...")
            pipe.pipe_classify()
            pipe.pipe_analyze()
            pipe.pipe_parse()
            logger.info("OCRPipe analysis complete.")

            # Generate markdown content
            md_content = pipe.pipe_mk_markdown(
                IMAGES_PATH, # Pass the image directory path
                drop_mode=DropMode.NONE,
                md_make_mode=MakeMode.MM_MD
            )
            logger.info("Initial markdown generated.")

        # Ensure md_content is a string
        if isinstance(md_content, list):
            md_text = "\n".join(md_content)
        elif isinstance(md_content, str):
            md_text = md_content
        else:
            logger.error(f"Unexpected markdown content type: {type(md_content)}")
            md_text = "" # Default to empty string on unexpected type

        # Reformat markdown using Ollama (UPDATED CALL)
        logger.info("Reformatting markdown with Ollama...")
        reformatted_md_text = reformat_markdown_with_ollama(md_text) # Call the new function
        logger.info("Markdown reformatting complete.")

        # The filename is now sanitized in the calling function (process_pdf)
        # Save markdown content to a file using the sanitized title
        # The title passed here is already sanitized
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{title}.md") # Use the sanitized title
        logger.info(f"Saving reformatted markdown to: {markdown_file_path}")

        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text)

        logger.info("PDF processed and converted to markdown successfully")
        return reformatted_md_text
    except Exception as e:
        logger.error(f"Error in process_pdf_to_markdown: {e}", exc_info=True)
        return None

@app.post("/process-pdf", response_model=ProcessResponse)
async def process_pdf(
    file: UploadFile = File(...),
    title: Optional[str] = None
):
    """
    Process a PDF file and convert it to markdown format
    """
    logger.info(f"Received request to process PDF: {file.filename}")
    try:
        # Generate base title from filename if not provided
        base_title = title if title else os.path.splitext(file.filename)[0]

        # Sanitize the title for use in filenames
        sanitized_title = sanitize_filename(base_title)
        logger.info(f"Original title: '{base_title}', Sanitized title: '{sanitized_title}'")

        # Save uploaded file temporarily using the original filename
        # Use the original filename for the temporary file to avoid issues if the PDF library
        # expects the original name or extension.
        temp_path = os.path.join(PDF_STORAGE_PATH, file.filename)
        logger.info(f"Saving temporary file to: {temp_path}")
        try:
            # Ensure the file pointer is at the beginning if it was read elsewhere
            await file.seek(0)
            with open(temp_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)
            logger.info(f"Temporary file saved: {temp_path}")
        except Exception as e:
            logger.error(f"Failed to save temporary file {temp_path}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to save temporary file: {e}")


        # Process PDF and get markdown content
        # Pass the sanitized title to the processing function
        markdown_content = process_pdf_to_markdown(temp_path, sanitized_title) # Pass sanitized_title

        if not markdown_content:
            # Cleanup temp file even if processing fails
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                    logger.info(f"Cleaned up temporary file: {temp_path}")
            except Exception as e:
                logger.error(f"Failed to cleanup temp file {temp_path} after processing error: {e}")
            raise HTTPException(status_code=500, detail="Failed to process PDF into markdown")

        # Markdown content is already saved to file inside process_pdf_to_markdown
        # using the sanitized title. Get the final markdown file path.
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}.md") # Use sanitized_title again

        # Cleanup temporary file
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
                logger.info(f"Cleaned up temporary file: {temp_path}")
        except Exception as e:
            logger.error(f"Failed to cleanup temp file {temp_path}: {e}")

        # Get list of generated images
        images = []
        if os.path.exists(IMAGES_PATH):
            # Image files generated by OCRPipe use the base filename as a prefix
            # We need to look for files starting with the sanitized title
            image_prefix = sanitized_title
            logger.info(f"Looking for images with prefix: {image_prefix} in {IMAGES_PATH}")
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
                logger.info(f"Found {len(images)} image files matching prefix '{image_prefix}'.")
            except Exception as e:
                 logger.error(f"Error listing images in {IMAGES_PATH}: {e}")


        return ProcessResponse(
            success=True,
            message="PDF processed successfully",
            title=base_title, # Return the original title in the response
            markdown_content=markdown_content, # Return the content string
            images=images, # Return list of image info (filename, host path)
            file_path=markdown_file_path # Return the host path of the markdown file
        )

    except HTTPException as e:
        # Re-raise FastAPI HTTPExceptions
        raise e
    except Exception as e:
        logger.error(f"Error processing PDF: {str(e)}", exc_info=True)
        # Cleanup temp file on unexpected errors too
        try:
            if 'temp_path' in locals() and os.path.exists(temp_path):
                os.remove(temp_path)
                logger.info(f"Cleaned up temporary file: {temp_path} after error.")
        except Exception as cleanup_e:
            logger.error(f"Failed to cleanup temp file {temp_path} after error: {cleanup_e}")

        raise HTTPException(status_code=500, detail=f"Internal server error during PDF processing: {e}")

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
