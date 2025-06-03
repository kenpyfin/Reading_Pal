import os
import logging
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from bson import ObjectId # Ensure ObjectId is imported
from bson.errors import InvalidId # Import InvalidId for specific error handling
from typing import Optional, List, Dict, Any # Import types
from datetime import datetime # Import datetime

# Import UserCreate for type hinting
from backend.models.user import UserCreate 

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
    if database is None:
        logger.error("Database not initialized for save_book.")
        return None # Indicate failure
    # Ensure timestamps are set if not provided
    now = datetime.utcnow()
    book_data.setdefault('created_at', now)
    book_data.setdefault('updated_at', now)
    try:
        result = await database.books.insert_one(book_data)
        logger.info(f"Saved book with ID: {result.inserted_id}")
        return str(result.inserted_id) # Return string representation of ObjectId
    except Exception as e:
        logger.error(f"Error saving book: {e}", exc_info=True)
        return None

async def get_book(book_id: str):
    """Retrieves book data by ID."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_book.")
        return None
    try:
        # Use ObjectId to query by MongoDB's primary key
        obj_id = ObjectId(book_id)
    except Exception:
        logger.error(f"Invalid book ID format: {book_id}")
        return None # Handle invalid ObjectId format

    try:
        book = await database.books.find_one({"_id": obj_id})
        # No need to convert _id here, let the caller handle it if needed for Pydantic
        return book # Return the raw document (dict) or None
    except Exception as e:
        logger.error(f"Error fetching book {book_id}: {e}", exc_info=True)
        return None

async def get_books(filter: Optional[dict] = None, projection: Optional[dict] = None):
    """Retrieves all books with optional filter and projection."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_books.")
        return [] # Return empty list on error
    try:
        # Use the provided filter, or an empty dictionary if no filter is provided
        books_cursor = database.books.find(filter or {}, projection)
        books_list = await books_cursor.to_list(length=1000) # Adjust length as needed
        return books_list # Returns list of dicts
    except Exception as e:
        logger.error(f"Error fetching all books: {e}", exc_info=True)
        return []

async def get_book_by_job_id(job_id: str):
    """Finds a book document by its processing job_id."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_book_by_job_id.")
        return None
    try:
        book_doc = await database.books.find_one({"job_id": job_id})
        # No need to convert _id here, let the caller handle it
        return book_doc # Return the raw document (dict) or None
    except Exception as e:
        logger.error(f"Error fetching book by job_id {job_id}: {e}", exc_info=True)
        return None

async def update_book(book_id: str, update_data: dict):
    """Updates a book document by its _id string."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for update_book.")
        return False # Indicate failure
    try:
        obj_id = ObjectId(book_id)
    except Exception:
        logger.error(f"Invalid book ID format for update: {book_id}")
        return False

    try:
        # Ensure updated_at is set
        update_data["updated_at"] = datetime.utcnow()
        result = await database.books.update_one(
            {"_id": obj_id},
            {"$set": update_data}
        )
        if result.matched_count == 0:
             logger.warning(f"No book found with ID {book_id} to update.")
             return False
        logger.info(f"Updated book {book_id}. Matched count: {result.matched_count}, Modified count: {result.modified_count}")
        # Return True if at least one document was matched (even if no fields changed)
        return True
    except Exception as e:
        logger.error(f"Error updating book {book_id}: {e}", exc_info=True)
        return False # Indicate failure


async def delete_book_record(book_id: str) -> bool:
    """
    Deletes a book record from the database by its ID.
    Returns True if deletion was successful, False otherwise.
    """
    database = get_database()
    if database is None:
        logger.error("Database not initialized for delete_book_record.")
        return False
    
    try:
        # Ensure book_id is a valid ObjectId string before attempting conversion
        if not ObjectId.is_valid(book_id):
            logger.warning(f"Invalid Book ID format for deletion: {book_id}")
            return False
        object_id = ObjectId(book_id)
        delete_result = await database.books.delete_one({"_id": object_id})
        if delete_result.deleted_count == 0:
            logger.warning(f"No book record found with ID {book_id} to delete.")
            return False
        logger.info(f"Book record with ID {book_id} deleted successfully from MongoDB.")
        return True
    except InvalidId:
        logger.error(f"Invalid Book ID format for deletion: {book_id}")
        return False
    except Exception as e:
        logger.error(f"Error deleting book record {book_id} from MongoDB: {e}", exc_info=True)
        return False

