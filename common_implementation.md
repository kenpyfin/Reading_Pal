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
