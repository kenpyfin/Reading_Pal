import jwt
import os # Add os import
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
# from backend.core.config import settings # Remove config import
# from passlib.context import CryptContext # Keep for potential future password hashing

# pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Define constants previously in settings or provide defaults
SECRET_KEY = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed_in_production")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 60 * 24 * 7)) # 7 days

if SECRET_KEY == "a_very_secret_key_that_should_be_changed_in_production":
    print("WARNING: auth_handler.py: SECRET_KEY is using its default insecure value. "
          "Please generate a strong, unique key and set it in your .env file for production environments.")


class AuthHandler:
    # def verify_password(self, plain_password: str, hashed_password: str) -> bool:
    #     return pwd_context.verify(plain_password, hashed_password)

    # def get_password_hash(self, password: str) -> str:
    #     return pwd_context.hash(password)

    def create_access_token(self, data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
        to_encode = data.copy()
        if expires_delta:
            expire = datetime.now(timezone.utc) + expires_delta
        else:
            expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc)})
        encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=JWT_ALGORITHM)
        return encoded_jwt

    def decode_token(self, token: str) -> Optional[Dict[str, Any]]:
        try:
            # Remove "Bearer " prefix if present
            if token.lower().startswith("bearer "):
                token = token[7:]
            
            payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
            return payload
        except jwt.ExpiredSignatureError:
            # Log this or handle as needed
            print("Token has expired")
            return None
        except jwt.InvalidTokenError as e:
            # Log this or handle as needed
            print(f"Invalid token: {e}")
            return None

auth_handler_instance = AuthHandler()
