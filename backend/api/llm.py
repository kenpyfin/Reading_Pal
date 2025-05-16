import os
import logging
from fastapi import APIRouter, HTTPException, Body, status
from pydantic import BaseModel
from typing import Optional
from fastapi.concurrency import run_in_threadpool # Keep import for read_markdown_content

# Change relative imports to absolute imports
from backend.services.llm_service import ask_question, summarize_text # Import the async wrapper functions
from backend.db.mongodb import get_book # Import function to get book data

logger = logging.getLogger(__name__)
router = APIRouter()

# Define the container markdown path locally, matching the docker-compose mount
CONTAINER_MARKDOWN_PATH = "/app/storage/markdown"
logger.info(f"LLM API: CONTAINER_MARKDOWN_PATH = {CONTAINER_MARKDOWN_PATH}")


class LLMRequest(BaseModel):
    book_id: str
    # --- Change field name from 'text' to 'question' ---
    question: str # This is the user's question
    context: Optional[str] = None # This is the optional selected text

class LLMResponse(BaseModel):
    response: str

# Helper function to read markdown content from file (keep this as it uses run_in_threadpool)
async def read_markdown_content(markdown_file_path: str) -> str:
    """Reads markdown content from a file path using a threadpool."""
    if markdown_file_path and os.path.exists(markdown_file_path):
         try:
            # Use run_in_threadpool for file reading as it's blocking I/O
            return await run_in_threadpool(lambda p: open(p, 'r', encoding='utf-8').read(), markdown_file_path)
         except Exception as file_read_error:
            logger.error(f"Failed to read markdown file {markdown_file_path}: {file_read_error}")
            return "" # Return empty content on error
    return ""


@router.post("/ask", response_model=LLMResponse)
async def ask_llm(request: LLMRequest):
    """
    Sends a question about book content to the configured LLM.
    Uses selected text (if provided in context) as primary reference.
    """
    # Log the received question and context length
    logger.info(f"Received 'ask' request for book ID: {request.book_id}. Question length: {len(request.question)}. Context length: {len(request.context) if request.context else 0}")
    # --- Add this log statement ---
    logger.info(f"Ask endpoint received context: '{request.context}'")

    # 1. Fetch book data (still useful to confirm book exists)
    book_data = await get_book(request.book_id)
    if not book_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    # The full markdown content reading logic is removed from here
    # as the requirement is to use the selected text (request.context)
    # for the 'ask' endpoint.

    # 2. Send request to LLM service using the async wrapper
    try:
        # --- Call llm_service.ask with the user's question and selected text as context ---
        llm_response = await ask_question(
            request.question, # Pass the user's question as the prompt
            request.context # Pass the selected text as the context
        )

        # The LLM service functions now return error messages as strings
        # Check if the response indicates an error from the service itself
        if llm_response.startswith("LLM service") or llm_response.startswith("Error generating response"):
             logger.error(f"LLM service returned an error for 'ask': {llm_response}")
             # Return error in response body so frontend can display it
             # Consider returning a 500 status if it's a critical LLM error,
             # but returning 200 with the error message allows frontend to handle gracefully.
             # Let's return 200 with the error message for now.
             return LLMResponse(response=llm_response)


        return LLMResponse(response=llm_response)

    except Exception as e:
        logger.error(f"Unexpected error processing LLM 'ask' request: {e}")
        # Catch any unexpected errors during the process (e.g., DB error, file read error)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"An unexpected error occurred: {e}")

# Keep the /summarize endpoint as is for now, as it wasn't explicitly requested to be removed from the backend.
@router.post("/summarize", response_model=LLMResponse)
async def summarize_llm(request: LLMRequest):
    """
    Sends text (e.g., selected passage or full book) to the LLM service for summarization.
    For now, this endpoint will summarize the entire book content.
    """
    logger.info(f"Received 'summarize' request for book ID: {request.book_id}")

    # 1. Fetch book data to get the markdown filename
    book_data = await get_book(request.book_id)
    if not book_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    # Retrieve the stored markdown filename from the DB document
    stored_markdown_filename = book_data.get("markdown_filename")

    # Construct the full container path using the container mount point and filename
    container_markdown_path = None
    if CONTAINER_MARKDOWN_PATH and stored_markdown_filename: # Ensure both are valid before joining
        container_markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, stored_markdown_filename)

    logger.info(f"Summarize endpoint: Constructed container markdown path: {container_markdown_path}")


    # 2. Read the full markdown content from the file using the constructed path
    text_to_summarize = ""
    if container_markdown_path and os.path.exists(container_markdown_path):
         logger.info(f"Summarize endpoint: Markdown file found at container path: {container_markdown_path}. Attempting to read...")
         text_to_summarize = await read_markdown_content(container_markdown_path)
         if not text_to_summarize:
              logger.warning(f"Summarize endpoint: Markdown content read from {container_markdown_path} is empty.")
    else:
         logger.error(f"Summarize endpoint: Container markdown path missing or file not found: {container_markdown_path} for book ID {request.book_id}.")
         raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book content file not found or path invalid.")


    # 3. Send request to LLM service using the async wrapper
    try:
        # Simply await the async wrapper function
        llm_response = await summarize_text(text_to_summarize)

        # The LLM service functions now return error messages as strings
        # Check if the response indicates an error from the service itself
        if llm_response.startswith("LLM service") or llm_response.startswith("Error generating summary"):
             logger.error(f"LLM service returned an error for 'summarize': {llm_response}")
             # Return error in response body so frontend can display it
             return LLMResponse(response=llm_response)


        return LLMResponse(response=llm_response)

    except Exception as e:
        logger.error(f"Unexpected error processing LLM 'summarize' request: {e}")
        # Catch any unexpected errors during the process
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"An unexpected error occurred: {e}")
