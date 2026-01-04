import logging
import os
from typing import List, Optional

from fastapi import APIRouter, HTTPException, status, Body, Path
from fastapi.concurrency import run_in_threadpool
from backend.models.bookmark import Bookmark, BookmarkCreate, BookmarkUpdate # Import BookmarkUpdate
from backend.db import mongodb as db
from bson import ObjectId # Ensure ObjectId is imported

logger = logging.getLogger(__name__)
router = APIRouter()

# Get markdown path from environment
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH")

def calculate_line_number_from_offset(content: str, offset: int) -> int:
    """Calculate line number (1-indexed) from character offset in content."""
    if offset < 0 or offset > len(content):
        return 1
    # Count newlines up to the offset (1-indexed, so +1)
    return content[:offset].count('\n') + 1


def calculate_page_boundaries(markdown: str, target_chars_per_page: int = 25000) -> List[dict]:
    """Calculate page boundaries similar to frontend logic."""
    boundaries = []
    current_offset = 0
    total_length = len(markdown)
    min_page_chars = target_chars_per_page * 0.5

    while current_offset < total_length:
        page_start = current_offset
        potential_end = min(page_start + target_chars_per_page, total_length)
        actual_end = potential_end

        if potential_end < total_length:
            boundary_found = False
            # Search backwards from potential_end for a natural break (space)
            for i in range(potential_end, page_start, -1):
                if markdown[i-1].isspace():
                    actual_end = i
                    boundary_found = True
                    break
            
            if not boundary_found:
                # Try to find the next space after potential_end
                next_space_search_limit = min(potential_end + int(target_chars_per_page * 0.25), total_length)
                for i in range(potential_end, next_space_search_limit):
                    if markdown[i].isspace():
                        actual_end = i + 1
                        break

            if (actual_end - page_start) < min_page_chars and (total_length - page_start) > target_chars_per_page:
                actual_end = potential_end

        if actual_end <= page_start and page_start < total_length:
            actual_end = min(page_start + target_chars_per_page, total_length)

        actual_end = min(actual_end, total_length)
        boundaries.append({"start": page_start, "end": actual_end})
        current_offset = actual_end

        if len(boundaries) > 10000:
            break
            
    return boundaries


async def generate_default_bookmark_name(
    book_doc: dict, 
    page_number: Optional[int], 
    global_char_offset: Optional[int],
    scroll_percentage: Optional[float] = None
) -> str:
    """Generate a default bookmark name with page and line information.
    
    Navigation uses page_number and scroll_percentage, so bookmarks work even if
    line numbers can't be calculated. Line numbers are just for display.
    """
    page_str = f"Page {page_number}" if page_number else "Page ?"
    line_str = "?"
    
    markdown_filename = book_doc.get("markdown_filename")
    if not markdown_filename or not CONTAINER_MARKDOWN_PATH:
        return f"{page_str}, Line {line_str}"
    
    markdown_path = os.path.join(CONTAINER_MARKDOWN_PATH, markdown_filename)
    
    def read_markdown_file(path: str) -> Optional[str]:
        try:
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    return f.read()
        except Exception as e:
            logger.warning(f"Failed to read markdown file for line calculation: {e}")
        return None
    
    markdown_content = await run_in_threadpool(read_markdown_file, markdown_path)
    if not markdown_content:
        return f"{page_str}, Line {line_str}"
    
    # Method 1: Use global_character_offset if available (most accurate)
    if global_char_offset is not None and global_char_offset >= 0:
        if global_char_offset < len(markdown_content):
            line_number = calculate_line_number_from_offset(markdown_content, global_char_offset)
            line_str = str(line_number)
            return f"{page_str}, Line {line_str}"
    
    # Method 2: Estimate from scroll_percentage and page_number (fallback)
    if page_number and scroll_percentage is not None and 0 <= scroll_percentage <= 1:
        try:
            boundaries = calculate_page_boundaries(markdown_content)
            page_index = page_number - 1
            if 0 <= page_index < len(boundaries):
                page_start = boundaries[page_index]["start"]
                page_end = boundaries[page_index]["end"]
                page_length = page_end - page_start
                
                # Estimate character offset within page from scroll_percentage
                estimated_offset_in_page = int(scroll_percentage * page_length)
                estimated_global_offset = page_start + estimated_offset_in_page
                
                if estimated_global_offset < len(markdown_content):
                    line_number = calculate_line_number_from_offset(markdown_content, estimated_global_offset)
                    line_str = str(line_number)
        except Exception as e:
            logger.warning(f"Failed to estimate line number from scroll_percentage: {e}")
    
    return f"{page_str}, Line {line_str}"


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
    
    # Generate default name if name is not provided, is None, or is empty
    bookmark_name = bookmark_dict.get("name")
    if not bookmark_name or (isinstance(bookmark_name, str) and not bookmark_name.strip()):
        default_name = await generate_default_bookmark_name(
            book_doc,
            bookmark_dict.get("page_number"),
            bookmark_dict.get("global_character_offset"),
            bookmark_dict.get("scroll_percentage")
        )
        bookmark_dict["name"] = default_name
        logger.info(f"Generated default bookmark name: {default_name}")
    
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
