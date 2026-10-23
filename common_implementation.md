# Common Implementation Playbook

This document outlines the implementation details for common, modular features used in this application. The goal is to provide a quick reference for understanding and replicating these functionalities in other projects.

## 1. Google OAuth2 with FastAPI and Authlib

This section details how to integrate "Log in with Google" functionality into a FastAPI backend. It covers the entire flow from initiating the login to creating a user session with a JWT.

### a. Key Dependencies

Ensure you have the following libraries installed:

```bash
pip install fastapi uvicorn python-dotenv authlib "python-jose[cryptography]" motor pydantic starlette
```

### b. Environment Variables

Configure the following variables in your `.env` file. You can obtain Google credentials from the [Google Cloud Console](https://console.cloud.google.com/).

```env
# Google OAuth Credentials
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
# This must match the authorized redirect URI in your Google Cloud Console project.
GOOGLE_REDIRECT_URI=http://localhost:8501/api/auth/auth/google/callback 
FRONTEND_URL=http://localhost:3100

# JWT and Session Configuration
# Generate a strong key with: openssl rand -hex 32
SECRET_KEY=a_strong_secret_key_for_signing_sessions_and_jwts
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=10080 # 7 days
```

### c. User Data Model (`backend/models/user.py`)

A Pydantic model is used to represent user data. This is crucial for creating or updating user records in the database upon successful login. A model like `UserCreate` is used to structure the data received from Google.

```python
# Simplified from backend/models/user.py
from pydantic import BaseModel, EmailStr, HttpUrl
from typing import Optional

class UserCreate(BaseModel):
    google_id: str # Google ID is mandatory
    email: EmailStr # Email is mandatory
    full_name: Optional[str] = None
    picture: Optional[HttpUrl] = None
```

### d. Database Interaction (`backend/db/mongodb.py`)

A database function is needed to persist user data. This function, called from the OAuth callback handler, finds a user by their Google ID or email and creates/updates their record.

```python
# Simplified logic from backend/db/mongodb.py
from backend.models.user import UserCreate
from datetime import datetime

async def create_or_update_user_from_google(user_data: UserCreate) -> Optional[str]:
    """
    Finds a user by Google ID or email and updates their info, or creates a new user.
    Returns the user's database ID (_id) as a string.
    """
    db = get_database() # Assumes a get_database() function
    user_collection = db.users
    now = datetime.utcnow()

    # 1. Find user by Google ID
    user_doc = await user_collection.find_one({"google_id": user_data.google_id})
    if user_doc:
        # User exists, update their details
        update_data = {
            "full_name": user_data.full_name,
            "picture": str(user_data.picture),
            "updated_at": now
        }
        await user_collection.update_one({"_id": user_doc["_id"]}, {"$set": update_data})
        return str(user_doc["_id"])
    
    # 2. If not found by Google ID, check by email to link account
    user_doc = await user_collection.find_one({"email": user_data.email})
    if user_doc:
        # User exists, link Google ID and update
        update_data = {"google_id": user_data.google_id, "updated_at": now}
        await user_collection.update_one({"_id": user_doc["_id"]}, {"$set": update_data})
        return str(user_doc["_id"])

    # 3. If no user found, create a new one
    new_user_doc = {
        "google_id": user_data.google_id,
        "email": user_data.email,
        "full_name": user_data.full_name,
        "picture": str(user_data.picture),
        "is_active": True,
        "created_at": now,
        "updated_at": now
    }
    result = await user_collection.insert_one(new_user_doc)
    return str(result.inserted_id)
```

### e. JWT Authentication Handler (`backend/auth/auth_handler.py`)

After a user logs in via Google, the application issues a JWT to manage their session. An `AuthHandler` class encapsulates token creation and decoding.

```python
# Simplified from backend/auth/auth_handler.py
import os
from datetime import datetime, timedelta, timezone
import jwt
from typing import Dict, Any, Optional

SECRET_KEY = os.getenv("SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES"))

class AuthHandler:
    def create_access_token(self, data: Dict[str, Any]) -> str:
        to_encode = data.copy()
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc)})
        encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=JWT_ALGORITHM)
        return encoded_jwt

    def decode_token(self, token: str) -> Optional[Dict[str, Any]]:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
            return payload
        except jwt.PyJWTError:
            return None

auth_handler_instance = AuthHandler()
```

### f. FastAPI Application Setup (`backend/main.py`)

The main application must be configured with `SessionMiddleware` for Authlib to store the OAuth state in the user's session.

```python
# From backend/main.py
from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware
import os

app = FastAPI()

# SessionMiddleware is required by Authlib for OAuth state management
SECRET_KEY = os.getenv("SECRET_KEY")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)
```

### g. FastAPI Routes (`backend/api/auth_routes.py`)

The core logic resides in two API endpoints that use the `Authlib` library.

```python
# Simplified from backend/api/auth_routes.py
import os
from fastapi import APIRouter, Request, HTTPException, status
from fastapi.responses import RedirectResponse
from authlib.integrations.starlette_client import OAuth, OAuthError
from backend.auth.auth_handler import auth_handler_instance
from backend.db.mongodb import create_or_update_user_from_google
from backend.models.user import UserCreate

router = APIRouter()

# 1. Configure Authlib OAuth client
oauth = OAuth()
oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

# 2. Login Route: Redirects user to Google's login page
@router.get('/login/google')
async def login_via_google(request: Request):
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI")
    return await oauth.google.authorize_redirect(request, redirect_uri)

# 3. Callback Route: Handles Google's response after user logs in
@router.get('/auth/google/callback')
async def auth_via_google(request: Request):
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"OAuth Error: {error.description}")

    user_info = token.get('userinfo')
    if not user_info:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not retrieve user info from Google")

    user_create_data = UserCreate(
        google_id=user_info.get('sub'),
        email=user_info.get('email'),
        full_name=user_info.get('name'),
        picture=user_info.get('picture')
    )

    user_id = await create_or_update_user_from_google(user_create_data)
    if not user_id:
        raise HTTPException(status_code=500, detail="Could not create or update user in database.")

    # Create a session JWT containing user's DB ID for the frontend
    app_token = auth_handler_instance.create_access_token(
        data={"sub": user_info.email, "user_id": user_id, "name": user_info.get("name")}
    )

    # Redirect user to the frontend with the token in a query parameter
    frontend_url = os.getenv("FRONTEND_URL")
    redirect_url = f"{frontend_url}/auth/callback?token={app_token}"
    return RedirectResponse(url=redirect_url)
```

---

## 2. MongoDB with FastAPI and Motor

This section describes a robust pattern for connecting a FastAPI application to MongoDB using the `motor` async driver, including connection management and Pydantic model integration.

### a. Key Dependencies

```bash
pip install motor pydantic python-dotenv
```

### b. Environment Variables

```env
# MongoDB Connection
MONGO_URI=mongodb://user:password@host:port/
DATABASE_NAME=my_app_database
```

### c. Connection Management (`backend/db/mongodb.py` and `main.py`)

A singleton pattern combined with FastAPI's lifespan events is used to manage the database connection, ensuring it's established once on startup and closed gracefully on shutdown.

**`backend/db/mongodb.py`:**
```python
# From backend/db/mongodb.py
import os
import logging
from motor.motor_asyncio import AsyncIOMotorClient

client: AsyncIOMotorClient = None
db = None

async def connect_to_mongo():
    global client, db
    MONGO_URI = os.getenv("MONGO_URI")
    DATABASE_NAME = os.getenv("DATABASE_NAME")
    client = AsyncIOMotorClient(MONGO_URI)
    db = client[DATABASE_NAME]
    logging.info("MongoDB connection successful.")

async def close_mongo_connection():
    global client
    if client:
        client.close()
        logging.info("MongoDB connection closed.")

def get_database():
    if db is None:
        raise ConnectionError("Database not initialized. Ensure connect_to_mongo is called on app startup.")
    return db
```

**`backend/main.py`:**
```python
# From backend/main.py
from fastapi import FastAPI
from backend.db.mongodb import connect_to_mongo, close_mongo_connection

app = FastAPI()

@app.on_event("startup")
async def startup_db_client():
    await connect_to_mongo()

@app.on_event("shutdown")
async def shutdown_db_client():
    await close_mongo_connection()
```

### d. Pydantic Models and ObjectID Handling

When working with MongoDB, handling the `_id` field of type `ObjectId` is a common challenge. Pydantic models should be configured to handle this conversion seamlessly for validation (string to `ObjectId`) and serialization (`ObjectId` to string).

```python
# Pattern from backend/models/book.py (for Pydantic v2)
from typing import Any, Optional, Annotated
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict
from bson import ObjectId

# Helper function to validate string as ObjectId
def validate_objectid(v: Any) -> ObjectId:
    if isinstance(v, ObjectId):
        return v
    if ObjectId.is_valid(v):
        return ObjectId(v)
    raise ValueError("Invalid ObjectId")

class Book(BaseModel):
    # Use Annotated and BeforeValidator to automatically convert incoming strings to ObjectId
    id: Annotated[ObjectId, BeforeValidator(validate_objectid)] = Field(alias="_id")
    title: str
    # ... other fields

    # Pydantic v2 model configuration
    model_config = ConfigDict(
        populate_by_name=True, # Allows using alias '_id' during model creation
        arbitrary_types_allowed=True, # Needed for ObjectId
        # Seralize ObjectId to str for JSON responses
        json_encoders={
            ObjectId: str 
        }
    )
```

### e. Asynchronous CRUD Operations (`backend/db/mongodb.py`)

All database operations should be `async` to leverage `motor`.

```python
# Examples from backend/db/mongodb.py
from typing import List, Dict, Any, Optional
from bson import ObjectId

async def get_book(book_id: str) -> Optional[Dict[str, Any]]:
    """Fetches a single book by its string ID."""
    db = get_database()
    try:
        obj_id = ObjectId(book_id)
        book = await db.books.find_one({"_id": obj_id})
        return book # Returns a dict or None
    except Exception:
        return None

async def get_books(filter: Optional[dict] = None) -> List[Dict[str, Any]]:
    """Retrieves a list of books."""
    db = get_database()
    books_cursor = db.books.find(filter or {})
    return await books_cursor.to_list(length=1000)

async def save_book(book_data: dict) -> str:
    """Saves a new book document."""
    db = get_database()
    result = await db.books.insert_one(book_data)
    return str(result.inserted_id) # Returns the string ID of the new document

async def update_book(book_id: str, update_data: dict) -> bool:
    """Updates an existing book document."""
    db = get_database()
    obj_id = ObjectId(book_id)
    result = await db.books.update_one(
        {"_id": obj_id},
        {"$set": update_data}
    )
    return result.matched_count > 0 # Returns True if a document was found

async def delete_book_record(book_id: str) -> bool:
    """Deletes a book record."""
    db = get_database()
    obj_id = ObjectId(book_id)
    result = await db.books.delete_one({"_id": obj_id})
    return result.deleted_count > 0 # Returns True if a document was deleted
```

---

## 3. Admin Authentication with JWT

This pattern shows how to create a separate, secure login for administrators using a username/password and protect specific API routes for admin-only access.

### a. Environment Variables

Define the admin credentials in your `.env` file. These should be kept secret.

```env
# Admin Credentials
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=a_very_strong_password
```

### b. Admin Login Endpoint

Create a dedicated endpoint for admin login. Upon successful authentication, it generates a JWT with a special claim (e.g., `"is_admin": True`) to identify the user as an administrator.

```python
# From backend/api/auth_routes.py
import os
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from backend.auth.auth_handler import auth_handler_instance

class AdminLoginRequest(BaseModel):
    username: str
    password: str

router = APIRouter()

@router.post("/admin/login", summary="Admin login with username and password")
async def admin_login(form_data: AdminLoginRequest):
    admin_username_env = os.getenv("ADMIN_USERNAME")
    admin_password_env = os.getenv("ADMIN_PASSWORD")

    if not admin_username_env or not admin_password_env:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Admin authentication is not configured on the server.",
        )

    if form_data.username == admin_username_env and form_data.password == admin_password_env:
        # Credentials are correct. Create an admin token with the 'is_admin' claim.
        token_data = {"sub": form_data.username, "is_admin": True}
        access_token = auth_handler_instance.create_access_token(data=token_data)
        return {"access_token": access_token, "token_type": "bearer"}
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect admin username or password",
        )
```

### c. Admin Authorization Dependency

Create a FastAPI dependency that verifies the JWT and checks for the `is_admin` claim. This dependency can be used to protect any route that requires admin privileges.

```python
# From backend/auth/auth_handler.py
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from typing import Dict, Any

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

async def get_current_admin_user(token: str = Depends(oauth2_scheme)) -> Dict[str, Any]:
    """
    Dependency to get the current user from the token and verify if they are an admin.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
    )
    unauthorized_admin_exception = HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="User is not authorized to perform this action (not an admin)",
    )

    payload = auth_handler_instance.decode_token(token)
    if payload is None:
        raise credentials_exception
    
    is_admin: bool = payload.get("is_admin", False)

    if not is_admin:
        raise unauthorized_admin_exception
    
    return payload # Return the payload for potential use in the route
```

### d. Protecting an Admin Route

To secure an endpoint, add the `get_current_admin_user` dependency to its signature. FastAPI will automatically enforce the admin check before executing the route's logic.

```python
# From backend/api/auth_routes.py
from fastapi import Depends
from typing import Dict, Any

@router.get("/admin/stats", summary="Get application statistics (Admin only)")
async def get_admin_stats(current_admin: Dict[str, Any] = Depends(get_current_admin_user)):
    """
    Retrieves overall application statistics.
    Access is restricted to users with a valid admin token.
    """
    # The code here will only run if get_current_admin_user succeeds.
    # ... logic to fetch stats ...
    return {"message": f"Welcome, admin user {current_admin.get('sub')}!"}
```

---

## 4. Serving Static Files in FastAPI

This pattern shows how to serve static files, such as images or documents, directly from the FastAPI backend. This is essential for content generated by services (like a PDF processor) that needs to be accessed by the frontend.

### a. Environment Variables

Define the **absolute path** to the directory on the server where your static files are stored. This path must be accessible from within the running container.

```env
# Path to the directory containing images
IMAGES_PATH=/path/on/server/to/storage/images
```

### b. Mounting the Static Directory in `main.py`

In your main application file, use FastAPI's `StaticFiles` and `app.mount` to make the directory's contents available at a specific URL path.

```python
# From backend/main.py
import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import logging

logger = logging.getLogger(__name__)
app = FastAPI()

# Mount the static files directory for images
images_path = os.getenv("IMAGES_PATH")
if images_path and os.path.exists(images_path):
    # This makes any file in the `images_path` directory (e.g., /path/to/images/my_image.png)
    # available at the URL `/images/my_image.png`.
    app.mount("/images", StaticFiles(directory=images_path), name="images")
    logger.info(f"Serving static images from {images_path} at /images")
else:
    logger.warning(f"IMAGES_PATH not set or directory not found: {images_path}. Static image serving disabled.")
```
This configuration allows a frontend to access an image located at `/path/on/server/to/storage/images/book_cover.jpg` via the URL `http://your-api-domain/images/book_cover.jpg`.

---

## 5. Running Background Tasks on Startup

This pattern demonstrates how to initiate a long-running, non-blocking background task when the FastAPI application starts. This is ideal for periodic jobs like database cleanup, polling external services, or performing regular maintenance.

### a. The Startup Event Handler

Use FastAPI's `@app.on_event("startup")` decorator in your `main.py` to trigger code when the server starts. Inside this function, use `asyncio.create_task` to launch your background task without blocking the main application.

```python
# From backend/main.py
import asyncio
import logging
from fastapi import FastAPI
# Assume my_background_tasks.py contains your async task function
from backend.services.cleanup_service import run_cleanup_task 

logger = logging.getLogger(__name__)
app = FastAPI()

@app.on_event("startup")
async def startup_event():
    logger.info("Application startup...")
    # This creates the task and lets it run in the background.
    asyncio.create_task(run_cleanup_task())
    logger.info("Background cleanup task started.")

@app.on_event("shutdown")
async def shutdown_event():
    # Background tasks are typically cancelled on shutdown.
    logger.info("Application shutdown.")
```

### b. The Task Function Pattern

The background task should be an `async` function containing an infinite loop. Inside the loop, perform the desired action and then use `await asyncio.sleep()` to pause execution. For synchronous I/O operations like file access, use `fastapi.concurrency.run_in_threadpool` to avoid blocking the asyncio event loop.

```python
# Advanced example of a background task from backend/services/cleanup_service.py
import asyncio
import os
import logging
from datetime import datetime, timedelta
from fastapi.concurrency import run_in_threadpool # To run sync file ops in a thread

# Assumes these DB functions exist to interact with the database
from backend.db.mongodb import get_database, update_book_by_system, delete_book_record 

logger = logging.getLogger(__name__)

# Load configuration from environment variables
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", 3600))
STUCK_JOB_THRESHOLD_SECONDS = int(os.getenv("STUCK_JOB_THRESHOLD_SECONDS", 24 * 3600))
CONTAINER_MARKDOWN_PATH = os.getenv("MARKDOWN_PATH")

async def delete_file_async(file_path: str):
    """Asynchronously deletes a file if it exists by running os functions in a threadpool."""
    try:
        if await run_in_threadpool(os.path.exists, file_path):
            await run_in_threadpool(os.remove, file_path)
            logger.info(f"Cleanup: Successfully deleted file: {file_path}")
    except Exception as e:
        logger.error(f"Cleanup: Error deleting file {file_path}: {e}", exc_info=True)

async def run_cleanup_task():
    """
    A long-running task that periodically cleans up database records and associated files.
    """
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        logger.info("Running cleanup cycle...")
        try:
            db = get_database()
            if db is None:
                logger.error("Cleanup task: Database not initialized.")
                continue

            # --- Logic to handle stuck jobs ---
            stuck_threshold = datetime.utcnow() - timedelta(seconds=STUCK_JOB_THRESHOLD_SECONDS)
            stuck_jobs_cursor = db.books.find({"status": "processing", "updated_at": {"$lt": stuck_threshold}})
            async for job in stuck_jobs_cursor:
                logger.warning(f"Marking stuck job {job['_id']} as failed.")
                await update_book_by_system(str(job['_id']), {"status": "failed", "processing_error": "Processing timed out."})

            # --- Logic to delete old failed records and their files ---
            # (Simplified query for documentation)
            old_records_cursor = db.books.find({"status": "failed"})
            async for record in old_records_cursor:
                book_id_str = str(record["_id"])
                md_filename = record.get("markdown_filename")

                # Asynchronously delete associated files
                if md_filename and CONTAINER_MARKDOWN_PATH:
                    file_path = os.path.join(CONTAINER_MARKDOWN_PATH, md_filename)
                    await delete_file_async(file_path)

                # Delete the database record (assumes delete_book_record handles userless deletion or you have a system version)
                await db.books.delete_one({"_id": record["_id"]})

        except asyncio.CancelledError:
            logger.info("Cleanup task cancelled.")
            break
        except Exception as e:
            logger.error(f"An error occurred during cleanup task: {e}", exc_info=True)
```