# --- User Database Operations ---

async def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a user by their MongoDB ObjectId string."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_user_by_id.")
        return None
    try:
        if not ObjectId.is_valid(user_id):
            logger.warning(f"Invalid user ID format for get_user_by_id: {user_id}")
            return None
        obj_id = ObjectId(user_id)
        user_doc = await database.users.find_one({"_id": obj_id})
        return user_doc  # Returns dict or None
    except Exception as e:
        logger.error(f"Error fetching user by ID {user_id}: {e}", exc_info=True)
        return None

async def get_user_by_google_id(google_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a user by their Google ID."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_user_by_google_id.")
        return None
    try:
        user_doc = await database.users.find_one({"google_id": google_id})
        return user_doc # Returns dict or None
    except Exception as e:
        logger.error(f"Error fetching user by google_id {google_id}: {e}", exc_info=True)
        return None

async def create_or_update_user_from_google(user_data: 'UserCreate') -> Optional[str]:
    """
    Creates a new user or updates an existing user based on Google profile information.
    Returns the user's MongoDB ObjectId as a string if successful, otherwise None.
    'user_data' is an instance of UserCreate Pydantic model.
    """
    database = get_database()
    if database is None:
        logger.error("Database not initialized for create_or_update_user_from_google.")
        return None

    now = datetime.utcnow()
    
    # 1. Try to find user by google_id
    user_doc = await database.users.find_one({"google_id": user_data.google_id})

    if user_doc:
        # User found by google_id, update their information
        update_fields = {
            "email": user_data.email, # Google is source of truth for email if linked
            "full_name": user_data.full_name,
            "picture": str(user_data.picture) if user_data.picture else None, # Convert HttpUrl to string
            "updated_at": now
        }
        update_fields = {k: v for k, v in update_fields.items() if v is not None} # Remove fields that are None in user_data

        # Ensure 'updated_at' is always part of the update if other fields are present
        if update_fields: # If there's anything to update (besides potentially just updated_at)
            await database.users.update_one(
                {"_id": user_doc["_id"]},
                {"$set": update_fields}
            )
            logger.info(f"Updated user (found by google_id {user_data.google_id}): {user_data.email}. Modified count: {await database.users.count_documents({'_id': user_doc['_id']})}") # Log modified count or similar
        else: # Only updated_at needs to be set (e.g. if all other fields from Google were None or matched)
             await database.users.update_one(
                {"_id": user_doc["_id"]},
                {"$set": {"updated_at": now}}
            )
        logger.info(f"User {user_data.email} (Google ID: {user_data.google_id}) processed. DB ID: {user_doc['_id']}.")
        return str(user_doc["_id"])
    else:
        # No user found by google_id. Try to find by email.
        logger.info(f"User not found by google_id {user_data.google_id}. Checking by email: {user_data.email}")
        user_doc_by_email = await database.users.find_one({"email": user_data.email})

        if user_doc_by_email:
            # User found by email. Link Google ID and update info.
            logger.info(f"User found by email {user_data.email}. Linking google_id {user_data.google_id}.")
            update_fields = {
                "google_id": user_data.google_id, # Add/update google_id
                "full_name": user_data.full_name, # Update name from Google
                "picture": str(user_data.picture) if user_data.picture else None,     # Convert HttpUrl to string
                "updated_at": now
            }
            # Ensure email isn't accidentally set to None if user_data.email was None (UserCreate model should enforce email presence)
            if user_data.email:
                 update_fields["email"] = user_data.email # This should be redundant if UserCreate enforces email
            
            update_fields = {k: v for k, v in update_fields.items() if v is not None}

            await database.users.update_one(
                {"_id": user_doc_by_email["_id"]},
                {"$set": update_fields}
            )
            logger.info(f"Linked google_id to existing user (found by email {user_data.email}). DB ID: {user_doc_by_email['_id']}.")
            return str(user_doc_by_email["_id"])
        else:
            # No user found by google_id or email. Create a new user.
            logger.info(f"No user found by email {user_data.email} either. Creating new user.")
            new_user_doc_data = {
                "google_id": user_data.google_id,
                "email": user_data.email,
                "full_name": user_data.full_name,
                "picture": str(user_data.picture) if user_data.picture else None, # Convert HttpUrl to string
                "is_active": True,
                "is_superuser": False,
                "created_at": now,
                "updated_at": now
            }
            try:
                result = await database.users.insert_one(new_user_doc_data)
                logger.info(f"Created new user {user_data.email} (Google ID: {user_data.google_id}) with DB ID: {result.inserted_id}")
                return str(result.inserted_id)
            except Exception as e: # This could still be a different DB error (e.g. connection, other constraint)
                logger.error(f"Error creating new user {user_data.email} even after checks: {e}", exc_info=True)
                return None

