print("DEBUG: Executing backend/services/llm_service.py module")

import os
from dotenv import load_dotenv
import logging
from typing import Optional, Dict, Any
# Import client libraries for different LLM providers
from anthropic import Anthropic # Assuming Anthropic is used
from ollama import AsyncClient # Use AsyncClient for better FastAPI integration
# Assuming google-generativeai is used for Gemini
import google.generativeai as genai
# Assuming requests is used for DeepSeek (adjust if a specific client library is available)
import requests
import json # Import json for DeepSeek requests
import re # Import re for regular expressions
import time

load_dotenv()
logger = logging.getLogger(__name__)

# --- Add these debug log statements ---
logger.info(f"DEBUG: OLLAMA_BASE_URL from os.getenv: '{os.getenv('OLLAMA_BASE_URL')}'")
logger.info(f"DEBUG: LLM_SERVICE from os.getenv: '{os.getenv('LLM_SERVICE')}'")
logger.info(f"DEBUG: LLM_MODEL from os.getenv: '{os.getenv('LLM_MODEL')}'")


LLM_SERVICE = os.getenv("LLM_SERVICE", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:14b")
ollama_env_base_url = os.getenv("OLLAMA_BASE_URL")


ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# --- Formatting-specific LLM configuration ---
FORMATTING_LLM_SERVICE = os.getenv("FORMATTING_LLM_SERVICE")  # e.g., "anthropic", "gemini", "ollama"
FORMATTING_LLM_MODEL = os.getenv("FORMATTING_LLM_MODEL")  # e.g., "claude-3-5-sonnet-20241022"
FORMATTING_ANTHROPIC_API_KEY = os.getenv("FORMATTING_ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
FORMATTING_GEMINI_API_KEY = os.getenv("FORMATTING_GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY")
FORMATTING_OLLAMA_BASE_URL = os.getenv("FORMATTING_OLLAMA_BASE_URL") or os.getenv("OLLAMA_BASE_URL")

# Initialize LLM clients based on configuration
# Keep these outside the class for singleton pattern
anthropic_client = None
deepseek_config = None # For requests, this might just be the API key/URL
gemini_model = None # Store the GenerativeModel instance
ollama_client = None

# Initialize formatting-specific LLM clients
formatting_anthropic_client = None
formatting_gemini_model = None
formatting_ollama_client = None

# --- Use the dedicated variable for Ollama initialization ---
if LLM_SERVICE == "ollama":
     if ollama_env_base_url: # Check if the environment variable had a value
         try:
             # Use the async client with the value from the environment variable
             ollama_client = AsyncClient(host=ollama_env_base_url)
             logger.info(f"Ollama AsyncClient initialized for {ollama_env_base_url}. Model check pending.")

         except Exception as e:
             logger.error(f"Failed to initialize Ollama AsyncClient at {ollama_env_base_url}: {e}")
             ollama_client = None # Explicitly set to None on failure
     else:
         # This warning will now fire if OLLAMA_BASE_URL env var is missing or empty
         logger.warning("OLLAMA_BASE_URL environment variable not set. Ollama LLM service disabled.")

elif LLM_SERVICE == "anthropic":
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


else:
    logger.warning(f"Unknown or unsupported LLM_SERVICE configured: {LLM_SERVICE}. LLM features may not work.")

# Initialize formatting-specific LLM clients
if FORMATTING_LLM_SERVICE == "anthropic" and FORMATTING_ANTHROPIC_API_KEY and FORMATTING_LLM_MODEL:
    try:
        formatting_anthropic_client = Anthropic(api_key=FORMATTING_ANTHROPIC_API_KEY)
        logger.info(f"Formatting-specific Anthropic client initialized with model: {FORMATTING_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize formatting-specific Anthropic client: {e}")
        formatting_anthropic_client = None
elif FORMATTING_LLM_SERVICE == "gemini" and FORMATTING_GEMINI_API_KEY and FORMATTING_LLM_MODEL:
    try:
        genai.configure(api_key=FORMATTING_GEMINI_API_KEY)
        formatting_gemini_model = genai.GenerativeModel(FORMATTING_LLM_MODEL)
        logger.info(f"Formatting-specific Gemini model initialized: {FORMATTING_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize formatting-specific Gemini model: {e}")
        formatting_gemini_model = None
elif FORMATTING_LLM_SERVICE == "ollama" and FORMATTING_OLLAMA_BASE_URL and FORMATTING_LLM_MODEL:
    try:
        formatting_ollama_client = AsyncClient(host=FORMATTING_OLLAMA_BASE_URL)
        logger.info(f"Formatting-specific Ollama AsyncClient initialized at {FORMATTING_OLLAMA_BASE_URL} with model: {FORMATTING_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize formatting-specific Ollama AsyncClient: {e}")
        formatting_ollama_client = None
elif FORMATTING_LLM_SERVICE:
    logger.info(f"Formatting-specific LLM service '{FORMATTING_LLM_SERVICE}' configured but not fully initialized. Will fall back to standard reformatting.")
else:
    logger.info("No formatting-specific LLM service configured. Will use standard reformatting.")


class LLMService:
    # Corrected the default value for deepseek from 'config' to None
    def __init__(self, anthropic=None, deepseek=None, gemini=None, ollama=None, 
                 formatting_anthropic=None, formatting_gemini=None, formatting_ollama=None):
        self.anthropic_client = anthropic
        self.deepseek_config = deepseek # Store config dict for requests
        self.gemini_model = gemini # Store the GenerativeModel instance
        self.ollama_client = ollama
        self.service_name = LLM_SERVICE
        self.model_name = LLM_MODEL
        # Formatting-specific clients
        self.formatting_anthropic_client = formatting_anthropic
        self.formatting_gemini_model = formatting_gemini
        self.formatting_ollama_client = formatting_ollama
        self.formatting_service_name = FORMATTING_LLM_SERVICE
        self.formatting_model_name = FORMATTING_LLM_MODEL

    def _remove_think_tags(self, text: str) -> str:
        """Removes content within <think>...</think> tags."""
        if not text:
            return ""
        # Using re.DOTALL to make '.' match newlines as well
        return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    async def ask(self, prompt: str, context: Optional[str]) -> str:
        """
        Sends a question to the configured LLM with optional provided context (selected text).
        """
        # --- Add this log statement ---
        logger.info(f"LLMService.ask received context: '{context}'")

        # --- Adjust prompt based on whether context is provided ---
        if context:
            # If context is provided (selected text), instruct the LLM to use it
            full_prompt = f"Context:\n{context}\n\nQuestion: {prompt}\n\nAnswer the question based ONLY on the provided context. If the context does not contain the answer, state that you cannot answer based on the provided text."
        else:
            # If no context is provided, just send the prompt (the user's question)
            full_prompt = prompt

        # Log length instead of content
        logger.info(f"Sending 'ask' prompt to LLM ({self.service_name}/{self.model_name}). Prompt length: {len(full_prompt)}")
        # --- Add this log statement to see the final prompt ---
        logger.info(f"Final 'ask' prompt sent to LLM: '{full_prompt}'")


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
                response_text = message.content[0].text if message.content else "No response from LLM."
                return self._remove_think_tags(response_text)

            elif self.service_name == "ollama" and self.ollama_client:
                 # ... (Ollama async client call using full_prompt)
                 response = await self.ollama_client.chat(
                     model=self.model_name,
                     messages=[
                         {'role': 'user', 'content': full_prompt},
                     ],
                 )
                 response_text = response['message']['content'] if response and 'message' in response else "No response from LLM."
                 return self._remove_think_tags(response_text)

            elif self.service_name == "gemini" and self.gemini_model:
                 # ... (Gemini async client call using full_prompt)
                 response = await self.gemini_model.generate_content_async(
                     contents=[
                         {"role": "user", "parts": [full_prompt]}
                     ]
                 )
                 response_text = response.text if response and response.text else "No response from LLM."
                 return self._remove_think_tags(response_text)

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
                         timeout=180
                     )
                     response.raise_for_status()
                     response_data = response.json()
                     response_text = response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else "No response from LLM."
                     return self._remove_think_tags(response_text)
                 except requests.exceptions.RequestException as req_err:
                     logger.error(f"DeepSeek API request failed: {req_err}")
                     return self._remove_think_tags(f"Error from DeepSeek API: {req_err}")
                 except json.JSONDecodeError:
                     logger.error(f"DeepSeek API returned invalid JSON: {response.text}")
                     return self._remove_think_tags(f"Error from DeepSeek API: Invalid response format.")

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
                    max_tokens=2048, # Adjust as needed
                    system="You are a helpful assistant that summarizes text.",
                    messages=[
                        {"role": "user", "content": prompt}
                    ]
                )
                 response_text = message.content[0].text if message.content else "No summary from LLM."
                 return self._remove_think_tags(response_text)

            elif self.service_name == "ollama" and self.ollama_client:
                 # Ollama async client call
                 response = await self.ollama_client.chat(
                     model=self.model_name,
                     messages=[
                         {'role': 'user', 'content': prompt},
                     ],
                 )
                 response_text = response['message']['content'] if response and 'message' in response else "No summary from LLM."
                 return self._remove_think_tags(response_text)

            elif self.service_name == "gemini" and self.gemini_model:
                 # Gemini async client call
                 response = await self.gemini_model.generate_content_async(
                     contents=[
                         {"role": "user", "parts": [prompt]}
                     ]
                 )
                 response_text = response.text if response and response.text else "No summary from LLM."
                 return self._remove_think_tags(response_text)

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
                     "max_tokens": 2048 # Adjust as needed
                 }
                 from fastapi.concurrency import run_in_threadpool
                 try:
                     response = await run_in_threadpool(
                         requests.post,
                         self.deepseek_config['base_url'],
                         headers=headers,
                         json=payload,
                         timeout=120 # Add a timeout
                     )
                     response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
                     response_data = response.json()
                     response_text = response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else "No summary from LLM."
                     return self._remove_think_tags(response_text)
                 except requests.exceptions.RequestException as req_err:
                     logger.error(f"DeepSeek API request failed: {req_err}")
                     return self._remove_think_tags(f"Error from DeepSeek API: {req_err}")
                 except json.JSONDecodeError:
                     logger.error(f"DeepSeek API returned invalid JSON: {response.text}")
                     return self._remove_think_tags(f"Error from DeepSeek API: Invalid response format.")

            else:
                 # This case should ideally not be reached
                 error_msg = f"LLM service '{self.service_name}' is configured but client is not initialized or implemented."
                 logger.error(error_msg)
                 return error_msg

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'summarize' method: {e}")
            return f"Error generating summary from LLM: {e}"

    async def reformat_content(self, text: str, use_formatting_llm: bool = True) -> str:
        """
        Reformats the given text for better formatting and clarity using an LLM.
        Preserves content and image links.
        Uses formatting-specific LLM if configured and use_formatting_llm is True, otherwise falls back to standard LLM.
        """
        if not text:
            return "No text provided to reformat."

        # Enhanced system prompt focusing on paragraph breaks, headings, lists, and readability
        system_prompt = """You are an expert in Markdown formatting and text organization. Your task is to reformat the given Markdown text to significantly improve its readability, consistency, and structural organization.

**CRITICAL INSTRUCTIONS - ADHERE STRICTLY:**

1. **CONTENT PRESERVATION:** Preserve ALL original information and content VERBATIM. Do NOT add new information, remove existing facts, or rephrase sentences. Maintain the exact meaning and wording.

2. **INTELLIGENT PARAGRAPH BREAKS:** 
   - Break long paragraphs into shorter, more digestible paragraphs when appropriate
   - Respect semantic boundaries - break at natural thought transitions
   - Ensure paragraphs are well-sized (typically 3-5 sentences, but adjust based on content)
   - Maintain logical flow between paragraphs

3. **PROPER HEADING HIERARCHY:**
   - Analyze and maintain or improve the heading structure (#, ##, ###, etc.)
   - Ensure headings accurately reflect the content hierarchy
   - Add appropriate spacing before and after headings
   - Use consistent heading styles throughout

4. **CONSISTENT LIST FORMATTING:**
   - Standardize list markers (use '-' consistently for unordered lists, '1.' for ordered lists)
   - Ensure proper indentation for nested lists
   - Add appropriate spacing around lists
   - Maintain list item alignment and structure

5. **OVERALL READABILITY:**
   - Improve sentence flow and clarity where appropriate (without changing meaning)
   - Ensure appropriate spacing between sections and elements
   - Normalize excessive blank lines (typically one blank line between paragraphs)
   - Improve visual structure while preserving all content

6. **SPECIAL ELEMENTS:**
   - Preserve image links EXACTLY as they appear: `![](path/to/image.png)` or `![alt text](path/to/image.png)`
   - Ensure tables are correctly formatted with proper alignment
   - Preserve code blocks and inline code exactly as they appear
   - Maintain blockquotes and other special formatting

7. **OUTPUT FORMAT:**
   - Output ONLY the reformatted Markdown text
   - Do NOT include any conversational text, apologies, explanations, or meta-commentary
   - Do NOT wrap the output in markdown code blocks (```markdown ... ```)

Reformat the following markdown:
"""
        full_prompt = f"{system_prompt}\n\n{text}"
        
        # Determine which LLM to use
        use_formatting = use_formatting_llm and self.formatting_service_name and (
            (self.formatting_service_name == "anthropic" and self.formatting_anthropic_client) or
            (self.formatting_service_name == "gemini" and self.formatting_gemini_model) or
            (self.formatting_service_name == "ollama" and self.formatting_ollama_client)
        )
        
        if use_formatting:
            service_name = self.formatting_service_name
            model_name = self.formatting_model_name
            logger.info(f"Sending 'reformat' prompt to formatting-specific LLM ({service_name}/{model_name}). Text length: {len(text)}")
        else:
            service_name = self.service_name
            model_name = self.model_name
            logger.info(f"Sending 'reformat' prompt to standard LLM ({service_name}/{model_name}). Text length: {len(text)}")

        try:
            # Try formatting-specific LLM first if configured
            if use_formatting and self.formatting_service_name == "anthropic" and self.formatting_anthropic_client:
                message = await self.formatting_anthropic_client.messages.create(
                    model=self.formatting_model_name,
                    max_tokens=8192,
                    system="You are an expert Markdown editor specializing in text organization and readability.",
                    messages=[{"role": "user", "content": full_prompt}]
                )
                response_text = message.content[0].text if message.content else ""
                return self._remove_think_tags(response_text)
            
            elif use_formatting and self.formatting_service_name == "gemini" and self.formatting_gemini_model:
                response = await self.formatting_gemini_model.generate_content_async(full_prompt)
                response_text = response.text if response and response.text else ""
                return self._remove_think_tags(response_text)
            
            elif use_formatting and self.formatting_service_name == "ollama" and self.formatting_ollama_client:
                response = await self.formatting_ollama_client.chat(
                    model=self.formatting_model_name,
                    messages=[{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': text}]
                )
                response_text = response['message']['content'] if response and 'message' in response else ""
                return self._remove_think_tags(response_text)
            
            # Fall back to standard LLM
            if self.service_name == "anthropic" and self.anthropic_client:
                message = await self.anthropic_client.messages.create(
                    model=self.model_name,
                    max_tokens=8192, # Allow more tokens for reformatting full documents
                    system="You are an expert Markdown editor specializing in text organization and readability.",
                    messages=[{"role": "user", "content": full_prompt}]
                )
                response_text = message.content[0].text if message.content else ""
                return self._remove_think_tags(response_text)

            elif self.service_name == "ollama" and self.ollama_client:
                response = await self.ollama_client.chat(
                    model=self.model_name,
                    messages=[{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': text}]
                )
                response_text = response['message']['content'] if response and 'message' in response else ""
                return self._remove_think_tags(response_text)

            elif self.service_name == "gemini" and self.gemini_model:
                response = await self.gemini_model.generate_content_async(full_prompt)
                response_text = response.text if response and response.text else ""
                return self._remove_think_tags(response_text)

            elif self.service_name == "deepseek" and self.deepseek_config:
                headers = {"Authorization": f"Bearer {self.deepseek_config['api_key']}", "Content-Type": "application/json"}
                payload = {"model": self.model_name, "messages": [{"role": "user", "content": full_prompt}], "max_tokens": 8192}
                from fastapi.concurrency import run_in_threadpool
                response = await run_in_threadpool(requests.post, self.deepseek_config['base_url'], headers=headers, json=payload, timeout=180)
                response.raise_for_status()
                response_data = response.json()
                response_text = response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else ""
                return self._remove_think_tags(response_text)

            else:
                error_msg = f"LLM service '{self.service_name}' is configured but client is not initialized or implemented for reformat."
                logger.error(error_msg)
                return f"Error: {error_msg}"

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'reformat_content' method: {e}", exc_info=True)
            return f"Error reformatting content from LLM: {e}"

    async def generate_structured_reading_guide(self, page_content: str, book_title: str, page_number: int) -> Dict[str, Any]:
        """
        Generates a structured reading guide with section-to-section rewrite/remap.
        Returns a dictionary with sections, offsets, and mappings.
        """
        if not page_content:
            return {"sections": [], "document_structure_map": {}}

        # Enhanced prompt for structured guide generation with precise linking
        system_prompt = """You are an expert reading assistant specializing in creating structured, section-by-section reading guides. Your task is to analyze the provided page content and create a meaningful rewrite/remap that helps users quickly understand and reference the original text.

**CRITICAL LINKING REQUIREMENTS:**
The most important element of the reading guide is enabling users to quickly link back to the original text. Every component must provide precise linking information.

1. For every section, identify the EXACT character offsets in the original text
2. Provide accurate preview text (100-200 characters) from the original source
3. Include context (50 chars before/after) for better navigation
4. Ensure offsets are precise - users will jump directly to these locations
5. Character offsets must be relative to the provided page content (starting from 0)

**TASK:**
1. Analyze the page content to identify natural sections (based on headings, paragraph breaks, topic changes)
2. For each identified section, create a condensed rewrite that:
   - Preserves all key information and main ideas
   - Uses simpler, clearer language when appropriate
   - Maintains the essential meaning and context
   - Is suitable for quick reading and quick reference
3. Provide precise character offsets and preview text for each section
4. Map sections to the original document structure (headings, levels)

**OUTPUT FORMAT (JSON):**
Return a JSON object with this exact structure:
{
  "sections": [
    {
      "section_title": "Section heading or descriptive title",
      "rewritten_content": "Condensed rewrite of this section in simpler language",
      "original_start_offset": 0,
      "original_end_offset": 150,
      "original_text_preview": "First 100-200 chars of original text for reference (exact excerpt from source)",
      "context_before": "Up to 50 chars of text before this section (if available)",
      "context_after": "Up to 50 chars of text after this section (if available)"
    }
  ],
  "document_structure_map": {
    "section_0": {"heading_level": 2, "original_heading": "Original Heading Text"},
    "section_1": {"heading_level": 3, "original_heading": "Subsection Text"}
  }
}

**IMPORTANT:**
- Character offsets (original_start_offset and original_end_offset) must be relative to the provided page content (starting from 0)
- Offsets should accurately correspond to positions within the page content you receive
- original_text_preview must be an EXACT excerpt from the original text (not paraphrased)
- context_before and context_after should be exact excerpts when available
- Section titles should match or reflect the original document structure
- Rewritten content should be meaningful and useful for quick reading
- Preserve all key information while making it more accessible
- If content is very short, a header, or an image caption, note that appropriately
- If content is blank, return empty sections array
- The offsets you provide will be converted to global document offsets automatically

Return ONLY valid JSON, no other text."""

        user_prompt = f"""Generate a structured reading guide for page {page_number} of the book "{book_title}".

Original page content:
{page_content}

Provide the structured guide in JSON format as specified."""

        logger.info(f"Generating structured reading guide for page {page_number} using {self.service_name}/{self.model_name}")

        try:
            response_text = ""
            
            if self.service_name == "anthropic" and self.anthropic_client:
                message = await self.anthropic_client.messages.create(
                    model=self.model_name,
                    max_tokens=4096,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_prompt}]
                )
                response_text = message.content[0].text if message.content else ""
            
            elif self.service_name == "ollama" and self.ollama_client:
                response = await self.ollama_client.chat(
                    model=self.model_name,
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_prompt}
                    ],
                )
                response_text = response['message']['content'] if response and 'message' in response else ""
            
            elif self.service_name == "gemini" and self.gemini_model:
                response = await self.gemini_model.generate_content_async(
                    contents=[
                        {"role": "user", "parts": [f"{system_prompt}\n\n{user_prompt}"]}
                    ]
                )
                response_text = response.text if response and response.text else ""
            
            elif self.service_name == "deepseek" and self.deepseek_config:
                headers = {
                    "Authorization": f"Bearer {self.deepseek_config['api_key']}",
                    "Content-Type": "application/json"
                }
                payload = {
                    "model": self.model_name,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
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
                        timeout=180
                    )
                    response.raise_for_status()
                    response_data = response.json()
                    response_text = response_data['choices'][0]['message']['content'] if response_data and 'choices' in response_data and len(response_data['choices']) > 0 else ""
                except requests.exceptions.RequestException as req_err:
                    logger.error(f"DeepSeek API request failed: {req_err}")
                    return {"sections": [], "document_structure_map": {}}
                except json.JSONDecodeError:
                    logger.error(f"DeepSeek API returned invalid JSON: {response.text}")
                    return {"sections": [], "document_structure_map": {}}
            
            else:
                logger.error(f"LLM service '{self.service_name}' is not configured or not implemented for structured guide generation.")
                return {"sections": [], "document_structure_map": {}}

            response_text = self._remove_think_tags(response_text)
            
            # Parse JSON response
            try:
                # Try to extract JSON from response (in case it's wrapped in markdown code blocks)
                import re
                json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
                if json_match:
                    json_str = json_match.group(0)
                else:
                    json_str = response_text
                
                guide_data = json.loads(json_str)
                
                # Validate and normalize the structure
                if not isinstance(guide_data, dict):
                    raise ValueError("Response is not a dictionary")
                
                sections = guide_data.get("sections", [])
                structure_map = guide_data.get("document_structure_map", {})
                
                # Validate sections structure
                validated_sections = []
                for i, section in enumerate(sections):
                    if isinstance(section, dict):
                        validated_section = {
                            "section_title": section.get("section_title", f"Section {i+1}"),
                            "rewritten_content": section.get("rewritten_content", ""),
                            "original_start_offset": int(section.get("original_start_offset", 0)),
                            "original_end_offset": int(section.get("original_end_offset", 0)),
                            "original_text_preview": section.get("original_text_preview", ""),
                            "context_before": section.get("context_before"),
                            "context_after": section.get("context_after")
                        }
                        validated_sections.append(validated_section)
                
                return {
                    "sections": validated_sections,
                    "document_structure_map": structure_map if isinstance(structure_map, dict) else {}
                }
            
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON from LLM response: {e}. Response: {response_text[:500]}")
                # Fallback: create a simple guide from the response
                return {
                    "sections": [{
                        "section_title": "Reading Guide",
                        "rewritten_content": response_text,
                        "original_start_offset": 0,
                        "original_end_offset": len(page_content),
                        "original_text_preview": page_content[:150] if len(page_content) > 150 else page_content
                    }],
                    "document_structure_map": {}
                }
            except Exception as e:
                logger.error(f"Error processing structured guide response: {e}", exc_info=True)
                return {"sections": [], "document_structure_map": {}}

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'generate_structured_reading_guide' method: {e}", exc_info=True)
            return {"sections": [], "document_structure_map": {}}


