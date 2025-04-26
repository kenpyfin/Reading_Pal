import os
import logging
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from bson import ObjectId # Import ObjectId for handling MongoDB _id

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

async def save_book(book_data: dict):
    """Saves book data to the database."""
    database = get_database()
    result = await database.books.insert_one(book_data)
    logger.info(f"Saved book with ID: {result.inserted_id}")
    return str(result.inserted_id)

async def get_book(book_id: str):
    """Retrieves book data by ID."""
    database = get_database()
    try:
        # Use ObjectId to query by MongoDB's primary key
        obj_id = ObjectId(book_id)
    except Exception:
        logger.error(f"Invalid book ID format: {book_id}")
        return None # Handle invalid ObjectId format

    book = await database.books.find_one({"_id": obj_id})
    return book

# --- Note Database Operations ---

async def save_note(note_data: dict):
    """Saves a new note to the database."""
    database = get_database()
    # The input note_data dict should contain fields like 'book_id', 'content', etc.
    # MongoDB will automatically add the _id field as an ObjectId upon insertion.
    result = await database.notes.insert_one(note_data)
    # Return the inserted document's _id (which is an ObjectId)
    return result.inserted_id

async def get_notes_by_book_id(book_id: str):
    """Fetches all notes for a specific book."""
    database = get_database()
    # Assuming book_id is stored as a string
    notes_cursor = database.notes.find({"book_id": book_id})
    # Convert cursor to a list of dictionaries
    notes_list = await notes_cursor.to_list(length=1000) # Adjust length as needed
    return notes_list

async def get_note_by_id(note_id: str):
    """Fetches a single note by its ID."""
    database = get_database()
    try:
        # Convert the string ID to MongoDB's ObjectId
        obj_id = ObjectId(note_id)
    except Exception:
        logger.error(f"Invalid note ID format: {note_id}")
        return None # Return None if the ID format is invalid

    note = await database.notes.find_one({"_id": obj_id})
    return note

async def update_note(note_id: str, update_data: dict):
    """Updates an existing note."""
    database = get_database()
    try:
        obj_id = ObjectId(note_id)
    except Exception:
        logger.error(f"Invalid note ID format: {note_id}")
        return None # Return None if the ID format is invalid

    # Use $set to update specific fields from the update_data dictionary
    result = await database.notes.update_one(
        {"_id": obj_id},
        {"$set": update_data}
    )
    # Check if the document was found and modified
    if result.matched_count == 0:
        return None # Document not found
    # Optionally, fetch the updated document to return
    updated_note = await get_note_by_id(note_id)
    return updated_note
