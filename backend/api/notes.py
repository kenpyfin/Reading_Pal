import logging
from fastapi import APIRouter, HTTPException, status, Path # Added Path
from typing import List, Optional 
from bson import ObjectId 
from datetime import datetime 

# Change relative imports to absolute imports
from backend.db.mongodb import save_note, get_notes_by_book_id, update_note, get_note_by_id, delete_note_by_id # Added delete_note_by_id
from backend.models.note import Note, NoteCreate, NoteUpdate

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/", response_model=Note, status_code=status.HTTP_201_CREATED)
async def create_note(note: NoteCreate):
    """
    Creates a new note for a book.
    """
    # FastAPI/Pydantic automatically handles the NoteCreate model, including source_text if provided
    logger.info(f"Received request to create note for book ID: {note.book_id}")
    # Log the received note data for debugging, excluding potentially long content/source_text
    logger.debug(f"Note data received (excluding content/source_text): book_id={note.book_id}")
    if note.content:
        logger.debug(f"Note content length: {len(note.content)}")
    if note.source_text:
        logger.debug(f"Note source_text length: {len(note.source_text)}")

    try:
        # Validate book_id format (optional, depends on how strict you want to be)
        # if not ObjectId.is_valid(note.book_id):
        #     raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid book ID format")

        # Convert Pydantic model to dictionary, including the source_text field if present
        # by_alias=True ensures _id alias is handled correctly
        # exclude_unset=True can be used to not save fields that weren't provided, but source_text is Optional, so it will be None if not sent
        note_data = note.model_dump(by_alias=True) # Use model_dump for Pydantic v2, includes source_text
        # Add timestamps - handled by default_factory in model, but can set explicitly if needed
        # note_data["created_at"] = datetime.utcnow()
        # note_data["updated_at"] = datetime.utcnow()

        note_id = await save_note(note_data)

        # Fetch the saved note to return the full object with _id and timestamps
        saved_note_doc = await get_note_by_id(note_id) # Renamed to saved_note_doc
        if not saved_note_doc:
             # This case should ideally not happen if save was successful
             raise HTTPException(status_code=500, detail="Failed to retrieve saved note.")

        # The Note.model_validate method will parse the dictionary from the database.
        # Pydantic will use the alias "_id" from saved_note_doc to populate the "id" field of the Note model.
        # When FastAPI serializes this Note instance (due to response_model=Note),
        # it will use the Note model's json_encoders to convert the "id" field (which is an ObjectId)
        # into a string, and the JSON key will be "id".
        validated_note = Note.model_validate(saved_note_doc)
        logger.debug(f"Returning validated note: {validated_note.model_dump_json(indent=2)}")
        return validated_note

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
        notes_list_docs = await get_notes_by_book_id(book_id)

        # Convert list of dicts from DB to list of Note model instances
        # Pydantic will handle ObjectId to string conversion for 'id' field upon serialization by FastAPI
        validated_notes = [Note.model_validate(note_doc) for note_doc in notes_list_docs]
        
        # Log for debugging if needed
        # for v_note in validated_notes:
        #    logger.debug(f"Validated note for list: {v_note.model_dump_json(indent=2)}")

        return validated_notes

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
            # Convert the dictionary from DB to a Note model instance
            # FastAPI will handle serialization (ObjectId to string for 'id')
            validated_updated_note = Note.model_validate(updated_note_doc)
            logger.debug(f"Returning updated note: {validated_updated_note.model_dump_json(indent=2)}")
            return validated_updated_note
        else:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")

    except ConnectionError:
         raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
    except Exception as e:
        logger.error(f"Error updating note {note_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")

@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_note(note_id: str = Path(..., description="The ID of the note to delete")):
    """
    Deletes a specific note by its ID.
    """
    logger.info(f"Received request to delete note with id: {note_id}")
    if not ObjectId.is_valid(note_id):
        logger.warning(f"Attempted to delete note with invalid ID format: {note_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid note ID format.")

    try:
        deleted = await delete_note_by_id(note_id) # Use the new DB function
        if not deleted:
            logger.warning(f"Note with id {note_id} not found for deletion.")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Note with id {note_id} not found"
            )
        logger.info(f"Note with id {note_id} deleted successfully.")
        return None # For 204 No Content
    except ConnectionError:
         raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection not available.")
    except Exception as e:
        logger.error(f"Error deleting note {note_id}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {e}")
