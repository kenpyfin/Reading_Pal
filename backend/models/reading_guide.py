from datetime import datetime
from typing import Optional, Any

from bson import ObjectId
from pydantic import BaseModel, Field

# Assuming PyObjectId is in user.py or a common place.
# If it's in a different location, adjust the import path.
# For this example, let's assume it might be in a common models utility
# or directly use a validation approach if PyObjectId is not easily accessible.
# For now, let's assume a common ObjectId validator or Pydantic's built-in capabilities.

class PyObjectId(ObjectId):
    @classmethod
    def __get_validators__(cls):
        yield cls.validate

    @classmethod
    def validate(cls, v: Any) -> ObjectId:
        if isinstance(v, ObjectId):
            return v
        if ObjectId.is_valid(v):
            return ObjectId(v)
        raise ValueError("Invalid ObjectId")

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        from pydantic_core import core_schema
        return core_schema.json_or_python_schema(
            json_schema=core_schema.str_schema(
                min_length=24,
                max_length=24,
                pattern="^[0-9a-fA-F]{24}$"
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

class ReadingGuidePageBase(BaseModel):
    book_id: PyObjectId = Field(alias="book_id")
    user_id: str = Field(...)
    page_number: int = Field(..., gt=0) # Page numbers are positive integers
    content: str = Field(...)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True # Pydantic V2 (was allow_population_by_field_name)
        json_encoders = {ObjectId: str, datetime: lambda dt: dt.isoformat()}
        arbitrary_types_allowed = True # Allow PyObjectId

class ReadingGuidePageCreate(ReadingGuidePageBase):
    pass

class ReadingGuidePageInDB(ReadingGuidePageBase):
    id: PyObjectId = Field(default_factory=PyObjectId, alias="_id")

    # Config class is inherited from ReadingGuidePageBase, 
    # but can be specified if overrides are needed.
    # For Pydantic V2, model_config can be used as a dictionary too.
    # class Config:
    #     populate_by_name = True
    #     json_encoders = {ObjectId: str, datetime: lambda dt: dt.isoformat()}
    #     arbitrary_types_allowed = True
