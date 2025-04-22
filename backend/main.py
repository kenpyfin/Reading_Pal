import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import logging

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Reading Pal Backend API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # TODO: Restrict origins in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files directory for images
# This path must match the IMAGES_PATH configured in .env and docker-compose
images_path = os.getenv("IMAGES_PATH")
if images_path and os.path.exists(images_path):
    app.mount("/images", StaticFiles(directory=images_path), name="images")
    logger.info(f"Serving static images from {images_path} at /images")
else:
    logger.warning(f"IMAGES_PATH not set or directory not found: {images_path}. Static image serving disabled.")

# Mount static files directory for markdown (optional, but good for debugging/direct access)
# This path must match the MARKDOWN_PATH configured in .env and docker-compose
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
from .api import books # Import the books router
from .api import notes # Import the notes router
# from .api import llm # Keep commented for future phases
app.include_router(books.router, prefix="/books", tags=["books"])
app.include_router(notes.router, prefix="/notes", tags=["notes"]) # Uncomment this line
# app.include_router(llm.router, prefix="/llm", tags=["llm"]) # Keep commented for future phases

# Add database connection logic (connect on startup/shutdown)
from .db.mongodb import connect_to_mongo, close_mongo_connection

@app.on_event("startup")
async def startup_db_client():
    await connect_to_mongo()

@app.on_event("shutdown")
async def shutdown_db_client():
    await close_mongo_connection()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("BACKEND_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
