import os
from dotenv import load_dotenv
import logging
# TODO: Import client libraries for different LLM providers (Anthropic, DeepSeek, Gemini, Ollama)
import ollama # Import ollama client

load_dotenv()
logger = logging.getLogger(__name__)

LLM_SERVICE = os.getenv("LLM_SERVICE", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:14b") # Default model for Ollama
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Initialize LLM clients based on configuration
anthropic_client = None
deepseek_client = None # Placeholder
gemini_client = None # Placeholder
ollama_client = None

if LLM_SERVICE == "anthropic" and ANTHROPIC_API_KEY:
    try:
        from anthropic import Anthropic
        anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
        logger.info("Anthropic client initialized.")
    except Exception as e:
        logger.error(f"Failed to initialize Anthropic client: {e}")
elif LLM_SERVICE == "deepseek" and DEEPSEEK_API_KEY:
    # Assuming a requests-based or similar client for DeepSeek
    logger.warning("DeepSeek client implementation is a placeholder.")
    pass # TODO: Implement DeepSeek client
elif LLM_SERVICE == "gemini" and GEMINI_API_KEY:
    # Assuming a google-generativeai client
    logger.warning("Gemini client implementation is a placeholder.")
    pass # TODO: Implement Gemini client
elif LLM_SERVICE == "ollama" and OLLAMA_BASE_URL:
    try:
        # Ollama client is synchronous, initialize it directly
        ollama_client = ollama.Client(host=OLLAMA_BASE_URL)
        # Optional: Check if the model exists
        try:
            ollama_client.show(LLM_MODEL)
            logger.info(f"Ollama client initialized with model: {LLM_MODEL}")
        except ollama.ResponseError as e:
             logger.error(f"Ollama model '{LLM_MODEL}' not found or accessible at {OLLAMA_BASE_URL}: {e}")
             ollama_client = None # Disable client if model is missing
        except Exception as e:
             logger.error(f"Error checking Ollama model '{LLM_MODEL}' at {OLLAMA_BASE_URL}: {e}")
             ollama_client = None # Disable client on other errors
    except Exception as e:
        logger.error(f"Failed to initialize Ollama client at {OLLAMA_BASE_URL}: {e}")
        ollama_client = None
else:
    logger.warning(f"LLM_SERVICE '{LLM_SERVICE}' configured but API key/URL is missing or invalid, or client not implemented. LLM features may not work.")

# Create a simple service object to hold the clients and methods
class LLMService:
    def __init__(self, anthropic=None, deepseek=None, gemini=None, ollama=None):
        self.anthropic_client = anthropic
        self.deepseek_client = deepseek
        self.gemini_client = gemini
        self.ollama_client = ollama

    def process_text(self, task: str, text: str, context: Optional[str] = None) -> str:
        """
        Processes text using the configured LLM based on the task.
        Note: This method is synchronous because the Ollama client is synchronous.
        It should be called within a threadpool if used in an async context (like FastAPI).
        """
        if LLM_SERVICE == "ollama" and self.ollama_client:
            try:
                if task == "ask":
                    prompt = f"Context:\n{context}\n\nQuestion: {text}\n\nAnswer the question based ONLY on the provided context."
                    logger.info(f"Ollama 'ask' prompt: {prompt[:200]}...")
                    response = self.ollama_client.generate(
                        model=LLM_MODEL,
                        prompt=prompt,
                        stream=False # We want the full response
                    )
                    return response.get('response', 'No response from Ollama.')
                elif task == "summarize":
                    prompt = f"Please provide a concise summary of the following text:\n\n{text}"
                    logger.info(f"Ollama 'summarize' prompt: {prompt[:200]}...")
                    response = self.ollama_client.generate(
                        model=LLM_MODEL,
                        prompt=prompt,
                        stream=False
                    )
                    return response.get('response', 'No response from Ollama.')
                else:
                    return f"Unknown LLM task: {task}"
            except ollama.ResponseError as e:
                 logger.error(f"Ollama Response Error for task '{task}': {e}")
                 return f"Error from LLM ({LLM_SERVICE}/{LLM_MODEL}): {e}"
            except Exception as e:
                logger.error(f"Error calling Ollama LLM for task '{task}': {e}")
                return f"Error generating response from LLM ({LLM_SERVICE}/{LLM_MODEL}): {e}"

        elif LLM_SERVICE == "anthropic" and self.anthropic_client:
             # Anthropic client is async, this method should ideally be async
             # For now, keeping it synchronous to match the Ollama implementation pattern,
             # but this will require careful handling (e.g., using run_in_threadpool)
             # or refactoring this class to be async.
             # TODO: Refactor LLMService to handle async clients properly.
             logger.warning("Anthropic client is async but being called from a sync method. This needs refactoring.")
             try:
                 if task == "ask":
                     prompt = f"Context:\n{context}\n\nQuestion: {text}\n\nAnswer the question based ONLY on the provided context."
                     message = self.anthropic_client.messages.create( # This will block
                         model=LLM_MODEL, # Use the configured model
                         max_tokens=4096, # Adjust as needed
                         system="You are a helpful assistant that answers questions based on provided text.",
                         messages=[
                             {"role": "user", "content": prompt}
                         ]
                     )
                     return message.content[0].text if message.content else "No response from LLM."
                 elif task == "summarize":
                     prompt = f"Please provide a concise summary of the following text:\n\n{text}"
                     message = self.anthropic_client.messages.create( # This will block
                         model=LLM_MODEL, # Use the configured model
                         max_tokens=4096, # Adjust as needed
                         system="You are a helpful assistant that summarizes text.",
                         messages=[
                             {"role": "user", "content": prompt}
                         ]
                     )
                     return message.content[0].text if message.content else "No response from LLM."
                 else:
                     return f"Unknown LLM task: {task}"
             except Exception as e:
                 logger.error(f"Error calling Anthropic LLM for task '{task}': {e}")
                 return f"Error generating response from LLM ({LLM_SERVICE}/{LLM_MODEL}): {e}"

        # TODO: Implement calls for DeepSeek, Gemini

        else:
            return f"LLM service '{LLM_SERVICE}' not configured, initialized, or implemented correctly."


# Instantiate the service
llm_service = LLMService(
    anthropic=anthropic_client,
    ollama=ollama_client
    # Pass other clients here when implemented
)

# The async functions below are now wrappers around the synchronous process_text
# using run_in_threadpool where necessary.

async def ask_question(prompt: str, context: str) -> str:
    """
    Sends a question to the configured LLM with provided context.
    Uses run_in_threadpool if the underlying client is synchronous.
    """
    logger.info(f"Calling LLM service 'ask' with prompt: {prompt[:100]}...")
    # The process_text method is synchronous, so always run it in a threadpool
    from fastapi.concurrency import run_in_threadpool # Import here to avoid circular dependency if llm.py imports this
    return await run_in_threadpool(llm_service.process_text, "ask", prompt, context)


async def summarize_text(text: str) -> str:
    """
    Sends text to the configured LLM for summarization.
    Uses run_in_threadpool if the underlying client is synchronous.
    """
    logger.info(f"Calling LLM service 'summarize' with text: {text[:100]}...")
    # The process_text method is synchronous, so always run it in a threadpool
    from fastapi.concurrency import run_in_threadpool # Import here
    return await run_in_threadpool(llm_service.process_text, "summarize", text, None)

# TODO: Add other LLM interaction functions as needed (e.g., extract_keywords)
