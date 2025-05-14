import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, status, Body, Path
from backend.models.bookmark import Bookmark, BookmarkCreate, BookmarkUpdate # Import BookmarkUpdate
from backend.db import mongodb as db
from bson import ObjectId # Ensure ObjectId is imported

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/", response_model=Bookmark, status_code=status.HTTP_201_CREATED)
async def add_bookmark(bookmark_create_payload: BookmarkCreate = Body(...)):
    """
    Adds a new bookmark for a book.
    """
    logger.info(f"Received request to add bookmark for book_id: {bookmark_create_payload.book_id}")

    # Validate that the associated book exists
    # Assuming book_id in BookmarkCreate is the string representation of Book's ObjectId
    if not ObjectId.is_valid(bookmark_create_payload.book_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid book_id format: {bookmark_create_payload.book_id}"
        )

    book_doc = await db.get_book(bookmark_create_payload.book_id)
    if not book_doc:
        logger.warning(f"Book with id {bookmark_create_payload.book_id} not found. Cannot create bookmark.")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Book with id {bookmark_create_payload.book_id} not found"
        )

    bookmark_dict = bookmark_create_payload.model_dump(exclude_unset=True)
    
    created_bookmark_doc = await db.create_bookmark(bookmark_dict)
    if not created_bookmark_doc:
        logger.error(f"Failed to create bookmark in DB for book_id: {bookmark_create_payload.book_id}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create bookmark"
        )
    
    return Bookmark(**created_bookmark_doc)


@router.get("/book/{book_id}", response_model=List[Bookmark])
async def list_bookmarks_for_book(book_id: str = Path(..., description="The ID of the book (string ObjectId)")):
    """
    Lists all bookmarks associated with a specific book.
    """
    logger.info(f"Received request to list bookmarks for book_id: {book_id}")
    
    if not ObjectId.is_valid(book_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid book_id format: {book_id}")

    bookmarks_docs = await db.get_bookmarks_by_book_id(book_id)
    return [Bookmark(**doc) for doc in bookmarks_docs]


@router.delete("/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_bookmark(bookmark_id: str = Path(..., description="The ID of the bookmark to delete")):
    """
    Deletes a specific bookmark by its ID.
    """
    logger.info(f"Received request to delete bookmark with id: {bookmark_id}")
    if not ObjectId.is_valid(bookmark_id):
        logger.warning(f"Attempted to delete bookmark with invalid ID format: {bookmark_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid bookmark ID format.")

    deleted = await db.delete_bookmark_by_id(bookmark_id)
    if not deleted:
        logger.warning(f"Bookmark with id {bookmark_id} not found for deletion.")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Bookmark with id {bookmark_id} not found"
        )
    logger.info(f"Bookmark with id {bookmark_id} deleted successfully.")
    # For 204, FastAPI expects no return value or `return None`
    return None


@router.put("/{bookmark_id}/name", response_model=Bookmark)
async def update_bookmark_display_name(
    bookmark_id: str = Path(..., description="The ID of the bookmark to update"),
    name_payload: BookmarkUpdate = Body(...) # Use BookmarkUpdate model
):
    """
    Updates the name of a bookmark.
    """
    logger.info(f"Received request to update name for bookmark id: {bookmark_id} to '{name_payload.name}'")

    if not ObjectId.is_valid(bookmark_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid bookmark ID format.")

    if name_payload.name is None: # Check if name is provided in the payload
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New name must be provided in 'name' field.")

    updated_bookmark_doc = await db.update_bookmark_name(bookmark_id, name_payload.name)
    if not updated_bookmark_doc:
        logger.warning(f"Bookmark with id {bookmark_id} not found for name update, or update failed.")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, # Or 400 if update failed due to other reasons
            detail=f"Bookmark with id {bookmark_id} not found or update failed"
        )
    
    logger.info(f"Bookmark name for id {bookmark_id} updated successfully.")
    return Bookmark(**updated_bookmark_doc)
