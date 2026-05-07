print("DEBUG: Executing backend/services/llm_service.py module")

import os
from dotenv import load_dotenv
import logging
from typing import Optional, Dict, Any, List
# Import client libraries for different LLM providers
from anthropic import Anthropic # Assuming Anthropic is used
from ollama import AsyncClient # Use AsyncClient for better FastAPI integration
from google import genai
from google.genai import types
# Assuming requests is used for DeepSeek (adjust if a specific client library is available)
import requests
import json # Import json for DeepSeek requests
import re # Import re for regular expressions
import time
import base64
from backend.models.reading_guide import ReadingGuideItem
from backend.services.knowledge_mapper import KnowledgeMapper

load_dotenv()
logger = logging.getLogger(__name__)

# --- Add these debug log statements ---
logger.info(f"DEBUG: OLLAMA_BASE_URL from os.getenv: '{os.getenv('OLLAMA_BASE_URL')}'")
logger.info(f"DEBUG: LLM_SERVICE from os.getenv: '{os.getenv('LLM_SERVICE')}'")
logger.info(f"DEBUG: LLM_MODEL from os.getenv: '{os.getenv('LLM_MODEL')}'")


LLM_SERVICE = os.getenv("LLM_SERVICE", "ollama")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:14b")
ollama_env_base_url = os.getenv("OLLAMA_BASE_URL")

# Dedicated guide generation model/config (defaults to Gemini Flash for cost/latency).
GUIDE_LLM_SERVICE = os.getenv("GUIDE_LLM_SERVICE", "gemini")
GUIDE_LLM_MODEL = os.getenv("GUIDE_LLM_MODEL", "gemini-2.0-flash")
GUIDE_LLM_GEMINI_API_KEY = os.getenv("GUIDE_LLM_GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY")

# Gemini image generation model (uses generateContent, same endpoint as LLM).
# Options: gemini-2.5-flash-image, gemini-3.1-flash-image-preview, gemini-3-pro-image-preview
GRAPH_LLM_IMAGE_MODEL = os.getenv("GRAPH_LLM_IMAGE_MODEL", "gemini-2.5-flash-image")


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
gemini_client = None
ollama_client = None
guide_gemini_client = None

# Initialize formatting-specific LLM clients
formatting_anthropic_client = None
formatting_gemini_client = None
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
            gemini_client = genai.Client(api_key=GEMINI_API_KEY)
            logger.info(f"Gemini client initialized with model: {LLM_MODEL}.")
        except Exception as e:
            logger.error(f"Failed to configure Gemini client: {e}")
            gemini_client = None
    else:
        logger.warning("GEMINI_API_KEY not set. Gemini LLM service disabled.")

else:
    logger.warning(f"Unknown or unsupported LLM_SERVICE configured: {LLM_SERVICE}. LLM features may not work.")

