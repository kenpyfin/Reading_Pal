import os
import logging
import re
import uuid
from typing import Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Header, Depends, Request
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
import uvicorn

# Configure logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Image Serving Service")

# Note: CORS is handled by nginx at the proxy level to avoid duplicate headers
# See nginx/readingpal.subdomain.conf location /images/upload for CORS configuration

# Get the base path for images from environment variable
# This path is where the IMAGES_PATH from the host is mounted inside the container
IMAGES_BASE_PATH_STR = os.getenv("IMAGES_BASE_PATH", "/app/storage/images")
IMAGES_BASE_PATH = Path(IMAGES_BASE_PATH_STR)

# Define subdirectories for different image types
APP_IMAGES_DIR = "app"  # Private images from PDF processing (localhost only)
PUBLIC_IMAGES_DIR = "public"  # Public images uploaded via API (accessible from outside network)

# Ensure the base path exists (optional, as docker mount should handle it)
if not IMAGES_BASE_PATH.exists() or not IMAGES_BASE_PATH.is_dir():
    logger.warning(f"Image base path {IMAGES_BASE_PATH} does not exist or is not a directory. Service might not find images.")
    # Try to create the directory if it doesn't exist
    try:
        IMAGES_BASE_PATH.mkdir(parents=True, exist_ok=True)
        logger.info(f"Created image base path: {IMAGES_BASE_PATH}")
    except Exception as e:
        logger.error(f"Failed to create image base path {IMAGES_BASE_PATH}: {e}")

# Ensure subdirectories exist
APP_IMAGES_PATH = IMAGES_BASE_PATH / APP_IMAGES_DIR
PUBLIC_IMAGES_PATH = IMAGES_BASE_PATH / PUBLIC_IMAGES_DIR
try:
    APP_IMAGES_PATH.mkdir(parents=True, exist_ok=True)
    PUBLIC_IMAGES_PATH.mkdir(parents=True, exist_ok=True)
    logger.info(f"Created app images directory: {APP_IMAGES_PATH}")
    logger.info(f"Created public images directory: {PUBLIC_IMAGES_PATH}")
except Exception as e:
    logger.error(f"Failed to create image subdirectories: {e}")

# IP-based access control for app images
# App images are only accessible from localhost
ALLOWED_LOCALHOST_IPS = ["127.0.0.1", "::1", "localhost"]
# Also allow the host IP if specified (for docker network)
ALLOWED_HOST_IP = os.getenv("ALLOWED_HOST_IP", "10.0.1.22")  # Default from nginx config

# Configuration for uploads
ALLOWED_IMAGE_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/gif", 
    "image/webp", "image/bmp", "image/tiff", "image/svg+xml"
}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg"}
ALLOWED_VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov"}
ALLOWED_MEDIA_EXTENSIONS = ALLOWED_EXTENSIONS | ALLOWED_VIDEO_EXTENSIONS
MAX_FILE_SIZE = int(os.getenv("MAX_IMAGE_SIZE", "10485760"))  # Default 10MB in bytes
MAX_VIDEO_SIZE = int(os.getenv("MAX_VIDEO_SIZE", "52428800"))  # Default 50MB in bytes

# Authentication configuration
IMAGE_UPLOAD_API_KEY = os.getenv("IMAGE_UPLOAD_API_KEY", "")
AUTH_ENABLED = bool(IMAGE_UPLOAD_API_KEY)  # Only enable auth if API key is set

if AUTH_ENABLED:
    logger.info("Image upload authentication is ENABLED (IMAGE_UPLOAD_API_KEY is set)")
else:
    logger.warning("Image upload authentication is DISABLED (IMAGE_UPLOAD_API_KEY not set). Set it in .env for production security.")

