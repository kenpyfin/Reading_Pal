from pydantic import BaseModel, EmailStr, Field, HttpUrl
from typing import Optional, Any
from bson import ObjectId
from datetime import datetime

# Helper class for MongoDB ObjectId interaction with Pydantic
class PyObjectId(ObjectId):
    @classmethod
    def __get_validators__(cls):
        yield cls.validate

    @classmethod
    def validate(cls, v: Any) -> ObjectId:
        if isinstance(v, ObjectId): # If it's already an ObjectId, return it
            return v
        if ObjectId.is_valid(v): # If it's a valid string representation of ObjectId, convert and return
            return ObjectId(v)
        raise ValueError("Invalid ObjectId") # Otherwise, raise an error

    # For Pydantic V2, the method to customize core schema generation is __get_pydantic_core_schema__
    # This ensures that when Pydantic generates its internal CoreSchema or the external JSON schema,
    # it knows that PyObjectId should be treated as a string.
    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        # handler is of type pydantic.GetCoreSchemaHandler
        # The return type is pydantic_core.core_schema.CoreSchema
        from pydantic_core import core_schema

        return core_schema.json_or_python_schema(
            json_schema=core_schema.str_schema(
                min_length=24,  # ObjectId string length
                max_length=24,
                pattern="^[0-9a-fA-F]{24}$" # ObjectId hex string pattern
            ),
            python_schema=core_schema.union_schema([
                core_schema.is_instance_schema(ObjectId),
                core_schema.chain_schema([
                    core_schema.str_schema(),
                    core_schema.no_info_plain_validator_function(cls.validate),
                ])
            ]),
            serialization=core_schema.plain_serializer_function_ser_schema(lambda x: str(x)),
        )


# Base model for common User attributes
class UserBase(BaseModel):
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    picture: Optional[HttpUrl] = None # URL for the user's profile picture
    is_active: Optional[bool] = True
    is_superuser: Optional[bool] = False
    google_id: Optional[str] = None 

# Properties to receive when creating a user, especially via Google OAuth
class UserCreate(BaseModel):
    google_id: str # Google ID is mandatory for linking/identification
    email: EmailStr # Email is mandatory
    full_name: Optional[str] = None
    picture: Optional[HttpUrl] = None
    # is_active and is_superuser will be set to defaults by the DB logic if not provided

# Properties allowed for updating a user
class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    picture: Optional[HttpUrl] = None
    is_active: Optional[bool] = None
    # email and google_id are typically not updatable or updated via different process

# Base model for user properties stored in and retrieved from DB
class UserInDBBase(UserBase):
    id: PyObjectId = Field(default_factory=PyObjectId, alias="_id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True # For Pydantic V2 (was allow_population_by_field_name in V1)
        json_encoders = {
            ObjectId: str, # Ensures ObjectId is serialized to string
            datetime: lambda dt: dt.isoformat() # Standard ISO format for datetime
        }

# Model for returning user data from API (what the client sees)
class User(UserInDBBase):
    pass

# Model representing a user document as stored in MongoDB (can include sensitive fields)
class UserInDB(UserInDBBase):
    pass
