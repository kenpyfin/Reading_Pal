import os
import logging
from fastapi import APIRouter, HTTPException, Body, status
from pydantic import BaseModel
from typing import Optional
from fastapi.concurrency import run_in_threadpool # Import run_in_threadpool

from ..services.llm_service import llm_service, LLM_SERVICE # Import the LLM service instance and config
from ..db.mongodb import get_book # Import function to get book data

logger = logging.getLogger(__name__)
router = APIRouter()

class LLMRequest(BaseModel):
    book_id: str
    text: str # This could be selected text or a question
    context: Optional[str] = None # Optional additional context (e.g., surrounding text)

class LLMResponse(BaseModel):
    response: str

# Helper function to read markdown content from file
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
    Sends a question about book content to the LLM service.
    Fetches the full book content as context.
    """
    logger.info(f"Received 'ask' request for book ID: {request.book_id}")

    # 1. Fetch book data to get the markdown file path
    book_data = await get_book(request.book_id)
    if not book_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    # 2. Read the full markdown content from the file
    markdown_content = await read_markdown_content(book_data.get("markdown_file_path"))

    # Use the full markdown content as context for the 'ask' task
    context_text = markdown_content

    # 3. Send request to LLM service
    try:
        # Determine if the configured LLM client is synchronous (like Ollama)
        # If it is, run the async process_text method in a threadpool.
        # If it's already async (Anthropic, DeepSeek, Gemini), await directly.
        # A simple check based on the configured service name:
        if LLM_SERVICE == "ollama":
             # Ollama client is synchronous, run in threadpool
             llm_response = await run_in_threadpool(
                 llm_service.process_text, # Pass the async function
                 "ask",
                 request.text, # The question
                 context_text # The book content as context
             )
        else:
             # Assume other clients are async and can be awaited directly
             llm_response = await llm_service.process_text(
                 "ask",
                 request.text, # The question
                 context_text # The book content as context
             )

        return LLMResponse(response=llm_response)

    except Exception as e:
        logger.error(f"Error processing LLM 'ask' request: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error from LLM service: {e}")

@router.post("/summarize", response_model=LLMResponse)
async def summarize_llm(request: LLMRequest):
    """
    Sends text (e.g., selected passage or full book) to the LLM service for summarization.
    For now, this endpoint will summarize the entire book content.
    """
    logger.info(f"Received 'summarize' request for book ID: {request.book_id}")

    # 1. Fetch book data to get the markdown file path
    book_data = await get_book(request.book_id)
    if not book_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    # 2. Read the full markdown content from the file
    # For now, we summarize the entire book content
    text_to_summarize = await read_markdown_content(book_data.get("markdown_file_path"))

    if not text_to_summarize:
         raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book content not available for summarization.")


    # 3. Send request to LLM service
    try:
        # Determine if the configured LLM client is synchronous (like Ollama)
        # If it is, run the async process_text method in a threadpool.
        # If it's already async (Anthropic, DeepSeek, Gemini), await directly.
        if LLM_SERVICE == "ollama":
             llm_response = await run_in_threadpool(
                 llm_service.process_text,
                 "summarize",
                 text_to_summarize, # Pass the full content as the text to summarize
                 None # No additional context needed for summarizing the whole text
             )
        else:
             llm_response = await llm_service.process_text(
                 "summarize",
                 text_to_summarize, # Pass the full content as the text to summarize
                 None # No additional context needed
             )

        return LLMResponse(response=llm_response)

    except Exception as e:
        logger.error(f"Error processing LLM 'summarize' request: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error from LLM service: {e}")

