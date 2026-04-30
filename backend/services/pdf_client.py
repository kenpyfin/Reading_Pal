import os
import requests
# Remove load_dotenv here, rely on main.py/docker-compose
# from dotenv import load_dotenv
import logging
from fastapi import UploadFile # Use UploadFile type hint for clarity
# Remove HTTPException import here, raise standard exceptions instead
# from fastapi import HTTPException

# load_dotenv() # Remove load_dotenv here
logger = logging.getLogger(__name__)

PDF_CLIENT_URL = os.getenv("PDF_CLIENT_URL")

# Change from async def to def
def process_document_with_service(file: UploadFile, title: str = None):
    """
    Sends an uploaded document file to the external processing service.
    This is a synchronous function intended to be run in a threadpool.
    Raises standard exceptions on failure.
    """
    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL is not set in environment variables.")
        # Raise a standard ValueError
        raise ValueError("Document processing service URL is not configured.")

    url = f"{PDF_CLIENT_URL}/process-pdf"
    logger.info(f"Sending document to processing service at {url}")

    # requests.post expects file-like objects or bytes for the 'files' parameter.
    # file.file is the SpooledTemporaryFile from UploadFile.
    # Pass the file-like object directly to requests.
    files = {'file': (file.filename, file.file, file.content_type)}
    data = {'title': title} if title else {}

    try:
        # Use requests.post for sending files - this is synchronous
        response = requests.post(url, files=files, data=data)
        response.raise_for_status() # Raise an exception for bad status codes (4xx or 5xx)

        result = response.json()
        logger.info(f"Document processing service response: {result.get('success')}")

        if result.get('success'):
            return result
        else:
            logger.error(f"Document processing service reported failure: {result.get('file_path')}")
            # Raise a standard RuntimeError
            raise RuntimeError(result.get('file_path', 'Document processing failed'))

    except requests.exceptions.RequestException as e:
        logger.error(f"Error communicating with document processing service: {e}")
        # Raise a standard RuntimeError for request errors
        raise RuntimeError(f"Failed to connect to document processing service or request failed: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during document processing request: {e}")
        # Catch any other unexpected errors and raise a standard RuntimeError
        raise RuntimeError(f"An unexpected error occurred during processing: {e}")


# Backward compatible alias for existing imports.
process_pdf_with_service = process_document_with_service
