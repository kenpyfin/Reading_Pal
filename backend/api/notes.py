import logging
from fastapi import APIRouter, HTTPException, status
from typing import List
from bson import ObjectId # Import ObjectId
from datetime import datetime # Import datetime

# Import new DB functions and Note models
from ..db.mongodb import save_note, get_notes_by_book_id, update_note, get_note_by_id
from ..models.note import Note, NoteCreate, NoteUpdate

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/", response_model=Note, status_code=status.HTTP_201_CREATED)
async def create_note(note: NoteCreate):
    """
    Creates a new note for a book.
    """
    logger.info(f"Received request to create note for book ID: {note.book_id}")
    try:
        # Validate book_id format (optional, depends on how strict you want to be)
        # if not ObjectId.is_valid(note.book_id):
        #     raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

        # Convert Pydantic model to dict for saving
        note_data = note.model_dump() # Use model_dump() for Pydantic v2+
        # Add timestamps - handled by default_factory in model, but can set explicitly if needed
        # note_data["created_at"] = datetime.utcnow()
        # note_data["updated_at"] = datetime.utcnow()

        note_id = await save_note(note_data)

        # Fetch the saved note to return the full object with _id and timestamps
        saved_note = await get_note_by_id(note_id)
        if not saved_note:
             # This case should ideally not happen if save was successful
             raise HTTPException(status_code=500, detail="Failed to retrieve saved note.")

        # Convert ObjectId to string for the response model
        saved_note['_id'] = str(saved_note['_id'])

        return Note(**saved_note)

    except ConnectionError:
         raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
    except Exception as e:
        logger.error(f"Error creating note: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.get("/{book_id}", response_model=List[Note])
async def get_notes(book_id: str):
    """
    Retrieves all notes for a specific book ID.
    """
    logger.info(f"Received request to get notes for book ID: {book_id}")
    # Validate book_id format (optional)
    # if not ObjectId.is_valid(book_id):
    #     raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

    try:
        notes_list = await get_notes_by_book_id(book_id)

        # Convert ObjectId to string for each note in the list
        # Also convert datetime objects to ISO format strings for JSON serialization
        for note in notes_list:
            note['_id'] = str(note['_id'])
            if isinstance(note.get('created_at'), datetime):
                 note['created_at'] = note['created_at'].isoformat()
            if isinstance(note.get('updated_at'), datetime):
                 note['updated_at'] = note['updated_at'].isoformat()


        return [Note(**note) for note in notes_list]

    except ConnectionError:
         raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
    except Exception as e:
        logger.error(f"Error retrieving notes for book {book_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.put("/{note_id}", response_model=Note)
async def update_existing_note(note_id: str, note_update: NoteUpdate):
    """
    Updates an existing note by its ID.
    """
    logger.info(f"Received request to update note ID: {note_id}")
    # Validate note_id format
    if not ObjectId.is_valid(note_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid note ID format")

    try:
        # Convert Pydantic model to dict, excluding unset fields
        update_data = note_update.model_dump(exclude_unset=True) # Use model_dump()

        if not update_data:
             raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No update data provided")

        # Add/update the updated_at timestamp
        update_data["updated_at"] = datetime.utcnow() # Ensure updated_at is set

        updated_note_doc = await update_note(note_id, update_data)

        if updated_note_doc:
            # Convert ObjectId to string for the response model
            updated_note_doc['_id'] = str(updated_note_doc['_id'])
            # Convert datetime objects to ISO format strings
            if isinstance(updated_note_doc.get('created_at'), datetime):
                 updated_note_doc['created_at'] = updated_note_doc['created_at'].isoformat()
            if isinstance(updated_note_doc.get('updated_at'), datetime):
                 updated_note_doc['updated_at'] = updated_note_doc['updated_at'].isoformat()

            return Note(**updated_note_doc)
        else:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")

    except ConnectionError:
         raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
    except Exception as e:
        logger.error(f"Error updating note {note_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

# Note: DELETE endpoint is not strictly required by Phase 3 description but is common.
# If needed, add:
# @router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
# async def delete_note(note_id: str):
#     """Deletes a note by its ID."""
#     if not ObjectId.is_valid(note_id):
#         raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid note ID format")
#     try:
#         # Need a delete_note function in db.mongodb
#         # result = await delete_note_from_db(note_id)
#         # if result.deleted_count == 0:
#         #     raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
#         pass # Placeholder
#     except ConnectionError:
#          raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
#     except Exception as e:
#         logger.error(f"Error deleting note {note_id}: {e}")
#         raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")
