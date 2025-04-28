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

def reformat_markdown_with_claude(md_text):
    from anthropic import Anthropic

    # Approximate tokens per character (this is a rough estimate)
    TOKENS_PER_CHAR = 0.25
    # Leave room for system prompt and other message components
    MAX_CHUNK_CHARS = int((4096 * 0.8) / TOKENS_PER_CHAR)  # Using 80% of max tokens

    anthropic_api_key = os.getenv('ANTHROPIC_API_KEY')
    if not anthropic_api_key:
        logger.warning("ANTHROPIC_API_KEY not set. Skipping markdown reformatting.")
        return md_text # Return original text if API key is not available

    try:
        client = Anthropic(api_key=anthropic_api_key)
    except Exception as e:
        logger.error(f"Failed to initialize Anthropic client: {e}. Skipping markdown reformatting.")
        return md_text # Return original text if client initialization fails


    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS)
    reformatted_chunks = []
    system_prompt = "You are a helpful assistant that reformats markdown text to be more readable and consistent. Only output the reformatted markdown without any other words."

    for i, chunk in enumerate(chunks):
        try:
            logger.info(f"Reformatting markdown chunk {i+1}/{len(chunks)}...")
            message = client.messages.create(
                model="claude-3-haiku-20240307", # Use a cost-effective model for reformatting
                max_tokens=4096,
                system=system_prompt,
                messages=[
                    {
                        "role": "user",
                        "content": f"Please reformat this markdown text to be more readable without adding or deleting a single word:\n\n{chunk}"
                    }
                ]
            )
            reformatted_chunk = message.content[0].text if message.content else ""
            reformatted_chunks.append(reformatted_chunk)
            logger.info(f"Finished reformatting chunk {i+1}.")
        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1}: {e}")
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
            context_manager = autocast(dtype=torch.float16)
        else:
            logger.warning("CUDA not available. Using CPU.")
            context_manager = nullcontext()


        # Initialize and run OCR pipeline
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
            # OCRPipe saves images using the base filename of the input PDF
            # Since we saved the temp file with the original filename,
            # the images will be prefixed with the original filename base.
            # We need to ensure the image_writer is configured correctly
            # or handle the image path mapping later.
            # For now, assume OCRPipe uses the base name of the file_path passed to it.
            # The image_writer is initialized with IMAGES_PATH, so images go there.
            # The filenames generated by OCRPipe are typically like {base_filename}_img_{page}_{idx}.png
            # We will rely on listing files starting with the sanitized title prefix later.

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

        # Reformat markdown using Claude
        logger.info("Reformatting markdown with Claude...")
        reformatted_md_text = reformat_markdown_with_claude(md_text)
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
    temp_path = None # Initialize temp_path to None
    try:
        # Generate base title from filename if not provided
        base_title = title if title else os.path.splitext(file.filename)[0]

        # Sanitize the title for use in filenames
        sanitized_title = sanitize_filename(base_title)
        logger.info(f"Original title: '{base_title}', Sanitized title: '{sanitized_title}'")

        # Save uploaded file temporarily using the original filename
        # This is important because magic_pdf might use the original filename internally
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
        # Pass the sanitized title to the processing function.
        # The processing function will use this title to name the output markdown file.
        # Note: magic_pdf's image naming convention is based on the *input* filename.
        # So images will be named like {original_filename_base}_img_...png.
        # We will list images based on the *sanitized* title prefix later.
        markdown_content = process_pdf_to_markdown(temp_path, sanitized_title) # Pass sanitized_title

        if not markdown_content:
            # Cleanup temp file even if processing fails
            try:
                if temp_path and os.path.exists(temp_path):
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
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
                logger.info(f"Cleaned up temporary file: {temp_path}")
        except Exception as e:
            logger.error(f"Failed to cleanup temp file {temp_path}: {e}")

        # Get list of generated images
        images = []
        if os.path.exists(IMAGES_PATH):
            # Image files generated by OCRPipe use the base filename of the input PDF
            # We need to look for files starting with the base of the *original* filename
            # and potentially rename them or map them to the sanitized title.
            # A simpler approach for now is to list all images and assume they belong
            # to this processing run if they were recently created or if we can
            # reliably link them via the magic_pdf output structure (which is complex).
            # A more robust approach would be for OCRPipe to return the list of image files it created.
            # Given the current OCRPipe implementation, images are named based on the *input* file.
            # Let's list images based on the *original* filename base, not the sanitized title.
            # This means the backend will need to map original filenames to sanitized titles for image serving.
            # Or, we modify OCRPipe to use the desired output prefix.
            # Let's stick to the plan of listing images based on the *sanitized* title prefix,
            # assuming magic_pdf *can* be configured or implicitly uses the output path/title prefix.
            # If magic_pdf strictly uses the input filename base, this part needs adjustment.
            # Let's assume for now that images saved by the pipe are somehow linkable to the output title.
            # A common pattern is {output_title}_img_{page}_{idx}.png. Let's try listing by sanitized title prefix.

            image_prefix = sanitized_title
            logger.info(f"Looking for images with prefix: {image_prefix} in {IMAGES_PATH}")
            try:
                # List files and filter by prefix and extension
                all_image_files = [f for f in os.listdir(IMAGES_PATH) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))]
                # Filter by prefix - this assumes magic_pdf names images using the output title prefix
                # If magic_pdf names images using the *input* filename prefix, this filter needs to change
                # to use os.path.splitext(file.filename)[0] instead of sanitized_title.
                # Let's assume the output title prefix for now based on the user's request context.
                matching_images = [f for f in all_image_files if f.startswith(image_prefix)]

                for img_file in matching_images:
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
            if temp_path and os.path.exists(temp_path):
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