# Optional dedicated guide model (currently only Gemini is supported as separate model target).
if GUIDE_LLM_SERVICE == "gemini" and GUIDE_LLM_GEMINI_API_KEY:
    try:
        guide_gemini_client = genai.Client(api_key=GUIDE_LLM_GEMINI_API_KEY)
        logger.info(f"Guide Gemini client initialized: {GUIDE_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize guide Gemini client '{GUIDE_LLM_MODEL}': {e}")
        guide_gemini_client = None

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
        formatting_gemini_client = genai.Client(api_key=FORMATTING_GEMINI_API_KEY)
        logger.info(f"Formatting-specific Gemini client initialized: {FORMATTING_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize formatting-specific Gemini client: {e}")
        formatting_gemini_client = None
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
    def __init__(self, anthropic=None, deepseek=None, gemini_client=None, ollama=None, guide_gemini_client=None,
                 formatting_anthropic=None, formatting_gemini_client=None, formatting_ollama=None):
        self.anthropic_client = anthropic
        self.deepseek_config = deepseek # Store config dict for requests
        self.gemini_client = gemini_client
        self.ollama_client = ollama
        self.guide_gemini_client = guide_gemini_client
        self.guide_model_name = GUIDE_LLM_MODEL
        self.service_name = LLM_SERVICE
        self.model_name = LLM_MODEL
        # Formatting-specific clients
        self.formatting_anthropic_client = formatting_anthropic
        self.formatting_gemini_client = formatting_gemini_client
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

            elif self.service_name == "gemini" and self.gemini_client:
                 response = await self.gemini_client.aio.models.generate_content(
                     model=self.model_name,
                     contents=full_prompt,
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

            elif self.service_name == "gemini" and self.gemini_client:
                 response = await self.gemini_client.aio.models.generate_content(
                     model=self.model_name,
                     contents=prompt,
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
            (self.formatting_service_name == "gemini" and self.formatting_gemini_client) or
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
            
            elif use_formatting and self.formatting_service_name == "gemini" and self.formatting_gemini_client:
                response = await self.formatting_gemini_client.aio.models.generate_content(
                    model=self.formatting_model_name,
                    contents=full_prompt,
                )
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

            elif self.service_name == "gemini" and self.gemini_client:
                response = await self.gemini_client.aio.models.generate_content(
                    model=self.model_name,
                    contents=full_prompt,
                )
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

    async def generate_structured_reading_guide(
        self,
        segments: List[Dict[str, Any]],
        book_title: str,
        page_number: int,
        total_pages: int,
        guide_type: str = "summary",
    ) -> Dict[str, Any]:
        """
        Generates a structured reading guide from pre-segmented content.
        segments: list of {"section_title": str, "content": str}. Offsets are assigned by the caller.
        Returns {"sections": [{"section_title", "key_takeaway", "rewritten_content"}], "document_structure_map": {}}.
        """
        if not segments:
            return {"sections": [], "document_structure_map": {}}

        brevity_instruction = {
            "summary": "For each section provide: 1) key_takeaway: one sentence capturing the main idea; 2) rewritten_content: 2-4 bullet points OR 1-3 sentences. Be concise.",
            "comprehensive": "For each section provide: 1) key_takeaway: one sentence main idea; 2) rewritten_content: a condensed rewrite preserving key information, in simpler language when appropriate.",
            "quick_reference": "For each section provide: 1) key_takeaway: one sentence main idea; 2) rewritten_content: one line only (one short sentence or phrase).",
        }.get(guide_type, "For each section provide: 1) key_takeaway: one sentence main idea; 2) rewritten_content: 2-4 bullet points OR 1-3 sentences. Be concise.")

        system_prompt = f"""You are an expert reading assistant. Your task is to create a READING GUIDE that helps readers quickly absorb the main ideas of a book. The guide is a replacement for skimming—readers use it to grasp the content fast, then click through to the original text when they want to go deeper.

CONTEXT:
- Book: "{book_title}"
- This is page {page_number} of {total_pages}

INPUT:
The following content is pre-segmented by headings. Each section has a title and content. Your job is to summarize each section concisely.

TASK:
{brevity_instruction}

CRITICAL: You do NOT need to provide character offsets. The system will link each section to the original text automatically.

OUTPUT FORMAT (JSON):
Return a JSON object with this exact structure. Use double braces for literal braces in the example:
{{"sections": [{{"section_title": "Exact or cleaned heading from input", "key_takeaway": "One sentence main idea", "rewritten_content": "Bullet points or 1-3 sentences. Be brief."}}]}}

Return ONLY valid JSON, no other text."""

        input_parts = []
        for i, seg in enumerate(segments):
            title = seg.get("section_title", f"Section {i + 1}")
            content = seg.get("content", "")
            input_parts.append(f"[SECTION {i + 1}]\nTitle: {title}\nContent:\n{content}")
        user_prompt = "INPUT SECTIONS:\n\n" + "\n\n".join(input_parts) + "\n\nProvide the structured guide in JSON format as specified."

        logger.info(f"Generating structured reading guide for page {page_number} ({len(segments)} segments), guide_type={guide_type} using {self.service_name}/{self.model_name}")

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
            
            elif self.service_name == "gemini" and self.gemini_client:
                response = await self.gemini_client.aio.models.generate_content(
                    model=self.model_name,
                    contents=user_prompt,
                    config=types.GenerateContentConfig(system_instruction=system_prompt),
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
                # Strip markdown code blocks (```json ... ``` or ``` ... ```)
                json_str = response_text.strip()
                if json_str.startswith("```"):
                    first_newline = json_str.find("\n")
                    if first_newline != -1:
                        json_str = json_str[first_newline + 1:]
                    if json_str.endswith("```"):
                        json_str = json_str[:-3].rstrip()
                # Extract only the first JSON object (ignore trailing text / extra data)
                json_str = json_str.strip()
                decoder = json.JSONDecoder()
                guide_data, _ = decoder.raw_decode(json_str)
                
                # Validate and normalize the structure
                if not isinstance(guide_data, dict):
                    raise ValueError("Response is not a dictionary")
                
                sections = guide_data.get("sections", [])
                structure_map = guide_data.get("document_structure_map", {})
                
                validated_sections = []
                for i, section in enumerate(sections):
                    if isinstance(section, dict):
                        default_title = segments[i].get("section_title", f"Section {i+1}") if i < len(segments) else f"Section {i+1}"
                        validated_section = {
                            "section_title": section.get("section_title", default_title),
                            "key_takeaway": section.get("key_takeaway"),
                            "rewritten_content": section.get("rewritten_content", ""),
                        }
                        validated_sections.append(validated_section)
                
                return {
                    "sections": validated_sections,
                    "document_structure_map": structure_map if isinstance(structure_map, dict) else {}
                }
            
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON from LLM response: {e}. Response: {response_text[:500]}")
                first_content = segments[0].get("content", "") if segments else ""
                default_title = segments[0].get("section_title", "Page content") if segments else "Page content"
                return {
                    "sections": [{
                        "section_title": default_title,
                        "key_takeaway": None,
                        "rewritten_content": response_text[:2000] if response_text else "No content generated.",
                    }],
                    "document_structure_map": {}
                }
            except Exception as e:
                logger.error(f"Error processing structured guide response: {e}", exc_info=True)
                return {"sections": [], "document_structure_map": {}}

        except Exception as e:
            logger.error(f"Error calling {self.service_name} LLM 'generate_structured_reading_guide' method: {e}", exc_info=True)
            return {"sections": [], "document_structure_map": {}}

    def _select_guide_gemini(self):
        """Prefer dedicated guide client/model when configured, fall back to main Gemini."""
        if self.guide_gemini_client:
            return self.guide_gemini_client, self.guide_model_name
        if self.service_name == "gemini" and self.gemini_client:
            return self.gemini_client, self.model_name
        return None, None

    def _normalize_json_response(self, response_text: str) -> Optional[Dict[str, Any]]:
        """Extract first JSON object from an LLM response."""
        if not response_text:
            return None
        json_str = self._remove_think_tags(response_text).strip()
        if json_str.startswith("```"):
            first_newline = json_str.find("\n")
            if first_newline != -1:
                json_str = json_str[first_newline + 1:]
            if json_str.endswith("```"):
                json_str = json_str[:-3].rstrip()
        try:
            decoder = json.JSONDecoder()
            data, _ = decoder.raw_decode(json_str.strip())
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _extract_first_meaningful_sentence(self, source_text: str) -> str:
        """
        Return the first meaningful sentence from a segment.
        Skips obvious heading/list-only noise and normalizes whitespace.
        """
        if not source_text:
            return ""

        meaningful_lines: List[str] = []
        for raw_line in source_text.splitlines():
            line = (raw_line or "").strip()
            if not line:
                continue
            if line.startswith("#"):
                continue
            if re.fullmatch(r"[-*_`~\s]+", line):
                continue
            if line.lower() in {"contents", "table of contents"}:
                continue
            # Remove common list markers so list entries can still be meaningful.
            line = re.sub(r"^([*\-+]\s+|\d+[\.\)]\s+)", "", line).strip()
            if len(line) < 3:
                continue
            meaningful_lines.append(line)

        normalized = re.sub(r"\s+", " ", " ".join(meaningful_lines)).strip()
        if not normalized:
            return ""

        match = re.search(r"[^.!?]+[.!?](?:\s|$)", normalized)
        sentence = (match.group(0) if match else normalized).strip()

        if len(sentence) > 260:
            sentence = sentence[:260].rsplit(" ", 1)[0].strip()
            if not sentence.endswith(("...", ".", "!", "?")):
                sentence = f"{sentence}..."
        return sentence

    def _prepend_reasonable_context(self, source_text: str, reference_sentence: str, max_prefix: int = 140) -> str:
        """
        Return reference_sentence prefixed with a bounded slice of text that
        appears immediately before it in the segment (sentence boundary when sensible).
        """
        ref = (reference_sentence or "").strip()
        if not ref:
            return ""
        source_normalized = re.sub(r"\s+", " ", (source_text or "")).strip()
        if not source_normalized:
            return ref
        idx = source_normalized.find(ref)
        if idx < 0 and ref:
            words = ref.split()
            stub = " ".join(words[: min(6, len(words))]) if len(words) >= 2 else (words[0] if words else "")
            idx = source_normalized.find(stub) if stub else -1
        if idx <= 0:
            return ref
        before = source_normalized[:idx].rstrip()
        if not before:
            return ref
        # Prefer starting after prior sentence boundary for a cleaner excerpt.
        window_start = max(0, len(before) - max_prefix)
        candidate = before[window_start:].strip()
        sentence_break = None
        for m in re.finditer(r"[.!?]\s+", candidate):
            sentence_break = m.end()
        if sentence_break is not None and sentence_break < len(candidate) - 15:
            prefix = candidate[sentence_break:].strip()
        else:
            prefix = candidate.strip()
        if prefix and prefix[-1] in ".!?":
            prefix = prefix[:-1].rstrip()
        if not prefix:
            return ref
        return f"{prefix} {ref}".strip()

    def _build_reference_preview(self, source_text: str, reference_sentence: str) -> str:
        """
        Build preview text with a short prefix before the reference sentence,
        then optional continuation after it for navigation fallback.
        """
        source_normalized = re.sub(r"\s+", " ", (source_text or "")).strip()
        ref = (reference_sentence or "").strip()
        if not ref:
            return source_normalized[:420]
        if not source_normalized:
            return ref

        anchored = self._prepend_reasonable_context(source_text, ref)

        continuation = ""
        ref_idx = source_normalized.find(ref)
        if ref_idx >= 0:
            after = source_normalized[ref_idx + len(ref) :].strip()
            if after:
                continuation = after[:220].strip()

        tail = f"{anchored} {continuation}".strip() if continuation else anchored

        if len(tail) > 420:
            tail = tail[:420].rsplit(" ", 1)[0].strip()
            if not tail.endswith(("...", ".", "!", "?")):
                tail = f"{tail}..."
        return tail

    async def _generate_guide_json(
        self,
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int = 8192,
    ) -> Optional[Dict[str, Any]]:
        """Run a guide-generation LLM call and parse JSON object."""
        client, model_name = self._select_guide_gemini()
        if not client or not model_name:
            logger.warning("No guide Gemini client available.")
            return None

    async def _generate_signposts_for_nodes(self, nodes: List[Dict[str, Any]]) -> Dict[str, str]:
        """Best-effort LLM signpost generation for roadmap nodes."""
        client, model_name = self._select_guide_gemini()
        if not client or not model_name or not nodes:
            return {}

        compact_nodes = []
        for node in nodes:
            compact_nodes.append(
                {
                    "id": node.get("id"),
                    "title": node.get("title"),
                    "level": node.get("level"),
                    "snippet": (node.get("snippet") or "")[:280],
                    "hub_score": int(node.get("hub_score", 0)),
                }
            )

        system_prompt = (
            "You are a reading-map assistant. "
            "Write one concise purpose sentence per heading node. "
            "Purpose should describe why the section matters to understanding the book."
        )
        user_prompt = (
            "Return JSON only with this shape:\n"
            '{ "purposes": [{"id": "km-1", "purpose": "..." }] }\n'
            "Keep each purpose under 20 words and grounded in the snippet.\n\n"
            f"NODES:\n{json.dumps(compact_nodes, ensure_ascii=True)}"
        )
        parsed = await self._generate_guide_json(system_prompt, user_prompt, max_output_tokens=3072)
        if not parsed:
            return {}
        purposes = parsed.get("purposes", [])
        if not isinstance(purposes, list):
            return {}

        mapped: Dict[str, str] = {}
        for item in purposes:
            if not isinstance(item, dict):
                continue
            node_id = str(item.get("id", "")).strip()
            purpose = str(item.get("purpose", "")).strip()
            if node_id and purpose:
                mapped[node_id] = purpose
        return mapped

    async def generate_roadmap(self, markdown_text: str) -> List[ReadingGuideItem]:
        """
        Build a hierarchical roadmap from markdown using KnowledgeMapper as semantic backbone.
        """
        mapper = KnowledgeMapper()
        nodes = mapper.extract_knowledge_map(markdown_text or "")
        if not nodes:
            return []

        flat_nodes: List[Dict[str, Any]] = []

        def _collect(current_nodes: List[Dict[str, Any]]) -> None:
            for current in current_nodes:
                flat_nodes.append(current)
                _collect(current.get("children", []))

        _collect(nodes)
        missing_purpose_nodes = [n for n in flat_nodes if not n.get("purpose")]
        if missing_purpose_nodes:
            purposes = await self._generate_signposts_for_nodes(missing_purpose_nodes)
            mapper.apply_purposes(nodes, purposes)

        return mapper.nodes_to_reading_guide_items(nodes)

    async def generate_whole_book_reading_roadmap(
        self,
        heading_nodes: List[Dict[str, Any]],
        book_title: str,
        full_markdown: str,
    ) -> List[Dict[str, Any]]:
        """
        Two-pass semantic roadmap generation:
        1) Segment and filter non-book content.
        2) Generate a card per semantic segment.
        """
        if not heading_nodes:
            return []

        id_to_node = {n["id"]: n for n in heading_nodes}
        section_lines = []
        for n in heading_nodes:
            snippet = (n.get("snippet") or "")[:700]
            section_lines.append(
                f'[{n["id"]}] level={n.get("level", 1)} title="{n.get("title", "")}"\n'
                f"snippet: {snippet}"
            )
        sections_block = "\n\n".join(section_lines)

        segmentation_system = (
            "You are an expert editor. Create semantic segments for a learning roadmap from section outlines. "
            "Filter out front-matter and non-book-content when appropriate."
        )
        segmentation_user = (
            f'BOOK: "{book_title}"\n\n'
            "INPUT SECTIONS:\n"
            f"{sections_block}\n\n"
            "Return JSON only in this shape:\n"
            '{\n'
            '  "segments": [\n'
            '    {\n'
            '      "id": "seg1",\n'
            '      "title": "Semantic concept title",\n'
            '      "is_book_content": true,\n'
            '      "source_section_ids": ["s1","s2"],\n'
            '      "why": "short reason"\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "Rules: preserve source order, include all substantive sections, avoid tiny segments, avoid oversized segments."
        )
        seg_data = await self._generate_guide_json(segmentation_system, segmentation_user, max_output_tokens=12288)
        raw_segments = seg_data.get("segments", []) if seg_data else []

        valid_segments: List[Dict[str, Any]] = []
        for i, seg in enumerate(raw_segments):
            if not isinstance(seg, dict):
                continue
            source_ids = [sid for sid in (seg.get("source_section_ids") or []) if sid in id_to_node]
            if not source_ids:
                continue
            if seg.get("is_book_content") is False:
                continue
            # Split overly large segments by section count.
            if len(source_ids) > 8:
                for j in range(0, len(source_ids), 6):
                    chunk = source_ids[j:j + 6]
                    valid_segments.append({
                        "id": f'{seg.get("id") or f"seg{i+1}"}.p{j//6 + 1}',
                        "title": seg.get("title") or f"Segment {i + 1}",
                        "source_section_ids": chunk,
                    })
            else:
                valid_segments.append({
                    "id": seg.get("id") or f"seg{i + 1}",
                    "title": seg.get("title") or f"Segment {i + 1}",
                    "source_section_ids": source_ids,
                })

        if not valid_segments:
            # Safe fallback: derive one segment per heading node
            valid_segments = [
                {"id": f"seg{i+1}", "title": n.get("title", f"Section {i+1}"), "source_section_ids": [n["id"]]}
                for i, n in enumerate(heading_nodes)
            ]

        cards: List[Dict[str, Any]] = []
        for idx, seg in enumerate(valid_segments):
            nodes = [id_to_node[sid] for sid in seg["source_section_ids"] if sid in id_to_node]
            if not nodes:
                continue
            start_offset = min(n["start_offset"] for n in nodes)
            end_offset = max(n["end_offset"] for n in nodes)
            source_text = full_markdown[start_offset:end_offset]
            source_text = source_text[:6000]

            card_system = (
                "You are a close-reading mentor. Generate concise semantic study cards from source text."
            )
            card_user = (
                f'BOOK: "{book_title}"\n'
                f'SEGMENT TITLE: "{seg.get("title", f"Segment {idx+1}")}"\n'
                f"SOURCE TEXT:\n{source_text}\n\n"
                "Return JSON only:\n"
                '{\n'
                '  "title": "card title",\n'
                '  "key_idea": "1-2 sentences",\n'
                '  "thought_process": ["step 1", "step 2", "step 3"],\n'
                '  "reading_summary": "1-2 sentence quick absorption for this segment",\n'
                '  "reading_bullets": ["bullet 1", "bullet 2", "bullet 3"],\n'
                '  "quote": "verbatim 1-3 sentence quote from source",\n'
                '  "reference_paragraph": "a fuller 4-8 sentence paragraph-style excerpt from source that contains the quote context"\n'
                "}\n"
                "Keep each card substantial but not overloaded."
            )
            card_data = await self._generate_guide_json(card_system, card_user, max_output_tokens=4096)
            if not card_data:
                card_data = {
                    "title": seg.get("title", f"Segment {idx + 1}"),
                    "key_idea": (source_text[:260] + "...") if len(source_text) > 260 else source_text,
                    "thought_process": [],
                    "reading_summary": (source_text[:220] + "...") if len(source_text) > 220 else source_text,
                    "reading_bullets": [],
                    "quote": "",
                    "reference_paragraph": source_text[:900],
                }

            thought_process = card_data.get("thought_process") or []
            if not isinstance(thought_process, list):
                thought_process = []
            thought_process = [str(step).strip() for step in thought_process if str(step).strip()][:5]

            reading_bullets = card_data.get("reading_bullets") or []
            if not isinstance(reading_bullets, list):
                reading_bullets = []
            reading_bullets = [str(step).strip() for step in reading_bullets if str(step).strip()][:5]

            takeaway = card_data.get("key_idea")
            reference_sentence = self._extract_first_meaningful_sentence(source_text)
            key_quote = reference_sentence or card_data.get("quote") or ""
            preview_text = self._build_reference_preview(source_text, reference_sentence) or key_quote

            cards.append({
                "id": seg.get("id") or f"seg{idx + 1}",
                "title": card_data.get("title") or seg.get("title") or f"Segment {idx + 1}",
                "takeaway": takeaway,
                "thought_process": thought_process,
                "reading_summary": (card_data.get("reading_summary") or "").strip() or None,
                "reading_bullets": reading_bullets,
                "key_quote": key_quote,
                "preview_text": preview_text,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "level": 1,
                "children": [],
                "key_term": None,
                "enriched": True,
            })
        return cards

    async def generate_graph_image_bytes(
        self,
        card_title: str,
        key_idea: str,
        source_excerpt: str,
    ) -> Optional[bytes]:
        """
        Best-effort Gemini image generation for a concept graph.
        Returns image bytes (PNG/JPEG) or None.
        """
        api_key = GUIDE_LLM_GEMINI_API_KEY or os.getenv("GEMINI_API_KEY")
        if not api_key:
            logger.warning("Graph generation skipped: Gemini API key is missing.")
            return None

        prompt = (
            "Create a clean, minimal concept graph diagram (not decorative art). "
            "Use nodes and arrows that explain the relationship between ideas.\n\n"
            f"Title: {card_title}\n"
            f"Key idea: {key_idea}\n"
            f"Source excerpt: {source_excerpt[:1000]}"
        )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{GRAPH_LLM_IMAGE_MODEL}:generateContent?key={api_key}"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
        }
        try:
            resp = requests.post(url, json=payload, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                logger.warning(f"Graph generation returned no candidates: {str(data)[:400]}")
                return None
            parts = candidates[0].get("content", {}).get("parts") or []
            for part in parts:
                inline = part.get("inlineData")
                if inline and inline.get("data"):
                    return base64.b64decode(inline["data"])
            logger.warning(f"Graph generation: no image in response parts: {str(parts)[:400]}")
        except Exception as e:
            logger.error(f"Graph image generation failed: {e}", exc_info=True)
            return None

    async def generate_alternative_reading(
        self,
        card_title: str,
        source_excerpt: str,
    ) -> Optional[str]:
        """
        Generate a concise rewrite in the source author's style.
        Returns plain text or None when generation fails.
        """
        if not source_excerpt or not source_excerpt.strip():
            return None

        client, model_name = self._select_guide_gemini()
        if not client or not model_name:
            logger.warning("Alternative reading generation skipped: no guide client available.")
            return None

        trimmed_source = source_excerpt.strip()
        source_word_count = len(trimmed_source.split())
        target_word_count = max(45, int(source_word_count * 0.30))
        system_prompt = (
            "You are rewriting your own passage as the original author. "
            "Produce an Author Shortcut that is about 30% of the source passage length while preserving the same claims, perspective, and tone. "
            "Keep the author's point of view and rhetorical stance, but remove repetition and non-essential detail. "
            "Do not switch to editor commentary, meta explanation, or study-guide voice. "
            "Do not add new facts, examples, or interpretations not supported by the source."
        )
        user_prompt = (
            f"CARD TITLE: {card_title}\n\n"
            f"SOURCE WORD COUNT: {source_word_count}\n"
            f"TARGET WORD COUNT (~30%): {target_word_count}\n\n"
            "SOURCE PASSAGE:\n"
            f"{trimmed_source}\n\n"
            "Write an 'Author Shortcut' that is close to the target word count and easy to consume quickly. "
            "Prefer a single concise paragraph in 3-6 sentences. "
            "Return only the rewritten passage text."
        )

        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=1024,
                ),
            )
            response_text = self._remove_think_tags(response.text if response and response.text else "").strip()
            if response_text.startswith("```"):
                first_newline = response_text.find("\n")
                if first_newline != -1:
                    response_text = response_text[first_newline + 1:].strip()
                if response_text.endswith("```"):
                    response_text = response_text[:-3].strip()
            return response_text or None
        except Exception as e:
            logger.error(f"Alternative reading generation failed: {e}", exc_info=True)
            return None

    async def generate_outsider_guide(
        self,
        card_title: str,
        source_excerpt: str,
    ) -> Optional[str]:
        """
        Generate a beginner-oriented rewrite in the source author's style.
        Returns plain text or None when generation fails.
        """
        if not source_excerpt or not source_excerpt.strip():
            return None

        client, model_name = self._select_guide_gemini()
        if not client or not model_name:
            logger.warning("Outsider guide generation skipped: no guide client available.")
            return None

        trimmed_source = source_excerpt.strip()
        source_word_count = len(trimmed_source.split())
        target_word_count = max(55, int(source_word_count * 0.40))
        system_prompt = (
            "You are rewriting your own passage as the original author, but for a reader who is completely new to this topic. "
            "Write an Outsider Guide that keeps the author's voice, perspective, and core claims, while making the ideas easy for a first-time reader to follow. "
            "Preserve factual meaning from the source passage. "
            "Keep the same authorial stance and tone; do not switch to editor or teacher meta voice. "
            "Assume zero prior topic exposure. "
            "Explain specialized terms in plain language when needed. "
            "Prefer concrete, direct wording over abstract shorthand. "
            "Remove repetition and non-essential detail. "
            "Do not add facts, examples, or interpretations not supported by the source. "
            "Output only the final rewritten passage text with no title, bullets, or commentary."
        )
        user_prompt = (
            f"CARD TITLE: {card_title}\n\n"
            f"SOURCE WORD COUNT: {source_word_count}\n"
            f"TARGET WORD COUNT (~40%): {target_word_count}\n\n"
            "SOURCE PASSAGE:\n"
            f"{trimmed_source}\n\n"
            "Write an Outsider Guide that is close to the target word count and optimized for fast comprehension by a reader new to this subject. "
            "Prefer one concise paragraph in 4-8 sentences. "
            "Return only the rewritten passage text."
        )

        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=1024,
                ),
            )
            response_text = self._remove_think_tags(response.text if response and response.text else "").strip()
            if response_text.startswith("```"):
                first_newline = response_text.find("\n")
                if first_newline != -1:
                    response_text = response_text[first_newline + 1:].strip()
                if response_text.endswith("```"):
                    response_text = response_text[:-3].strip()
            return response_text or None
        except Exception as e:
            logger.error(f"Outsider guide generation failed: {e}", exc_info=True)
            return None


# Instantiate the service as a singleton
llm_service = LLMService(
    anthropic=anthropic_client,
    deepseek=deepseek_config, # Pass the config dict
    gemini_client=gemini_client,
    ollama=ollama_client, # Pass the AsyncClient instance
    guide_gemini_client=guide_gemini_client,
    formatting_anthropic=formatting_anthropic_client,
    formatting_gemini_client=formatting_gemini_client,
    formatting_ollama=formatting_ollama_client
)

# --- Add a check to see if any LLM service was successfully initialized ---
if not (llm_service.anthropic_client or llm_service.deepseek_config or llm_service.gemini_client or llm_service.ollama_client):
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
