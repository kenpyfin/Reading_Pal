import logging
import os # Add os import
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from authlib.integrations.starlette_client import OAuth # Will be needed for OAuth
from authlib.integrations.base_client import OAuthError # Import OAuthError
from starlette.responses import RedirectResponse, JSONResponse # Will be needed for OAuth & JSONResponse
from pydantic import BaseModel # Import BaseModel for request body
from typing import List, Dict, Any # Import List for response model

from backend.auth.auth_handler import auth_handler_instance, ACCESS_TOKEN_EXPIRE_MINUTES, get_current_admin_user # For JWT creation/validation and admin check
from backend.db.mongodb import (
    get_user_by_google_id, create_or_update_user_from_google,
    get_all_users, delete_user_by_google_id, update_user_active_status, # Added update_user_active_status
    get_total_books_count, get_total_notes_count,
    get_book_count_for_user, get_note_count_for_user, get_user_by_id # Import get_user_by_id
)
from backend.models.user import UserCreate, User # Pydantic models
# from backend.core.config import settings # If you re-introduce settings

logger = logging.getLogger(__name__)
router = APIRouter()

# Load the main application secret key for Authlib's own state signing.
# This MUST be the same key used by SessionMiddleware in main.py.
APP_SECRET_KEY = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed_in_production_main")
# The default value here matches the one in main.py's SessionMiddleware setup.

if APP_SECRET_KEY == "a_very_secret_key_that_should_be_changed_in_production_main":
    logger.warning("auth_routes.py: SECRET_KEY is using its default insecure value for Authlib OAuth config. "
                   "Ensure SECRET_KEY is set in your .env file for production.")

# Workaround for a bug in older Authlib versions where dict.get is called with a keyword argument for default.
class ConfigWrapper:
    def __init__(self, dictionary):
        self._dict = dictionary

    def get(self, key, default=None): # Matches the problematic call signature from Authlib
        # Internally, call the standard dict.get() correctly.
        return self._dict.get(key, default)

    def __getitem__(self, key):
        return self._dict[key]

    def __contains__(self, key):
        return key in self._dict

# Example placeholder for a login route - you'll need to implement this
# @router.post("/token", summary="Create access token for user login")
# async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends()):
#     # This is a very basic example. You'll need to:
#     # 1. Authenticate the user (e.g., check username/password against database)
#     # 2. If authentication is successful, create a JWT token
#     # user = await get_user_by_email(form_data.username) # Example
#     # if not user or not auth_handler_instance.verify_password(form_data.password, user["hashed_password"]):
#     #     raise HTTPException(
#     #         status_code=status.HTTP_401_UNAUTHORIZED,
#     #         detail="Incorrect username or password",
#     #         headers={"WWW-Authenticate": "Bearer"},
#     #     )
#     # access_token = auth_handler_instance.create_access_token(data={"sub": user["email"]})
#     # return {"access_token": access_token, "token_type": "bearer"}
#     logger.info(f"Login attempt for {form_data.username} - placeholder")
#     raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Login endpoint not implemented")

# --- Admin Login ---
class AdminLoginRequest(BaseModel):
    username: str
    password: str