# --- Keep Note Database Operations ---
# ... (rest of the note functions remain unchanged)
async def save_note(note_data: dict):
    """Saves a new note to the database."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for save_note.")
        return None
    # The input note_data dict should contain fields like 'book_id', 'content', etc.
    # MongoDB will automatically add the _id field as an ObjectId upon insertion.
    try:
        result = await database.notes.insert_one(note_data)
        # Return the inserted document's _id (which is an ObjectId)
        return result.inserted_id
    except Exception as e:
        logger.error(f"Error saving note: {e}", exc_info=True)
        return None


async def get_notes_by_book_id(book_id: str):
    """Fetches all notes for a specific book."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_notes_by_book_id.")
        return []
    # Assuming book_id is stored as a string
    try:
        notes_cursor = database.notes.find({"book_id": book_id})
        # Convert cursor to a list of dictionaries
        notes_list = await notes_cursor.to_list(length=1000) # Adjust length as needed
        return notes_list
    except Exception as e:
        logger.error(f"Error fetching notes for book {book_id}: {e}", exc_info=True)
        return []


async def get_note_by_id(note_id: str):
    """Fetches a single note by its ID."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for get_note_by_id.")
        return None
    try:
        # Convert the string ID to MongoDB's ObjectId
        obj_id = ObjectId(note_id)
    except InvalidId: # Catch specific InvalidId error
        logger.error(f"Invalid note ID format: {note_id}")
        return None 
    except Exception as e: # Catch other potential errors
        logger.error(f"Error converting note ID {note_id} to ObjectId: {e}", exc_info=True)
        return None

    try:
        note = await database.notes.find_one({"_id": obj_id})
        return note
    except Exception as e:
        logger.error(f"Error fetching note {note_id}: {e}", exc_info=True)
        return None


async def update_note(note_id: str, update_data: dict):
    """Updates an existing note."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for update_note.")
        return None
    try:
        obj_id = ObjectId(note_id)
    except Exception:
        logger.error(f"Invalid note ID format: {note_id}")
        return None # Return None if the ID format is invalid

    try:
        # Use $set to update specific fields from the update_data dictionary
        result = await database.notes.update_one(
            {"_id": obj_id},
            {"$set": update_data}
        )
        # Check if the document was found and modified
        if result.matched_count == 0:
            logger.warning(f"No note found with ID {note_id} to update.")
            return None # Document not found
        # Optionally, fetch the updated document to return
        updated_note = await get_note_by_id(note_id)
        return updated_note
    except Exception as e:
        logger.error(f"Error updating note {note_id}: {e}", exc_info=True)
        return None

async def delete_note_by_id(note_id: str) -> bool:
    """Deletes a note by its ID."""
    database = get_database()
    if database is None:
        logger.error(f"Database not initialized for delete_note_by_id (note_id: {note_id}).")
        return False
    try:
        if not ObjectId.is_valid(note_id):
            logger.warning(f"Invalid note_id format for deletion: {note_id}")
            return False
        obj_id = ObjectId(note_id)
        result = await database.notes.delete_one({"_id": obj_id})
        if result.deleted_count > 0:
            logger.info(f"Note with id {note_id} deleted successfully.")
            return True
        else:
            logger.warning(f"Note with id {note_id} not found for deletion.")
            return False
    except Exception as e:
        logger.error(f"Error deleting note {note_id}: {e}", exc_info=True)
        return False

