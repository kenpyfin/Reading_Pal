import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings # Using pydantic-settings for cleaner env var loading

load_dotenv()

class Settings(BaseSettings):
    MONGO_URI: str = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
    DATABASE_NAME: str = os.getenv("DATABASE_NAME", "reading_pal")
    
    GOOGLE_CLIENT_ID: str = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET: str = os.getenv("GOOGLE_CLIENT_SECRET")
    # This is the backend callback URL that Google will redirect to.
    # Ensure it matches the one configured in your Google Cloud Console.
    GOOGLE_REDIRECT_URI: str = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8501/api/auth/google/callback") 
    
    # This will be used by Starlette's SessionMiddleware and JWT signing.
    # IMPORTANT: Change this in your .env file to a strong, unique secret!
    SECRET_KEY: str = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed_in_production") 
    
    # JWT settings
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7 # 7 days

    # Frontend URL for redirects after login/logout
    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3100")

    class Config:
        env_file = ".env"
        env_file_encoding = 'utf-8'
        extra = 'ignore' # Ignore extra fields from .env if any

settings = Settings()

# Validate essential OAuth settings are present
if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
    # This will stop the application if critical OAuth settings are missing.
    raise ValueError("CRITICAL: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the .env file.")

if settings.SECRET_KEY == "a_very_secret_key_that_should_be_changed_in_production":
    print("WARNING: SECRET_KEY is using its default insecure value. "
          "Please generate a strong, unique key and set it in your .env file for production environments.")
