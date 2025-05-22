import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
from backend.core.config import settings
# from passlib.context import CryptContext # Keep for potential future password hashing

# pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

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
            expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc)})
        encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
        return encoded_jwt

    def decode_token(self, token: str) -> Optional[Dict[str, Any]]:
        try:
            # Remove "Bearer " prefix if present
            if token.lower().startswith("bearer "):
                token = token[7:]
            
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
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
