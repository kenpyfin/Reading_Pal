import os
import logging
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
import uvicorn

# Configure logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Image Serving Service")

# Get the base path for images from environment variable
# This path is where the IMAGES_PATH from the host is mounted inside the container
IMAGES_BASE_PATH_STR = os.getenv("IMAGES_BASE_PATH", "/app/storage/images")
IMAGES_BASE_PATH = Path(IMAGES_BASE_PATH_STR)

# Ensure the base path exists (optional, as docker mount should handle it)
if not IMAGES_BASE_PATH.exists() or not IMAGES_BASE_PATH.is_dir():
    logger.warning(f"Image base path {IMAGES_BASE_PATH} does not exist or is not a directory. Service might not find images.")

@app.get("/images/{filepath:path}")
async def serve_image(filepath: str):
    """
    Serves an image file.
    The {filepath:path} parameter captures everything after /images/,
    allowing for subdirectories.
    """
    try:
        # Construct the full path to the image file
        # IMPORTANT: Ensure filepath is sanitized or validated if it comes from untrusted sources
        # For this internal service, we assume filepath is part of the URL constructed by our frontend
        image_file_path = IMAGES_BASE_PATH / filepath

        logger.debug(f"Attempting to serve image: {image_file_path}")

        if not image_file_path.exists() or not image_file_path.is_file():
            logger.warning(f"Image not found: {image_file_path}")
            raise HTTPException(status_code=404, detail="Image not found")

        # Basic security check: ensure the resolved path is still within the base directory
        if not image_file_path.resolve().is_relative_to(IMAGES_BASE_PATH.resolve()):
            logger.error(f"Path traversal attempt detected: {filepath} resolved outside {IMAGES_BASE_PATH}")
            raise HTTPException(status_code=403, detail="Forbidden")

        return FileResponse(image_file_path)

    except HTTPException as http_exc:
        # Re-raise HTTPException to let FastAPI handle it
        raise http_exc
    except Exception as e:
        logger.error(f"Error serving image {filepath}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8503")) # Default to 8503 if not set
    logger.info(f"Starting Image Serving Service on port {port}...")
    logger.info(f"Serving images from base path: {IMAGES_BASE_PATH}")
    uvicorn.run(app, host="0.0.0.0", port=port)