# Instantiate the service as a singleton
llm_service = LLMService(
    anthropic=anthropic_client,
    deepseek=deepseek_config, # Pass the config dict
    gemini=gemini_model, # Pass the GenerativeModel instance
    ollama=ollama_client, # Pass the AsyncClient instance
    formatting_anthropic=formatting_anthropic_client,
    formatting_gemini=formatting_gemini_model,
    formatting_ollama=formatting_ollama_client
)

# --- Add a check to see if any LLM service was successfully initialized ---
if not (llm_service.anthropic_client or llm_service.deepseek_config or llm_service.gemini_model or llm_service.ollama_client):
    logger.critical(f"No LLM service client was successfully initialized based on configuration (LLM_SERVICE='{LLM_SERVICE}'). LLM features will not work.")
else:
    logger.info(f"LLM service initialized using: {LLM_SERVICE}")


# Update the async wrapper function to match the new parameter name
async def ask_question(question: str, context: Optional[str]) -> str:
    """
    Sends a question to the configured LLM with optional provided context.
    Calls the async LLMService.ask method.
    """
    logger.info(f"Calling LLM service 'ask' via wrapper with question length: {len(question)} and context length: {len(context) if context else 0}...")
    # --- Add this log statement to see context in the wrapper ---
    logger.info(f"ask_question wrapper received context: '{context}'")
    return await llm_service.ask(question, context)

# Keep the summarize_text wrapper function as is
async def summarize_text(text: str) -> str:
    """
    Sends text to the configured LLM for summarization.
    Calls the async LLMService.summarize method.
    """
    logger.info(f"Calling LLM service 'summarize' via wrapper with text length: {len(text)}...")
    return await llm_service.summarize(text)

async def reformat_book_content(text: str) -> str:
    """
    Sends text to the configured LLM for reformatting.
    Calls the async LLMService.reformat_content method.
    """
    logger.info(f"Calling LLM service 'reformat_content' via wrapper with text length: {len(text)}...")
    return await llm_service.reformat_content(text)

# TODO: Add other LLM interaction functions as needed (e.g., extract_keywords)
