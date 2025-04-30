import os
from dotenv import load_dotenv
import logging
from typing import Optional
# Import client libraries for different LLM providers
from anthropic import Anthropic # Assuming Anthropic is used
from ollama import AsyncClient # Use AsyncClient for better FastAPI integration
# Assuming google-generativeai is used for Gemini
import google.generativeai as genai
# Assuming requests is used for DeepSeek (adjust if a specific client library is available)
import requests
import json # Import json for DeepSeek requests

load_dotenv()
logger = logging.getLogger(__name__)

LLM_SERVICE = os.getenv("LLM_SERVICE", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-coder:v2") # Default model, adjust as needed
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Initialize LLM clients based on configuration
# Keep these outside the class for singleton pattern
anthropic_client = None
deepseek_config = None # For requests, this might just be the API key/URL
gemini_model = None # Store the GenerativeModel instance
ollama_client = None

if LLM_SERVICE == "anthropic":
    if ANTHROPIC_API_KEY:
        try:
            anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
            logger.info("Anthropic client initialized.")
        except Exception as e:
            logger.error(f"Failed to initialize Anthropic client: {e}")
            # Set client to None explicitly on failure
            anthropic_client = None
    else:
        logger.warning("ANTHROPIC_API_KEY not set. Anthropic LLM service disabled.")

elif LLM_SERVICE == "deepseek":
    if DEEPSEEK_API_KEY:
        # For requests-based client, we just need the API key and potentially the base URL
        # Assuming DeepSeek uses an OpenAI-compatible endpoint
        deepseek_config = {"api_key": DEEPSEEK_API_KEY, "base_url": "https://api.deepseek.com/chat/completions"}
        logger.info("DeepSeek client configured (using requests).")
    else:
        logger.warning("DEEPSEEK_API_KEY not set. DeepSeek LLM service disabled.")

elif LLM_SERVICE == "gemini":
    if GEMINI_API_KEY:
        try:
            genai.configure(api_key=GEMINI_API_KEY)
            # Initialize the model, not the client itself
            # Check if the model exists (synchronous check during init)
            try:
                # Use the configured model name
                gemini_model = genai.GenerativeModel(model_name=LLM_MODEL)
                # A simple test call might be needed to confirm connectivity/model existence
                # For now, rely on error handling during actual calls.
                logger.info(f"Gemini client initialized with model: {LLM_MODEL}.")
            except Exception as e:
                 logger.error(f"Failed to initialize Gemini model '{LLM_MODEL}': {e}")
                 gemini_model = None
        except Exception as e:
            logger.error(f"Failed to configure Gemini client: {e}")
            gemini_model = None
    else:
        logger.warning("GEMINI_API_KEY not set. Gemini LLM service disabled.")

elif LLM_SERVICE == "ollama":
     if OLLAMA_BASE_URL:
         try:
             # Use the async client
             ollama_client = AsyncClient(host=OLLAMA_BASE_URL)
             # Async check for model existence is better done during the actual call
             logger.info(f"Ollama AsyncClient initialized for {OLLAMA_BASE_URL}. Model check pending.")

         except Exception as e:
             logger.error(f"Failed to initialize Ollama AsyncClient at {OLLAMA_BASE_URL}: {e}")
             ollama_client = None
     else:
         logger.warning("OLLAMA_BASE_URL not set. Ollama LLM service disabled.")

else:
    logger.warning(f"Unknown or unsupported LLM_SERVICE configured: {LLM_SERVICE}. LLM features may not work.")


class LLMService:
    # Corrected the default value for deepseek from 'config' to None
    def __init__(self, anthropic=None, deepseek=None, gemini=None, ollama=None):
        self.anthropic_client = anthropic
        self.deepseek_config = deepseek # Store config dict for requests
        self.gemini_model = gemini # Store the GenerativeModel instance
        self.ollama_client = ollama
        self.service_name = LLM_SERVICE
        self.model_name = LLM_MODEL

    async def ask(self, prompt: str, context: Optional[str]) -> str:
        """
        Sends a question to the configured LLM with optional provided context (selected text).
        """
        # --- Adjust prompt based on whether context is provided ---
        if context:
            # If context is provided (selected text), instruct the LLM to use it
            full_prompt = f"Context:\n{context}\n\nQuestion: {prompt}\n\nAnswer the question based ONLY on the provided context. If the context does not contain the answer, state that you cannot answer based on the provided text."
        else:
            # If no context is provided, just send the prompt (the user's question)
            full_prompt = prompt

        # Log length instead of content
        logger.info(f"Sending 'ask' prompt to LLM ({self.service_name}/{self.model_name}). Prompt length: {len(full_prompt)}")

        try:
            if self.service_name == "anthropic" and self.anthropic_client:
                # ... (Anthropic call using full_prompt)
                message = await self.anthropic_client.messages.create(
                    model=self.model_name,
                    max_tokens=4096,
                    system="You are a helpful assistant that answers questions based on provided text, or general knowledge if no specific text is given.", # Adjust system prompt slightly
                    messages=[
                        {"role": "user", "content": full_prompt}
                    ]
                )
                return message.content[0].text if message.content else "No response from LLM."

            elif self.service_name == "ollama" and self.ollama_client:
                 # ... (Ollama async client call using full_prompt)
                 response = await self.ollama_client.chat(
                     model=self.model_name,
                     messages=[
                         {'role': 'user', 'content': full_prompt},
                     ],
                 )
                 return response['message']['content'] if response and 'message' in response else "No response from LLM."

            elif self.service_name == "gemini" and self.gemini_model:
                 # ... (Gemini async client call using full_prompt)
                 response = await self.gemini_model.generate_content_async(
                     contents=[
                         {"role": "user", "parts": [full_prompt]}
                     ]
                 )
                 return response.text if response and response.text else "No response from LLM."

            elif self.service_name == "deepseek" and self.deepseek_config:
                 # ... (DeepSeek API call using requests (synchronous, needs run_in_threadpool) using full_prompt)
                 headers = {
                     "Authorization": f"Bearer {self.deepseek_config['api_key']}",
                     "Content-Type": "application/json"
                 }
                 payload = {
                     "model": self.model_name,
                     "messages": [
                         {"role": "user", "content": full_prompt}
                     ],
                     "max_tokens": 4096
                 }
                 from fastapi.concurrency import run_in_threadpool
                 try:
                     response = await run_in_threadpool(
                         requests.post,
                         self.deepseek_config['base_url'],
                         headers=headers,
                         json=payload,
                         timeout=60
                     )
                     response.raise_for_status()
                     response_data = response.json()
                     return response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else "No response from LLM."
                 except requests.exceptions.RequestException as req_err:
                     logger.error(f"DeepSeek API request failed: {req_err}")
                     return f"Error from DeepSeek API: {req_err}"
                 except json.JSONDecodeError:
                     logger.error(f"DeepSeek API returned invalid JSON: {response.text}")
                     return f"Error from DeepSeek API: Invalid response format."

            else:
                 error_msg = f"LLM service '{self.service_name}' is configured but client is not initialized or implemented."
                 logger.error(error_msg)
                 return error_msg

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'ask' method: {e}")
            return f"Error generating response from LLM: {e}"

    # Keep the summarize method as is
    async def summarize(self, text: str) -> str:
        """
        Sends text to the configured LLM for summarization.
        """
        if not text:
            return "No text provided to summarize."

        prompt = f"Please provide a concise summary of the following text:\n\n{text}"
        # Log length instead of content
        logger.info(f"Sending 'summarize' prompt to LLM ({self.service_name}/{self.model_name}). Text length: {len(text)}")

        try:
            if self.service_name == "anthropic" and self.anthropic_client:
                 message = await self.anthropic_client.messages.create(
                    model=self.model_name, # Use the configured model
                    max_tokens=4096, # Adjust as needed
                    system="You are a helpful assistant that summarizes text.",
                    messages=[
                        {"role": "user", "content": prompt}
                    ]
                )
                 return message.content[0].text if message.content else "No summary from LLM."

            elif self.service_name == "ollama" and self.ollama_client:
                 # Ollama async client call
                 response = await self.ollama_client.chat(
                     model=self.model_name,
                     messages=[
                         {'role': 'user', 'content': prompt},
                     ],
                 )
                 return response['message']['content'] if response and 'message' in response else "No summary from LLM."

            elif self.service_name == "gemini" and self.gemini_model:
                 # Gemini async client call
                 response = await self.gemini_model.generate_content_async(
                     contents=[
                         {"role": "user", "parts": [prompt]}
                     ]
                 )
                 return response.text if response and response.text else "No summary from LLM."

            elif self.service_name == "deepseek" and self.deepseek_config:
                 # DeepSeek API call using requests (synchronous, needs run_in_threadpool)
                 headers = {
                     "Authorization": f"Bearer {self.deepseek_config['api_key']}",
                     "Content-Type": "application/json"
                 }
                 payload = {
                     "model": self.model_name,
                     "messages": [
                         {"role": "user", "content": prompt}
                     ],
                     "max_tokens": 4096 # Adjust as needed
                 }
                 from fastapi.concurrency import run_in_threadpool
                 try:
                     response = await run_in_threadpool(
                         requests.post,
                         self.deepseek_config['base_url'],
                         headers=headers,
                         json=payload,
                         timeout=60 # Add a timeout
                     )
                     response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
                     response_data = response.json()
                     return response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else "No summary from LLM."
                 except requests.exceptions.RequestException as req_err:
                     logger.error(f"DeepSeek API request failed: {req_err}")
                     return f"Error from DeepSeek API: {req_err}"
                 except json.JSONDecodeError:
                     logger.error(f"DeepSeek API returned invalid JSON: {response.text}")
                     return f"Error from DeepSeek API: Invalid response format."

            else:
                 # This case should ideally not be reached
                 error_msg = f"LLM service '{self.service_name}' is configured but client is not initialized or implemented."
                 logger.error(error_msg)
                 return error_msg

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'summarize' method: {e}")
            return f"Error generating summary from LLM: {e}"


# Instantiate the service as a singleton
llm_service = LLMService(
    anthropic=anthropic_client,
    deepseek=deepseek_config, # Pass the config dict
    gemini=gemini_model, # Pass the GenerativeModel instance
    ollama=ollama_client # Pass the AsyncClient instance
)

# Update the async wrapper function to match the new parameter name
async def ask_question(question: str, context: Optional[str]) -> str:
    """
    Sends a question to the configured LLM with optional provided context.
    Calls the async LLMService.ask method.
    """
    logger.info(f"Calling LLM service 'ask' via wrapper with question length: {len(question)} and context length: {len(context) if context else 0}...")
    return await llm_service.ask(question, context)

# Keep the summarize_text wrapper function as is
async def summarize_text(text: str) -> str:
    """
    Sends text to the configured LLM for summarization.
    Calls the async LLMService.summarize method.
    """
    logger.info(f"Calling LLM service 'summarize' via wrapper with text length: {len(text)}...")
    return await llm_service.summarize(text)

# TODO: Add other LLM interaction functions as needed (e.g., extract_keywords)
