import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware # Import SessionMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import logging
import uvicorn # Import uvicorn
import asyncio # Import asyncio for background tasks

# Load environment variables
load_dotenv()

# Import settings from the new config file
# from backend.core.config import settings # REMOVE THIS LINE

# Configure logging
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Reading Pal Backend API")

# Add SessionMiddleware - THIS MUST BE ADDED BEFORE ROUTERS THAT USE SESSIONS/OAUTH
# It's used by Authlib to store temporary states (e.g., OAuth state parameter)
SECRET_KEY_MAIN = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed_in_production_main")
if SECRET_KEY_MAIN == "a_very_secret_key_that_should_be_changed_in_production_main":
    print("WARNING: main.py: SECRET_KEY is using its default insecure value. "
          "Please generate a strong, unique key and set it in your .env file for production environments.")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY_MAIN)

# Add CORS middleware
FRONTEND_URL_MAIN = os.getenv("FRONTEND_URL", "http://localhost:3100")
app.add_middleware(
    CORSMiddleware,
    # Adjust allow_origins to your frontend URL in production for better security
    allow_origins=[FRONTEND_URL_MAIN, "http://localhost:3000", "http://localhost:3100"], # Example: allow frontend
    allow_credentials=True, # Important for cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

# Get environment variables
BACKEND_PORT = int(os.getenv("BACKEND_PORT", 8000)) # Read BACKEND_PORT, default to 8000 if not set

# Add print statements to debug the port value
print(f"DEBUG: Raw BACKEND_PORT env var: {os.getenv('BACKEND_PORT')}")
print(f"DEBUG: Parsed BACKEND_PORT for Uvicorn: {BACKEND_PORT}")


# Mount static files directory for images
# This path must match the IMAGES_PATH configured in .env and docker-compose
# It should be the CONTAINER path, which is correctly set in docker-compose.yml
images_path = os.getenv("IMAGES_PATH")
if images_path and os.path.exists(images_path):
    app.mount("/images", StaticFiles(directory=images_path), name="images")
    logger.info(f"Serving static images from {images_path} at /images")
else:
    logger.warning(f"IMAGES_PATH not set or directory not found: {images_path}. Static image serving disabled.")

# Mount static files directory for markdown (optional, but good for debugging/direct access)
# This path must match the MARKDOWN_PATH configured in .env and docker-compose
# It should be the CONTAINER path, which is correctly set in docker-compose.yml
markdown_path = os.getenv("MARKDOWN_PATH")
if markdown_path and os.path.exists(markdown_path):
     # Choose a different path than /markdown to avoid conflicts if needed
     app.mount("/markdown_files", StaticFiles(directory=markdown_path), name="markdown_files")
     logger.info(f"Serving static markdown files from {markdown_path} at /markdown_files")
else:
     logger.warning(f"MARKDOWN_PATH not set or directory not found: {markdown_path}. Static markdown serving disabled.")


@app.get("/")
async def read_root():
    return {"message": "Reading Pal Backend API is running"}

@app.get("/health")
async def health_check():
    """Basic health check endpoint."""
    # TODO: Add more sophisticated checks, e.g., database connection status
    return {"status": "ok"}


# Include routers for books, notes, llm
# Use absolute imports relative to the /app directory
from backend.api import books
from backend.api import notes
from backend.api import llm
from backend.api import bookmarks as bookmarks_router
from backend.api import auth_routes as auth_router # Import the new auth router
from backend.services.cleanup_service import run_cleanup_task # Import the cleanup task

app.include_router(auth_router.router, prefix="/api/auth", tags=["authentication"]) # Add the auth router
app.include_router(books.router, prefix="/api/books", tags=["books"])
app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
app.include_router(llm.router, prefix="/api/llm", tags=["llm"])
app.include_router(bookmarks_router.router, prefix="/api/bookmarks", tags=["bookmarks"])

# Add database connection logic (connect on startup/shutdown)
from backend.db.mongodb import connect_to_mongo, close_mongo_connection

@app.on_event("startup")
async def startup_db_client():
    await connect_to_mongo()
    # Start the background cleanup task
    asyncio.create_task(run_cleanup_task())
    logger.info("Background cleanup task started.")


@app.on_event("shutdown")
async def shutdown_db_client():
    await close_mongo_connection()
    # Note: Background tasks are typically cancelled automatically on shutdown,
    # but explicit handling might be needed for graceful shutdown in complex cases.
    logger.info("Database connection closed.")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=BACKEND_PORT) # Use the BACKEND_PORT variable
