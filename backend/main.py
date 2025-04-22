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


@app.get("/")
async def read_root():
    return {"message": "Reading Pal Backend API is running"}

@app.get("/health")
async def health_check():
    """Basic health check endpoint."""
    # TODO: Add more sophisticated checks, e.g., database connection status
    return {"status": "ok"}


# TODO: Include routers for books, notes, llm
# from .api import books, notes, llm
# app.include_router(books.router, prefix="/books", tags=["books"])
# app.include_router(notes.router, prefix="/notes", tags=["notes"])
# app.include_router(llm.router, prefix="/llm", tags=["llm"])

# Add database connection logic (e.g., connect on startup)
from .db.mongodb import connect_to_mongo, close_mongo_connection, get_database

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
