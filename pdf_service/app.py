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
GEMINI_API_KEY_REFORMAT = os.getenv("GEMINI_API_KEY_REFORMAT") # ADD THIS LINE to load Gemini key

# Configure Gemini API if key is present
if GEMINI_API_KEY_REFORMAT:
    try:
        genai.configure(api_key=GEMINI_API_KEY_REFORMAT)
        logger.info("Google Gemini API configured successfully.")
    except Exception as e:
        logger.warning(f"Failed to configure Google Gemini API: {e}. Gemini reformatting will not be available.")
        GEMINI_API_KEY_REFORMAT = None # Ensure it's None if configuration fails
else:
    logger.info("GEMINI_API_KEY_REFORMAT not found. Google Gemini reformatting will not be available.")


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
        logger.warning("OLLAMA_API_BASE or OLLAMA_REFORMAT_MODEL not set. Skipping markdown reformatting with Ollama.")
        return md_text # Return original text if config is not available

    try:
        logger.info(f"Attempting to initialize Ollama client at {OLLAMA_API_BASE} for reformatting with model {OLLAMA_REFORMAT_MODEL}...")
        client = ollama.Client(host=OLLAMA_API_BASE)
        logger.info(f"Ollama client initialized successfully for reformatting at {OLLAMA_API_BASE} using model {OLLAMA_REFORMAT_MODEL}.")
    except Exception as e:
        logger.error(f"Failed to initialize Ollama client: {e}. Skipping markdown reformatting.")
        return md_text

    # Reduce max chunk characters significantly for smaller models like Phi.
    # Old: MAX_CHUNK_CHARS = 18000
    # A 4096 token context window might handle ~12000-16000 characters of text (1 token ~ 3-4 chars).
    # System prompt is ~3000 chars (~750-1000 tokens).
    # So, for user content, aim for ~7000-8000 chars to leave room for prompt and output.
    MAX_CHUNK_CHARS = 7000 # Adjusted from 18000

    logger.info(f"Splitting markdown into chunks for Ollama reformatting (model: {OLLAMA_REFORMAT_MODEL}, max_chunk_size={MAX_CHUNK_CHARS})...")
    # Max chunks can be increased if documents are very long and this becomes a bottleneck
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS, max_chunks=15) 
    logger.info(f"Markdown split into {len(chunks)} chunks.")

    reformatted_chunks = []
    
    # Enhanced System Prompt for Ollama
    system_prompt = """You are a meticulous and precise Markdown reformatting tool. Your ONLY task is to reformat the given Markdown text to improve its readability and ensure consistent, standard Markdown syntax.

**CRITICAL INSTRUCTIONS - ADHERE STRICTLY:**
1.  **NO CONTENT ALTERATION:** You MUST preserve ALL original text content VERBATIM. This includes all words, sentences, paragraphs, headings, list items, code within code blocks, table cell content, etc. Do NOT summarize, expand, rephrase, or change the meaning of ANY content.
2.  **EXACT IMAGE LINK PRESERVATION:** Image links (e.g., `![](path/to/image.png)` or `![alt text](path/to/image.png)`) MUST be preserved EXACTLY as they appear in the input. Do not modify paths, alt text, or the link syntax in any way.
3.  **STANDARD MARKDOWN SYNTAX:** Ensure all output uses standard, common Markdown syntax. If you encounter malformed or non-standard syntax in the input, correct it to standard Markdown while preserving the original intent and content.
4.  **CONSISTENT FORMATTING:** Apply consistent formatting for lists (e.g., use '-' or '*' consistently for unordered lists, and '1.' for ordered lists), code blocks (ensure proper triple backticks and language specifiers if present), and blockquotes.
5.  **HEADING LEVELS:** Maintain the original heading levels (e.g., `#`, `##`, `###`). Do not change the semantic structure indicated by headings.
6.  **OUTPUT ONLY MARKDOWN:** Your entire output MUST be ONLY the reformatted Markdown text. Do NOT include any conversational text, apologies, explanations, or any text before or after the Markdown content. **Specifically, do NOT wrap the entire output in a Markdown code block (e.g., using ```markdown ... ``` or ``` ... ```).**
7.  **WHITESPACE MANAGEMENT:** Normalize excessive blank lines between paragraphs and elements. Ensure appropriate single blank lines for separation around block elements like headings, lists, code blocks, and paragraphs for readability. Do not add excessive newlines.
8.  **TABLES:** If Markdown tables are present, ensure they are correctly formatted using standard Markdown table syntax (pipes and hyphens). Preserve all table content.
9.  **HTML TAGS:** If any raw HTML tags are present in the input Markdown, preserve them as they are. Do not attempt to convert them to Markdown or remove them, unless they are clearly malformed and breaking standard Markdown rendering.

Reformat the following Markdown text according to these strict instructions:
"""

    logger.info(f"Starting Ollama reformatting loop for {len(chunks)} chunks using model {OLLAMA_REFORMAT_MODEL}.")
    strip_pattern = re.compile(r"^\s*```(?:markdown)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)

    for i, chunk in enumerate(chunks):
        if not chunk.strip(): # Skip empty or whitespace-only chunks
            reformatted_chunks.append(chunk)
            continue
        try:
            logger.info(f"Sending chunk {i+1}/{len(chunks)} to Ollama ({OLLAMA_REFORMAT_MODEL}). Length: {len(chunk)} characters.")
            response = client.chat(
                model=OLLAMA_REFORMAT_MODEL,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': chunk } # Just the chunk, the instruction is in the system prompt
                ],
                options={
                    'temperature': 0.05, # Very low temperature for deterministic output
                    'num_predict': -1,    # Allow model to generate as much as needed (up to its context limit)
                    # Adjust context_length to a value appropriate for the model (e.g., phi models often have 2k or 4k context)
                    # Old: 'context_length': 52022,
                    'context_length': 20000, # Adjusted to a common context size for smaller models
                    # 'top_p': 0.5,       # Optional: Further restrict token choice if needed
                }
            )
            reformatted_chunk_raw = response['message']['content'] if response and 'message' in response and 'content' in response['message'] else ""
            
            # Strip ```markdown ... ``` wrappers
            match = strip_pattern.match(reformatted_chunk_raw)
            if match:
                reformatted_chunk = match.group(1).strip()
                logger.info(f"Stripped ```markdown wrapper from Ollama chunk {i+1}.")
            else:
                reformatted_chunk = reformatted_chunk_raw.strip() # Strip leading/trailing whitespace anyway
            
            # Basic validation: Check if the reformatted chunk is not empty if the original wasn't
            if not reformatted_chunk.strip() and chunk.strip():
                logger.warning(f"Ollama ({OLLAMA_REFORMAT_MODEL}) returned an empty reformatted chunk {i+1} for a non-empty original chunk (after potential stripping). Using original chunk.")
                reformatted_chunks.append(chunk)
            # Check for significant reduction in content, which might indicate over-summarization or errors
            elif len(reformatted_chunk) < len(chunk) * 0.75 and len(chunk) > 200: # If shrunk by more than 25% for reasonably sized chunks
                logger.warning(f"Chunk {i+1} significantly shrunk after Ollama ({OLLAMA_REFORMAT_MODEL}) reformatting. Original: {len(chunk)}, Reformatted: {len(reformatted_chunk)}. Consider reviewing output. Using reformatted chunk for now.")
                reformatted_chunks.append(reformatted_chunk)
            else:
                reformatted_chunks.append(reformatted_chunk)
            logger.info(f"Received response for chunk {i+1}. Reformatted length: {len(reformatted_chunk)} characters.")

        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Ollama ({OLLAMA_REFORMAT_MODEL}): {e}", exc_info=True)
            logger.info(f"Appending original chunk {i+1} due to Ollama error. Length: {len(chunk)} characters.")
            reformatted_chunks.append(chunk)

    logger.info("Finished Ollama reformatting loop. Combining reformatted chunks...")
    combined_text = "\n\n".join(reformatted_chunks)
    logger.info(f"Ollama ({OLLAMA_REFORMAT_MODEL}) reformatting complete.")
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
        logger.info(f"Initial chunk {i} length: {len(chunk_item)} characters.")

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
    if not GEMINI_API_KEY_REFORMAT:
        logger.warning("GEMINI_API_KEY_REFORMAT not set or configuration failed. Skipping Gemini markdown reformatting.")
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
5.  Do NOT add any conversational text, apologies, or explanations. Output ONLY the reformatted Markdown text. **Specifically, do NOT wrap the entire output in a Markdown code block (e.g., using ```markdown ... ``` or ``` ... ```).**
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

    strip_pattern = re.compile(r"^\s*```(?:markdown)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)

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
            
            reformatted_chunk_raw = response.text
            
            # Strip ```markdown ... ``` wrappers
            match = strip_pattern.match(reformatted_chunk_raw)
            if match:
                reformatted_chunk = match.group(1).strip()
                logger.info(f"Stripped ```markdown wrapper from Gemini chunk {i+1}.")
            else:
                reformatted_chunk = reformatted_chunk_raw.strip() # Strip leading/trailing whitespace anyway

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

        # --- MODIFIED SECTION FOR GATHERING IMAGE INFO ---
        # Get list of generated images using pipe.output_images_info
        images_for_callback = [] # Use a distinct variable name
        if hasattr(pipe, 'output_images_info') and pipe.output_images_info:
            logger.info(f"Job {job_id}: Found {len(pipe.output_images_info)} image entries in pipe.output_images_info.")
            for img_data_from_pipe in pipe.output_images_info:
                # img_data_from_pipe is a dict like:
                # {"bytes": ..., "format": ..., "save_name": "actual_filename.png", "md_path": "path/in/markdown.png"}
                
                saved_filename = img_data_from_pipe.get("save_name")
                md_inserted_path = img_data_from_pipe.get("md_path")

                if saved_filename and md_inserted_path:
                    # Using the pdf_service's ImageInfo model for constructing the list for the callback
                    images_for_callback.append(ImageInfo( 
                        filename=saved_filename,    # The actual filename the image was saved as
                        path=md_inserted_path       # The path string magic_pdf inserted into the markdown
                    ))
                    logger.debug(f"Job {job_id}: Added image to callback data: filename='{saved_filename}', path_in_md='{md_inserted_path}'")
                else:
                    logger.warning(f"Job {job_id}: Skipping image data from pipe.output_images_info due to missing 'save_name' or 'md_path': {img_data_from_pipe}")
        else:
            logger.info(f"Job {job_id}: No images found in pipe.output_images_info or attribute 'output_images_info' does not exist on pipe object.")
        # --- END OF MODIFIED SECTION ---

        # Reformat markdown
        reformatted_md_text = ""
        if GEMINI_API_KEY_REFORMAT: # Check if Gemini API key is available and configured
            logger.info(f"Job {job_id}: Attempting markdown reformatting with Google Gemini...")
            reformatted_md_text = reformat_markdown_with_gemini(md_text) # This seems to call ollama, should it be reformat_markdown_with_gemini? Assuming user wants to keep this as is for now.
        elif OLLAMA_API_BASE and OLLAMA_REFORMAT_MODEL: # Fallback to Ollama if configured
            logger.info(f"Job {job_id}: Gemini not available/configured. Attempting markdown reformatting with Ollama...")
            reformatted_md_text = reformat_markdown_with_ollama(md_text)
        else:
            logger.warning(f"Job {job_id}: Neither Gemini nor Ollama reformatting services are configured. Using raw markdown.")
            reformatted_md_text = md_text
        
        logger.info(f"Job {job_id}: Markdown reformatting process chosen. Result length: {len(reformatted_md_text)} chars.")

        # --- NEW: Rewrite image paths in markdown to be web-accessible ---
        if hasattr(pipe, 'output_images_info') and pipe.output_images_info and isinstance(reformatted_md_text, str):
            logger.info(f"Job {job_id}: Starting image path rewriting in final markdown content.")
            current_md_content = reformatted_md_text

            for img_data_from_pipe in pipe.output_images_info:
                original_md_path = img_data_from_pipe.get("md_path") # e.g., "images/figure1.png"
                final_saved_filename = img_data_from_pipe.get("save_name") # e.g., "MyBook_figure1.png"

                if original_md_path and final_saved_filename:
                    web_path_for_markdown = f"/images/{final_saved_filename}" # Target: "/images/MyBook_figure1.png"

                    current_md_content = current_md_content.replace(original_md_path, web_path_for_markdown)
                    
                    # # Escape original_md_path for use in regex
                    # escaped_original_md_path = re.escape(original_md_path)

                    # # Regex for Markdown: ![alt text](original_md_path) or ![alt text](<original_md_path>)
                    # md_pattern = r"(!\[[^\]]*\]\()(<)?" + escaped_original_md_path + "\)"
                    # current_md_content, count_md = re.subn(md_pattern, rf"\1{web_path_for_markdown}\4", current_md_content)
                    
                    # # Regex for HTML: <img src="original_md_path">
                    # html_pattern = r'(<img[^>]*src\s*=\s*["\'])' + escaped_original_md_path + r'(["\'])'
                    # current_md_content, count_html = re.subn(html_pattern, rf"\1{web_path_for_markdown}\2", current_md_content)
                    
                    # if count_md > 0 or count_html > 0:
                    #     logger.info(f"Job {job_id}: PDF Service replaced '{original_md_path}' with '{web_path_for_markdown}' (MD: {count_md}, HTML: {count_html}).")
                    #     replacements_done_in_pdf_service += (count_md + count_html)
            

            reformatted_md_text = current_md_content # Update with rewritten paths

        # --- END OF NEW IMAGE PATH REWRITING ---

        # Save markdown content to a file using the sanitized title
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}.md")
        logger.info(f"Job {job_id}: Preparing to save final (paths rewritten) markdown to: {markdown_file_path}")

        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text) # This now contains web-ready paths

        logger.info(f"Job {job_id}: Final markdown saved.")
        logger.info(f"Job {job_id}: PDF processed and converted to markdown successfully")

        # Update local variables for successful callback
        callback_status = "completed"
        callback_message = "Processing complete"
        callback_file_path = markdown_file_path
        
        # --- Modify how images_for_callback is populated ---
        temp_images_for_callback = [] 
        if hasattr(pipe, 'output_images_info') and pipe.output_images_info:
            for img_data_from_pipe in pipe.output_images_info:
                saved_filename = img_data_from_pipe.get("save_name")
                if saved_filename:
                    web_path = f"/images/{saved_filename}" # Construct the web path
                    temp_images_for_callback.append(ImageInfo( 
                        filename=saved_filename,
                        path=web_path # Send the web path
                    ))
        images_for_callback = temp_images_for_callback # Assign to the variable used later
        # --- End of modification for images_for_callback ---

        callback_images_data = [img.model_dump() for img in images_for_callback] # Convert ImageInfo objects to dicts

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