async def verify_api_key(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """
    Dependency to verify API key for image upload endpoint.
    If IMAGE_UPLOAD_API_KEY is not set in environment, authentication is disabled.
    """
    if not AUTH_ENABLED:
        # Authentication disabled - allow all requests
        return True
    
    if not x_api_key:
        logger.warning("Image upload request missing X-API-Key header")
        raise HTTPException(
            status_code=401,
            detail="Authentication required. Please provide X-API-Key header.",
            headers={"WWW-Authenticate": "ApiKey"},
        )
    
    if x_api_key != IMAGE_UPLOAD_API_KEY:
        logger.warning(f"Invalid API key provided for image upload (key length: {len(x_api_key)})")
        raise HTTPException(
            status_code=403,
            detail="Invalid API key",
        )
    
    logger.debug("API key verified successfully")
    return True

def get_client_ip(request: Request) -> str:
    """Extract client IP address from request, handling proxy headers."""
    # Check X-Forwarded-For header first (from nginx/proxy)
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        # X-Forwarded-For can contain multiple IPs, take the first one
        client_ip = forwarded_for.split(",")[0].strip()
        return client_ip
    
    # Check X-Real-IP header (alternative proxy header)
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    
    # Fallback to direct client IP
    if request.client:
        return request.client.host
    
    return "unknown"

def is_localhost_request(request: Request) -> bool:
    """Check if request is from localhost."""
    client_ip = get_client_ip(request)
    
    # Check against allowed localhost IPs
    allowed_ips = ALLOWED_LOCALHOST_IPS + [ALLOWED_HOST_IP]
    
    is_localhost = (
        client_ip in allowed_ips or
        client_ip.startswith("127.") or
        client_ip.startswith("::1") or
        client_ip == "localhost"
    )
    
    return is_localhost

def sanitize_filename(filename: str) -> str:
    """Replaces spaces with underscores and removes potentially problematic characters."""
    # Get the base filename without extension
    base_name, ext = os.path.splitext(filename)
    sanitized = base_name.replace(' ', '_')
    sanitized = re.sub(r'[^\w.-]', '', sanitized)
    sanitized = sanitized.strip('._-')
    if not sanitized:
        sanitized = "uploaded_image"
    # Preserve the extension
    return sanitized + ext.lower()

def validate_image_file(file: UploadFile) -> tuple[bool, Optional[str]]:
    """
    Validates that the uploaded file is an allowed image or video for public upload.
    Returns (is_valid, error_message)
    """
    if not file.filename:
        return False, "No filename provided"

    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in ALLOWED_MEDIA_EXTENSIONS:
        return False, (
            f"File extension '{file_ext}' not allowed. "
            f"Allowed extensions: {', '.join(sorted(ALLOWED_MEDIA_EXTENSIONS))}"
        )

    if file_ext in ALLOWED_VIDEO_EXTENSIONS:
        if file.content_type and file.content_type not in ALLOWED_VIDEO_TYPES:
            return False, (
                f"Content type '{file.content_type}' not allowed. "
                f"Allowed video types: {', '.join(sorted(ALLOWED_VIDEO_TYPES))}"
            )
        return True, None

    if file.content_type and file.content_type not in ALLOWED_IMAGE_TYPES:
        return False, f"Content type '{file.content_type}' not allowed. Allowed types: {', '.join(ALLOWED_IMAGE_TYPES)}"

    return True, None

@app.get("/images/public/{filepath:path}")
async def serve_public_image(filepath: str):
    """
    Serves a public image file (uploaded via API).
    These images are accessible via direct URL without authentication.
    """
    try:
        # Construct the full path to the public image file
        image_file_path = PUBLIC_IMAGES_PATH / filepath

        logger.debug(f"Attempting to serve public image: {image_file_path}")

        if not image_file_path.exists() or not image_file_path.is_file():
            logger.warning(f"Public image not found: {image_file_path}")
            raise HTTPException(status_code=404, detail="Image not found")

        # Basic security check: ensure the resolved path is still within the public directory
        if not image_file_path.resolve().is_relative_to(PUBLIC_IMAGES_PATH.resolve()):
            logger.error(f"Path traversal attempt detected: {filepath} resolved outside {PUBLIC_IMAGES_PATH}")
            raise HTTPException(status_code=403, detail="Forbidden")

        return FileResponse(image_file_path)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Error serving public image {filepath}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")

@app.get("/images/app/{filepath:path}")
async def serve_app_image(request: Request, filepath: str):
    """
    Serves an app image file (from PDF processing).
    These images are only accessible from localhost for security.
    Public images should use /images/public/ endpoint.
    """
    # Check if request is from localhost
    if not is_localhost_request(request):
        client_ip = get_client_ip(request)
        logger.warning(f"App image request blocked - not from localhost. Client IP: {client_ip}, filepath: {filepath}")
        raise HTTPException(
            status_code=403,
            detail="Access denied. App images are only accessible from localhost.",
        )
    
    client_ip = get_client_ip(request)
    logger.debug(f"App image request from localhost IP: {client_ip} for filepath: {filepath}")
    
    try:
        # Construct the full path to the app image file
        image_file_path = APP_IMAGES_PATH / filepath

        logger.debug(f"Serving app image: {image_file_path} to localhost client: {client_ip}")

        if not image_file_path.exists() or not image_file_path.is_file():
            logger.warning(f"App image not found: {image_file_path}")
            raise HTTPException(status_code=404, detail="Image not found")

        # Basic security check: ensure the resolved path is still within the app directory
        if not image_file_path.resolve().is_relative_to(APP_IMAGES_PATH.resolve()):
            logger.error(f"Path traversal attempt detected: {filepath} resolved outside {APP_IMAGES_PATH}")
            raise HTTPException(status_code=403, detail="Forbidden")

        return FileResponse(image_file_path)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Error serving app image {filepath}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/images/upload")
async def upload_image(
    file: UploadFile = File(...),
    subdirectory: Optional[str] = Form(None),
    _: bool = Depends(verify_api_key)
):
    """
    Uploads an image file to the image storage directory.
    
    Args:
        file: The image file to upload
        subdirectory: Optional subdirectory within the images path (will be sanitized)
    
    Returns:
        JSON response with the image URL and filename
    """
    logger.info(f"Received image upload request: {file.filename}")
    
    try:
        # Validate the image file
        is_valid, error_msg = validate_image_file(file)
        if not is_valid:
            logger.warning(f"Image validation failed: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)
        
        # Read file content to check size
        file_content = await file.read()
        file_size = len(file_content)

        file_ext = os.path.splitext(file.filename)[1].lower()
        max_size = MAX_VIDEO_SIZE if file_ext in ALLOWED_VIDEO_EXTENSIONS else MAX_FILE_SIZE

        if file_size > max_size:
            logger.warning(f"File size {file_size} exceeds maximum {max_size}")
            raise HTTPException(
                status_code=413,
                detail=f"File size ({file_size} bytes) exceeds maximum allowed size ({max_size} bytes)",
            )
        
        if file_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        
        # Sanitize filename
        sanitized_filename = sanitize_filename(file.filename)
        
        # API uploads go to the public directory
        target_dir = PUBLIC_IMAGES_PATH
        
        # Handle subdirectory if provided (within public directory)
        sanitized_subdir = None
        if subdirectory:
            # Sanitize subdirectory to prevent path traversal
            sanitized_subdir = re.sub(r'[^\w.-]', '', subdirectory.replace(' ', '_')).strip('._-')
            if sanitized_subdir:
                target_dir = PUBLIC_IMAGES_PATH / sanitized_subdir
                target_dir.mkdir(parents=True, exist_ok=True)
                logger.info(f"Using subdirectory within public: {sanitized_subdir}")
        
        # Check if file already exists, append UUID if needed
        final_file_path = target_dir / sanitized_filename
        if final_file_path.exists():
            # Add UUID to filename to avoid overwriting
            base_name, ext = os.path.splitext(sanitized_filename)
            unique_filename = f"{base_name}_{uuid.uuid4().hex[:8]}{ext}"
            final_file_path = target_dir / unique_filename
            sanitized_filename = unique_filename
            logger.info(f"File already exists, using unique filename: {unique_filename}")
        
        # Ensure the resolved path is still within the public directory (security check)
        if not final_file_path.resolve().is_relative_to(PUBLIC_IMAGES_PATH.resolve()):
            logger.error(f"Path traversal attempt detected: {final_file_path} resolved outside {PUBLIC_IMAGES_PATH}")
            raise HTTPException(status_code=403, detail="Invalid file path")
        
        # Write file to disk
        try:
            with open(final_file_path, "wb") as buffer:
                buffer.write(file_content)
            logger.info(f"Successfully saved image to: {final_file_path}")
        except OSError as e:
            logger.error(f"Failed to write image file {final_file_path}: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Failed to save image: {e}")
        
        # Construct the image URL path for public images
        # Public images are accessible via /images/public/...
        if sanitized_subdir:
            image_url_path = f"{sanitized_subdir}/{sanitized_filename}"
        else:
            image_url_path = sanitized_filename
        image_url_path = f"/images/public/{image_url_path}"
        
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "message": "Image uploaded successfully",
                "filename": sanitized_filename,
                "url": image_url_path,
                "size": file_size,
                "content_type": file.content_type
            }
        )
    
    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Unexpected error during image upload: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.get("/images/{filepath:path}")
