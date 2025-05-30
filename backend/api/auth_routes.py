import logging
import os # Add os import
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from authlib.integrations.starlette_client import OAuth # Will be needed for OAuth
from authlib.integrations.base_client import OAuthError # Import OAuthError
from starlette.responses import RedirectResponse # Will be needed for OAuth

from backend.auth.auth_handler import auth_handler_instance, ACCESS_TOKEN_EXPIRE_MINUTES # For JWT creation/validation
from backend.db.mongodb import get_user_by_google_id, create_or_update_user_from_google # Example db functions
from backend.models.user import UserCreate, User # Example models
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


# Google OAuth login
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


@router.get('/auth/google/callback', include_in_schema=False) # Google callback
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
    
    db_user = await get_user_by_google_id(user_info.get("sub"))
    if not db_user:
        logger.info(f"User with google_id {user_info.get('sub')} not found. Creating new user.")
        new_user_data = UserCreate( 
            email=user_info.email,
            full_name=user_info.get("name"),
            google_id=user_info.get("sub"),
            picture=user_info.get("picture") if user_info.get("picture") else None, # Correctly pass picture
        )
        logger.info(f"Attempting to create user with data: {new_user_data.model_dump_json(indent=2)}")
        user_id = await create_or_update_user_from_google(new_user_data) 
        if not user_id:
            logger.error(f"Failed to create user in database. DB function returned no user_id. Data attempted: {new_user_data.model_dump_json(indent=2)}")
            raise HTTPException(status_code=500, detail="Could not create or update user.")
        logger.info(f"New user created with ID: {user_id}")
    else:
        user_id = str(db_user.get("id") or db_user.get("_id")) 
        # Note: The update path for existing users is handled within create_or_update_user_from_google itself.
        logger.info(f"User found with ID: {user_id}")
        # Optionally, update user details here if they've changed (e.g., picture, full_name)
        # This is already handled by create_or_update_user_from_google if it finds an existing user.

    app_token_data = {"sub": user_info.email, "user_id": str(user_id), "name": user_info.get("name")}
    app_token = auth_handler_instance.create_access_token(data=app_token_data)
    
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

# Add more authentication routes here (e.g., register, logout, password reset)
