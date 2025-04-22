import os
import requests
from dotenv import load_dotenv
import logging
from fastapi import UploadFile # Use UploadFile type hint for clarity
from fastapi import HTTPException # Import HTTPException

load_dotenv()
logger = logging.getLogger(__name__)

PDF_CLIENT_URL = os.getenv("PDF_CLIENT_URL")

async def process_pdf_with_service(file: UploadFile, title: str = None):
    """
    Sends a PDF file to the external PDF processing service.
    """
    if not PDF_CLIENT_URL:
        logger.error("PDF_CLIENT_URL is not set in environment variables.")
        raise ValueError("PDF processing service URL is not configured.")

    url = f"{PDF_CLIENT_URL}/process-pdf"
    logger.info(f"Sending PDF to processing service at {url}")

    # requests.post expects file-like objects or bytes for the 'files' parameter.
    # file.file is the SpooledTemporaryFile from UploadFile.
    files = {'file': (file.filename, file.file, file.content_type)}
    data = {'title': title} if title else {}

    try:
        # Use requests.post for sending files
        # Note: requests is synchronous. For a truly async FastAPI app,
        # you might consider a library like aiohttp or running this in a background task.
        # For now, we'll use requests for simplicity as per the plan.
        response = requests.post(url, files=files, data=data)
        response.raise_for_status() # Raise an exception for bad status codes (4xx or 5xx)

        result = response.json()
        logger.info(f"PDF processing service response: {result}")

        if result.get("success"):
            return result
        else:
            logger.error(f"PDF processing service reported failure: {result.get('message')}")
            # Raise HTTPException to propagate the error to the FastAPI handler
            raise HTTPException(status_code=500, detail=result.get('message', 'PDF processing failed'))

    except requests.exceptions.RequestException as e:
        logger.error(f"Error communicating with PDF processing service: {e}")
        # Raise HTTPException for service unavailability or request errors
        raise HTTPException(status_code=503, detail=f"Failed to connect to PDF processing service or request failed: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during PDF processing request: {e}")
        # Catch any other unexpected errors
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred during processing: {e}")