async def serve_image_legacy(request: Request, filepath: str):
    """
    Legacy endpoint for backward compatibility.
    Handles old markdown files that reference /images/filename.png (without /app/ or /public/ prefix).
    Serves from app/ directory and requires localhost access (treats old images as app images).
    
    Note: This endpoint is matched last, after /images/public/ and /images/app/ routes.
    """
    # Check if request is from localhost (legacy images are treated as app images)
    if not is_localhost_request(request):
        client_ip = get_client_ip(request)
        logger.warning(f"Legacy image request blocked - not from localhost. Client IP: {client_ip}, filepath: {filepath}")
        raise HTTPException(
            status_code=403,
            detail="Access denied. Legacy images are only accessible from localhost.",
        )
    
    try:
        # Try app directory first (most likely for old images)
        image_file_path = APP_IMAGES_PATH / filepath
        
        # If not found in app, try public (unlikely but possible)
        if not image_file_path.exists():
            image_file_path = PUBLIC_IMAGES_PATH / filepath

        logger.debug(f"Attempting to serve legacy image: {image_file_path}")

        if not image_file_path.exists() or not image_file_path.is_file():
            logger.warning(f"Legacy image not found: {image_file_path}")
            raise HTTPException(status_code=404, detail="Image not found")

        # Security check: ensure path is within allowed directories
        if not (image_file_path.resolve().is_relative_to(APP_IMAGES_PATH.resolve()) or 
                image_file_path.resolve().is_relative_to(PUBLIC_IMAGES_PATH.resolve())):
            logger.error(f"Path traversal attempt detected: {filepath}")
            raise HTTPException(status_code=403, detail="Forbidden")

        return FileResponse(image_file_path)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Error serving legacy image {filepath}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8503")) # Default to 8503 if not set
    logger.info(f"Starting Image Serving Service on port {port}...")
    logger.info(f"Serving images from base path: {IMAGES_BASE_PATH}")
    uvicorn.run(app, host="0.0.0.0", port=port)