@router.post("/admin/login", summary="Admin login with username and password")
async def admin_login(form_data: AdminLoginRequest):
    admin_username_env = os.getenv("ADMIN_USERNAME")
    admin_password_env = os.getenv("ADMIN_PASSWORD")

    if not admin_username_env or not admin_password_env:
        logger.error("Admin credentials (ADMIN_USERNAME, ADMIN_PASSWORD) not set in .env file.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Admin authentication is not configured on the server.",
        )

    if form_data.username == admin_username_env and form_data.password == admin_password_env:
        # Credentials are correct, create an admin token
        # The 'sub' can be the admin username or a generic admin identifier
        # Add an 'is_admin': True claim to distinguish this token
        token_data = {"sub": form_data.username, "is_admin": True}
        access_token = auth_handler_instance.create_access_token(data=token_data)
        logger.info(f"Admin user '{form_data.username}' logged in successfully.")
        return {"access_token": access_token, "token_type": "bearer"}
    else:
        logger.warning(f"Failed admin login attempt for username: {form_data.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect admin username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

# --- Google OAuth login ---
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI") # This should match the one in your Google Cloud Console

if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
    # Pass config to OAuth. Authlib can use SECRET_KEY from this config
    # for its own state signing if its internal logic dictates.
    # Wrap the config dictionary with ConfigWrapper to handle Authlib's incorrect dict.get() call.
    oauth_app_config_dict = {'SECRET_KEY': APP_SECRET_KEY}
    oauth_app_config_wrapper = ConfigWrapper(oauth_app_config_dict)
    oauth = OAuth(config=oauth_app_config_wrapper)
    oauth.register(
        name='google',
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
        client_kwargs={'scope': 'openid email profile'}
    )
else:
    logger.warning("Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) not found in .env. Google login will be disabled.")
    oauth = None


@router.get('/login/google', include_in_schema=False) # Actual Google login initiation
async def login_via_google(request: Request):
    if not oauth:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google OAuth not configured on server.")
    
    if not GOOGLE_REDIRECT_URI:
        logger.error("GOOGLE_REDIRECT_URI is not set in environment variables.")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Google OAuth redirect URI not configured.")
    
    redirect_uri = GOOGLE_REDIRECT_URI
    logger.info(f"Redirecting to Google for OAuth. Callback URI: {redirect_uri}")
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get('/auth/google/callback', include_in_schema=False) # Google callback, path adjusted to match observed request
async def auth_via_google(request: Request):
    if not oauth:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google OAuth not configured on server.")
    
    logger.info("Attempting to authorize Google access token...")
    # Log session keys to help debug state persistence issues
    if hasattr(request, 'session') and request.session:
        logger.debug(f"Session keys before authorize_access_token: {list(request.session.keys())}")
    else:
        logger.debug("No session or session is empty before authorize_access_token.")
        
    try:
        # Explicitly pass the redirect_uri to ensure it matches the initial request
        if not GOOGLE_REDIRECT_URI:
            logger.error("GOOGLE_REDIRECT_URI is not set. Cannot authorize access token.")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Google OAuth redirect URI not configured for token exchange.")
        
        # Remove explicit redirect_uri; Authlib should handle it based on the request/session.
        token = await oauth.google.authorize_access_token(request)
        logger.info("Successfully authorized Google access token.")
    except OAuthError as error:
        # Log the detailed error from authlib for better debugging
        logger.error(f"OAuthError during Google token authorization: {error.error} - Description: {error.description}", exc_info=True)
        # error.description often contains "mismatching_state: CSRF Warning! State not equal in request and response."
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Could not authorize Google token: {error.description}")
    except Exception as e: # Catch other unexpected errors
        logger.error(f"Unexpected error obtaining Google access token: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="An unexpected error occurred during Google authentication.")
    
    user_info = token.get('userinfo')
    if not user_info:
        logger.error("Could not retrieve user info from Google token.")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not retrieve user info from Google")

    logger.info(f"Google user info received: {user_info.get('email')}")

    # Prepare user data from Google profile
    user_data_from_google = UserCreate(
        email=user_info.email,
        full_name=user_info.get("name"),
        google_id=user_info.get("sub"),
        picture=user_info.get("picture") if user_info.get("picture") else None,
    )
    
    logger.info(f"Processing Google login for {user_info.email}. Attempting to create or update user with data: {user_data_from_google.model_dump_json(indent=2)}")
    
    # create_or_update_user_from_google will find by google_id, or by email (and link google_id),
    # or create a new user. It also updates details if the user is found.
    # This function returns the MongoDB _id string of the user.
    db_user_id_str = await create_or_update_user_from_google(user_data_from_google)
    
    if not db_user_id_str:
        logger.error(f"Failed to create or update user in database. DB function returned no user_id. Data attempted: {user_data_from_google.model_dump_json(indent=2)}")
        raise HTTPException(status_code=500, detail="Could not create or update user.")
    
    # After user is created/updated, fetch their full document to check is_active status
    user_document = await get_user_by_id(db_user_id_str) # Fetch by MongoDB _id string
    if not user_document:
        logger.error(f"Failed to retrieve user document for ID {db_user_id_str} after create/update.")
        raise HTTPException(status_code=500, detail="User processed but could not be retrieved for status check.")

    # The 'is_active' field should exist due to UserCreate model and DB logic. Default to True if somehow missing.
    if not user_document.get("is_active", True): 
        logger.warning(f"Login attempt by inactive user: {user_info.email} (Google ID: {user_info.get('sub')}).")
        frontend_url_for_error = os.getenv("FRONTEND_URL", "http://localhost:3100")
        # Redirect to login page with an error query parameter
        error_redirect_url = f"{frontend_url_for_error}/login?error=inactive_user"
        return RedirectResponse(url=error_redirect_url)
        
    logger.info(f"User {user_info.email} (DB ID: {db_user_id_str}) is active. Proceeding to login.")

    # Create application token
    # Ensure the user_id in the token is the MongoDB _id string
    app_token_data = {"sub": user_info.email, "user_id": db_user_id_str, "name": user_info.get("name")}
    app_token = auth_handler_instance.create_access_token(data=app_token_data)
    
    # Redirect to frontend with the token
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3100") 
    redirect_url_on_success = f"{frontend_url}/auth/callback?token={app_token}" 
    
    logger.info(f"Redirecting to frontend: {redirect_url_on_success}")
    response = RedirectResponse(url=redirect_url_on_success)
    
    # To use HttpOnly cookies instead of query parameter (more secure):
    # response.set_cookie(
    #     key="auth_token",
    #     value=app_token,
    #     httponly=True,
    #     max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    #     samesite="Lax", # Or "Strict"
    #     secure=request.url.scheme == "https", # True if served over HTTPS
    #     path="/"
    # )
    return response


# --- Admin User Management Endpoints ---

class UserStatusUpdatePayload(BaseModel):
    is_active: bool

class AdminStats(BaseModel):
    total_users: int
    total_books: int
    total_notes: int

@router.get("/admin/stats", response_model=AdminStats, summary="Get application statistics (Admin only)")
async def get_admin_stats(current_admin: Dict[str, Any] = Depends(get_current_admin_user)):
    """
    Retrieves overall statistics like total users, books, and notes.
    Requires admin privileges.
    """
    logger.info(f"Admin user '{current_admin.get('sub')}' requesting application stats.")
    
    # Fetching all users to get the count.
    # If performance becomes an issue for many users, add a dedicated count function for users.
    users_data = await get_all_users() 
    total_users = len(users_data)
    
    total_books = await get_total_books_count()
    total_notes = await get_total_notes_count()
    
    return AdminStats(
        total_users=total_users,
        total_books=total_books,
        total_notes=total_notes
    )

@router.get("/admin/users", response_model=List[User], summary="List all users (Admin only)")
async def list_users_admin(current_admin: Dict[str, Any] = Depends(get_current_admin_user)):
    """
    Retrieves a list of all users. Requires admin privileges.
    """
    logger.info(f"Admin user '{current_admin.get('sub')}' requesting to list all users.")
    users_db_data = await get_all_users()
    
    users_with_counts = []
    for user_doc in users_db_data:
        user_id_str = str(user_doc["_id"]) # User's MongoDB ObjectId as string
        
        book_count = await get_book_count_for_user(user_id_str)
        note_count = await get_note_count_for_user(user_id_str)
        
        # Add counts to the user document before validation
        user_doc_with_counts = {**user_doc, "book_count": book_count, "note_count": note_count}
        users_with_counts.append(User.model_validate(user_doc_with_counts))
        
    return users_with_counts


@router.put("/admin/users/{google_id}/status", response_model=User, summary="Update user active status (Admin only)")
async def update_user_status_admin(google_id: str, payload: UserStatusUpdatePayload, current_admin: Dict[str, Any] = Depends(get_current_admin_user)):
    """
    Updates the 'is_active' status of a user by their Google ID.
    Requires admin privileges.
    """
    logger.info(f"Admin user '{current_admin.get('sub')}' attempting to set active status for user with Google ID {google_id} to {payload.is_active}.")

    # Optional: Prevent admin from deactivating their own account if it's a Google-linked admin
    # This check assumes the admin's JWT 'sub' or a 'user_id' claim matches the user_id in the DB.
    # If admin logs in with username/password and isn't a regular user, this check might not apply directly.
    # For now, we'll assume admin might be a regular user with an admin flag.
    # A more robust check would be to ensure the admin user from .env isn't deleted if it has a DB entry.
    admin_google_id_claim = current_admin.get("user_id") # Assuming user_id claim in admin token holds their google_id if admin is a google user
    if admin_google_id_claim == google_id and not payload.is_active:
         logger.warning(f"Admin user '{current_admin.get('sub')}' attempted to deactivate their own Google-linked account.")
         raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Admin cannot deactivate their own account.")

    updated_successfully = await update_user_active_status(google_id, payload.is_active)
    if not updated_successfully:
        # This could mean user not found or DB error
        logger.warning(f"Failed to update active status for user with Google ID {google_id}.")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User with Google ID {google_id} not found or status could not be updated.")

    # Fetch the updated user to return, including their new status and counts
    updated_user_doc = await get_user_by_google_id(google_id)
    if not updated_user_doc:
        logger.error(f"Failed to retrieve user {google_id} after status update, though update reported success.")
        # This case should be rare if update_user_active_status returned True and matched_count was > 0
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="User status updated, but failed to retrieve updated user details.")

    user_id_str = str(updated_user_doc["_id"])
    book_count = await get_book_count_for_user(user_id_str)
    note_count = await get_note_count_for_user(user_id_str)
    
    user_doc_with_counts = {**updated_user_doc, "book_count": book_count, "note_count": note_count}
    
    logger.info(f"Active status for user with Google ID {google_id} updated to {payload.is_active} by admin '{current_admin.get('sub')}'.")
    return User.model_validate(user_doc_with_counts)


@router.delete("/admin/users/{google_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a user by Google ID (Admin only)")
async def delete_user_admin(google_id: str, current_admin: Dict[str, Any] = Depends(get_current_admin_user)):
    """
    Deletes a user by their Google ID. Requires admin privileges.
    """
    logger.info(f"Admin user '{current_admin.get('sub')}' attempting to delete user with Google ID: {google_id}.")
    
    # Optional: Add a check to prevent the admin from deleting a user account
    # associated with their own admin login if the admin user is also a regular Google user.
    # This would require comparing `google_id` with a claim in `current_admin` if it exists.
    # For example, if admin's own google_id is stored in their JWT:
    # if current_admin.get("google_id_claim") == google_id:
    #     logger.warning(f"Admin user '{current_admin.get('sub')}' attempted to delete their own Google-linked account.")
    #     raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Admin cannot delete their own Google-linked account via this endpoint.")

    deleted = await delete_user_by_google_id(google_id)
    if not deleted:
        logger.warning(f"Failed to delete user with Google ID {google_id}. User not found or delete operation failed.")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User with Google ID {google_id} not found or could not be deleted.")
    
    logger.info(f"User with Google ID {google_id} deleted successfully by admin '{current_admin.get('sub')}'.")
    return None # Returns 204 No Content on success

# Add more authentication routes here (e.g., register, logout, password reset)
