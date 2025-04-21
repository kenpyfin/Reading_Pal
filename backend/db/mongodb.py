import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import logging

load_dotenv()
logger = logging.getLogger(__name__)

MONGO_URI = os.getenv("MONGO_URI")
DATABASE_NAME = os.getenv("DATABASE_NAME")

client: AsyncIOMotorClient = None
db = None

async def connect_to_mongo():
    global client, db
    if client is None:
        try:
            client = AsyncIOMotorClient(MONGO_URI)
            db = client[DATABASE_NAME]
            # The ismaster command is cheap and does not require auth.
            await client.admin.command('ismaster')
            logger.info("MongoDB connection successful")
        except Exception as e:
            logger.error(f"MongoDB connection failed: {e}")
            # Depending on requirements, you might want to raise the exception
            # or handle it gracefully, e.g., by disabling DB features.
            # For now, we'll just log and continue, but DB operations will fail.
            client = None
            db = None


async def close_mongo_connection():
    global client
    if client:
        client.close()
        logger.info("MongoDB connection closed")
        client = None
        db = None

def get_database():
    if db is None:
         logger.error("Database not initialized. Call connect_to_mongo first.")
         # Or raise an exception: raise ConnectionError("Database not initialized")
    return db

# TODO: Add functions for common DB operations (e.g., get_book, save_book, get_notes, save_note)