# --- Bookmark Database Operations ---

async def create_bookmark(bookmark_data: dict) -> Optional[Dict[str, Any]]:
    """Creates a new bookmark in the database."""
    database = get_database()
    if database is None:
        logger.error("Database not initialized for create_bookmark.")
        return None
    
    # Ensure timestamps are set
    now = datetime.utcnow()
    bookmark_data.setdefault('created_at', now)
    bookmark_data.setdefault('updated_at', now)

    try:
        result = await database.bookmarks.insert_one(bookmark_data)
        if result.inserted_id:
            created_bookmark = await database.bookmarks.find_one({"_id": result.inserted_id})
            return created_bookmark
        return None
    except Exception as e:
        logger.error(f"Error creating bookmark: {e}", exc_info=True)
        return None

async def get_bookmarks_by_book_id(book_id: str) -> List[Dict[str, Any]]:
    """Retrieves all bookmarks for a given book_id."""
    database = get_database()
    if database is None:
        logger.error(f"Database not initialized for get_bookmarks_by_book_id (book_id: {book_id}).")
        return []
    
    bookmarks = []
    try:
        # Assuming book_id in bookmarks collection is stored as the string ID from the Book model
        cursor = database.bookmarks.find({"book_id": book_id}).sort("created_at", 1) # Sort by creation time
        async for bookmark in cursor:
            bookmarks.append(bookmark)
        return bookmarks
    except Exception as e:
        logger.error(f"Error fetching bookmarks for book_id {book_id}: {e}", exc_info=True)
        return []

async def get_bookmark_by_id(bookmark_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single bookmark by its ID."""
    database = get_database()
    if database is None:
        logger.error(f"Database not initialized for get_bookmark_by_id (bookmark_id: {bookmark_id}).")
        return None
    try:
        if not ObjectId.is_valid(bookmark_id):
            logger.warning(f"Invalid bookmark_id format: {bookmark_id}")
            return None
        obj_id = ObjectId(bookmark_id)
        bookmark = await database.bookmarks.find_one({"_id": obj_id})
        return bookmark
    except Exception as e:
        logger.error(f"Error fetching bookmark by id {bookmark_id}: {e}", exc_info=True)
        return None

async def delete_bookmark_by_id(bookmark_id: str) -> bool:
    """Deletes a bookmark by its ID."""
    database = get_database()
    if database is None:
        logger.error(f"Database not initialized for delete_bookmark_by_id (bookmark_id: {bookmark_id}).")
        return False
    try:
        if not ObjectId.is_valid(bookmark_id):
            logger.warning(f"Invalid bookmark_id format for deletion: {bookmark_id}")
            return False
        obj_id = ObjectId(bookmark_id)
        result = await database.bookmarks.delete_one({"_id": obj_id})
        return result.deleted_count > 0
    except Exception as e:
        logger.error(f"Error deleting bookmark {bookmark_id}: {e}", exc_info=True)
        return False

async def update_bookmark_name(bookmark_id: str, name: str) -> Optional[Dict[str, Any]]:
    """Updates the name of a bookmark."""
    database = get_database()
    if database is None:
        logger.error(f"Database not initialized for update_bookmark_name (bookmark_id: {bookmark_id}).")
        return None
    try:
        if not ObjectId.is_valid(bookmark_id):
            logger.warning(f"Invalid bookmark_id format for update: {bookmark_id}")
            return None
        
        obj_id = ObjectId(bookmark_id)
        update_result = await database.bookmarks.update_one(
            {"_id": obj_id},
            {"$set": {"name": name, "updated_at": datetime.utcnow()}}
        )
        
        if update_result.matched_count == 0:
            logger.warning(f"No bookmark found with ID {bookmark_id} to update name.")
            return None # Bookmark not found
        
        # Fetch and return the updated document
        updated_bookmark = await database.bookmarks.find_one({"_id": obj_id})
        return updated_bookmark
    except Exception as e:
        logger.error(f"Error updating bookmark name for {bookmark_id}: {e}", exc_info=True)
        return None
