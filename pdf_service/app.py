import os
import logging
import sys
import uuid
from typing import Optional, List, Dict, Any, Tuple
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from pydantic import BaseModel
from dotenv import load_dotenv
import fitz  # PyMuPDF
from pdf2image import convert_from_bytes as pdf2image_convert_from_bytes
import numpy as np
import re
import unicodedata
import ollama # Import the ollama library
import asyncio # Import asyncio for background tasks
import concurrent.futures
import requests # Import requests for making HTTP calls in background task
from google import genai
from google.genai import types as genai_types
from anthropic import Anthropic # Import Anthropic for formatting-specific LLM
from parsers.document_parsers import (
    detect_document_extension,
    docx_bytes_to_markdown,
    epub_bytes_to_markdown,
    html_bytes_to_markdown,
    mobi_or_azw_to_epub_bytes,
    txt_bytes_to_markdown,
)
from parsers.scanned_figure_extraction import (
    extract_layout_figures_from_pdf_pages,
    extract_scanned_page_figures,
)
from parsers.mineru_extraction import mineru_is_available, process_pdf_with_mineru
from parsers.paddle_device import resolve_paddle_device

# PaddleOCR is optional at import time so non-OCR flows still work.
try:
    from paddleocr import PaddleOCR
except Exception:  # pragma: no cover - optional dependency may be absent locally
    PaddleOCR = None  # type: ignore[assignment]

# Initialize FastAPI app
app = FastAPI(title="Document Processing Service")

# Configure logging using the LOG_LEVEL environment variable
# Ensure this block is right after imports and app initialization
log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, log_level_str, logging.INFO)

logging.basicConfig(
    level=log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__) # Keep this line as it is

# --- Load environment variables here, outside of __main__ ---
# This ensures they are loaded when the module is imported by uvicorn
load_dotenv() # ADD this line here

# Get paths from environment variables
PDF_STORAGE_PATH = os.getenv('PDF_STORAGE_PATH')
MARKDOWN_PATH = os.getenv('MARKDOWN_PATH')
IMAGES_PATH = os.getenv('IMAGES_PATH')
# App images (from PDF processing) go to app/ subdirectory
APP_IMAGES_PATH = os.path.join(IMAGES_PATH, "app") if IMAGES_PATH else None

# PaddleOCR and pipeline configuration
PDF_OCR_ENGINE = os.getenv("PDF_OCR_ENGINE", "paddle")  # paddle, none, text-only
PDF_OCR_LANG = os.getenv("PDF_OCR_LANG", "en")
PDF_PAGE_DPI = int(os.getenv("PDF_PAGE_DPI", "200"))
PDF_FULL_PAGE_IMAGE_COVERAGE_THRESHOLD = float(
    os.getenv("PDF_FULL_PAGE_IMAGE_COVERAGE_THRESHOLD", "0.85")
)
# paddle (default) or mineru for scanned / image-heavy PDFs
PDF_EXTRACTION_BACKEND = os.getenv("PDF_EXTRACTION_BACKEND", "paddle").strip().lower()
logger.info(
    "PDF extraction config: backend=%s scan_figure_engine=%s full_page_threshold=%.2f",
    PDF_EXTRACTION_BACKEND,
    os.getenv("PDF_SCAN_FIGURE_ENGINE", "layout"),
    PDF_FULL_PAGE_IMAGE_COVERAGE_THRESHOLD,
)

# Get Ollama configuration from environment variables
OLLAMA_API_BASE = os.getenv('OLLAMA_API_BASE')
# Use LLM_MODEL from .env for the reformatting model
OLLAMA_REFORMAT_MODEL = os.getenv('OLLAMA_REFORMAT_MODEL') # Use the general LLM_MODEL setting

# Get Backend Callback URL from environment variables
BACKEND_CALLBACK_URL = os.getenv("BACKEND_CALLBACK_URL")

# Get Gemini API Key
GEMINI_API_KEY_REFORMAT = os.getenv("GEMINI_API_KEY") # Use the general GEMINI_API_KEY for reformatting

# Get Gemini Reformat Model Name (used if Gemini API key is present)
# Support both legacy and current env names.
GEMINI_REFORMAT_MODEL_NAME = (
    os.getenv("GEMINI_REFORMAT_MODEL")
    or os.getenv("GEMINI_REFORMAT_MODEL_NAME")
    or "gemini-2.5-flash"
)
# Per-chunk HTTP timeout for Gemini reformat (milliseconds; google-genai divides by 1000).
PDF_GEMINI_REFORMAT_TIMEOUT_MS = int(os.getenv("PDF_GEMINI_REFORMAT_TIMEOUT_MS", "360000"))

# Gemini client for markdown reformat (google-genai SDK)
gemini_reformat_client = None
if GEMINI_API_KEY_REFORMAT:
    try:
        gemini_reformat_client = genai.Client(api_key=GEMINI_API_KEY_REFORMAT)
        logger.info(f"Google Gemini client ready (GEMINI_API_KEY for reformatting). Model: {GEMINI_REFORMAT_MODEL_NAME}.")
    except Exception as e:
        logger.warning(f"Failed to initialize Gemini client for reformatting: {e}. Gemini reformatting will not be available.")
        GEMINI_API_KEY_REFORMAT = None
else:
    logger.info("GEMINI_API_KEY not found (used for reformatting). Google Gemini reformatting will not be available.")

# --- Formatting-specific LLM configuration ---
FORMATTING_LLM_SERVICE = os.getenv("FORMATTING_LLM_SERVICE")  # e.g., "anthropic", "gemini", "ollama"
FORMATTING_LLM_MODEL = os.getenv("FORMATTING_LLM_MODEL")  # e.g., "claude-3-5-sonnet-20241022"
FORMATTING_ANTHROPIC_API_KEY = os.getenv("FORMATTING_ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
FORMATTING_GEMINI_API_KEY = os.getenv("FORMATTING_GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY")
FORMATTING_OLLAMA_API_BASE = os.getenv("FORMATTING_OLLAMA_API_BASE") or os.getenv("OLLAMA_API_BASE")

# Initialize formatting-specific LLM clients
formatting_anthropic_client = None
formatting_gemini_client = None
formatting_ollama_client = None

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
elif FORMATTING_LLM_SERVICE == "ollama" and FORMATTING_OLLAMA_API_BASE and FORMATTING_LLM_MODEL:
    try:
        formatting_ollama_client = ollama.Client(host=FORMATTING_OLLAMA_API_BASE)
        logger.info(f"Formatting-specific Ollama client initialized at {FORMATTING_OLLAMA_API_BASE} with model: {FORMATTING_LLM_MODEL}")
    except Exception as e:
        logger.warning(f"Failed to initialize formatting-specific Ollama client: {e}")
        formatting_ollama_client = None
elif FORMATTING_LLM_SERVICE:
    logger.info(f"Formatting-specific LLM service '{FORMATTING_LLM_SERVICE}' configured but not fully initialized. Will fall back to standard reformatting.")
else:
    logger.info("No formatting-specific LLM service configured. Will use standard reformatting.")


# --- Helper function to sanitize filename ---
def sanitize_filename(filename: str) -> str:
    """Replaces spaces with underscores and removes potentially problematic characters."""
    # Replace spaces with underscores
    sanitized = filename.replace(' ', '_')
    # Remove characters that are not alphanumeric, underscores, hyphens, or periods
    # Keep periods for file extensions
    sanitized = re.sub(r'[^\w.-]', '', sanitized)
    # Optional: Limit length or handle leading/trailing periods/underscores
    return sanitized

def ensure_storage_paths():
    """Ensure all required storage directories exist with proper permissions"""
    paths = [PDF_STORAGE_PATH, MARKDOWN_PATH, IMAGES_PATH]
    for path in paths:
        if not path:
             logger.critical(f"Storage path environment variable is not set: {path}")
             raise ValueError(f"Storage path environment variable is not set.")
        try:
            os.makedirs(path, exist_ok=True)
            # Set permissions - 0o755 means owner can read/write/execute, group/others can read/execute
            # This is often sufficient for shared volumes
            os.chmod(path, 0o755)
            logger.info(f"Storage directory ensured: {path}")
        except Exception as e:
            logger.error(f"Error creating/configuring directory {path}: {e}")
            raise RuntimeError(f"Failed to setup storage directory {path}: {e}")
    
    # Ensure app images subdirectory exists
    if APP_IMAGES_PATH:
        try:
            os.makedirs(APP_IMAGES_PATH, exist_ok=True)
            os.chmod(APP_IMAGES_PATH, 0o755)
            logger.info(f"App images directory ensured: {APP_IMAGES_PATH}")
        except Exception as e:
            logger.error(f"Error creating/configuring app images directory {APP_IMAGES_PATH}: {e}")
            raise RuntimeError(f"Failed to setup app images directory {APP_IMAGES_PATH}: {e}")

# Ensure storage paths with error handling
try:
    ensure_storage_paths()
except Exception as e:
    logger.critical(f"Failed to initialize storage paths: {e}")
    sys.exit(1)


# --- PDF text vs scan detection and page rendering ---
def pdf_has_text(pdf_bytes: bytes, max_pages_to_check: int = 5) -> bool:
    """Return True if the PDF has extractable text on at least one of the first few pages."""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            n = min(max_pages_to_check, len(doc))
            for i in range(n):
                page = doc[i]
                text = page.get_text().strip()
                if len(text) > 50:  # meaningful text
                    return True
            return False
        finally:
            doc.close()
    except Exception as e:
        logger.warning(f"pdf_has_text failed: {e}, treating as scanned.")
        return False


def pdf_is_image_heavy_scan(
    pdf_bytes: bytes,
    max_pages_to_check: int = 10,
    page_fraction_threshold: float = 0.5,
) -> bool:
    """
    Detect scan-style PDFs that embed a near full-page raster per page (common for OCR'd scans).
    These often still pass pdf_has_text() because of an invisible OCR text layer.
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            n = min(max_pages_to_check, len(doc))
            if n == 0:
                return False
            pages_with_full_bleed = 0
            for i in range(n):
                page = doc[i]
                for xref in page.get_images(full=True):
                    base_xref = xref[0]
                    try:
                        img_info = doc.extract_image(base_xref)
                    except Exception:
                        continue
                    if _is_full_page_scan_image(page, base_xref, img_info):
                        pages_with_full_bleed += 1
                        break
            return pages_with_full_bleed >= max(1, int(n * page_fraction_threshold))
        finally:
            doc.close()
    except Exception as e:
        logger.warning(f"pdf_is_image_heavy_scan failed: {e}")
        return False


def pdf_to_page_images(pdf_bytes: bytes, dpi: int = 200) -> List[np.ndarray]:
    """Render PDF pages to RGB numpy arrays (H, W, 3) for OCR. Uses pdf2image (poppler)."""
    try:
        pil_images = pdf2image_convert_from_bytes(pdf_bytes, dpi=dpi)
        return [np.array(img) for img in pil_images]
    except Exception as e:
        logger.error(f"pdf_to_page_images failed: {e}")
        raise


def _image_rect_area_ratio(page: fitz.Page, xref: int) -> float:
    """Best-effort estimate of how much page area an image placement covers."""
    page_area = max(float(page.rect.width * page.rect.height), 1.0)
    try:
        rects = page.get_image_rects(xref)
    except Exception:
        rects = []
    if not rects:
        return 0.0
    max_ratio = 0.0
    for rect in rects:
        ratio = max(float(rect.width * rect.height), 0.0) / page_area
        if ratio > max_ratio:
            max_ratio = ratio
    return max_ratio


def _is_full_page_scan_image(page: fitz.Page, xref: int, img_info: Dict[str, Any]) -> bool:
    """Detect scanner background images that are effectively the whole page."""
    coverage_ratio = _image_rect_area_ratio(page, xref)
    if coverage_ratio >= PDF_FULL_PAGE_IMAGE_COVERAGE_THRESHOLD:
        return True

    img_w = float(img_info.get("width") or 0)
    img_h = float(img_info.get("height") or 0)
    page_w = max(float(page.rect.width), 1.0)
    page_h = max(float(page.rect.height), 1.0)
    if img_w <= 0 or img_h <= 0:
        return False

    # Scanner exports often keep one near page-sized image xref with small scaling differences.
    width_ratio = min(img_w, page_w) / max(img_w, page_w)
    height_ratio = min(img_h, page_h) / max(img_h, page_h)
    return width_ratio >= 0.90 and height_ratio >= 0.90


def extract_pdf_images(
    pdf_bytes: bytes,
    sanitized_title: str,
    app_images_path: str,
    skip_full_page_background: bool = False,
) -> List[List[str]]:
    """
    Extract embedded images from the PDF and save to app_images_path.
    Returns images_per_page: list of list of saved filenames (basename only).
    """
    if not app_images_path:
        return []
    images_per_page: List[List[str]] = []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            for page_num in range(len(doc)):
                page = doc[page_num]
                xref_list = page.get_images(full=True)
                filenames: List[str] = []
                page_failures = 0
                for img_idx, xref in enumerate(xref_list):
                    try:
                        base_xref = xref[0]
                        img_info = doc.extract_image(base_xref)
                        if skip_full_page_background and _is_full_page_scan_image(page, base_xref, img_info):
                            logger.info(
                                f"Skipping full-page scan background image xref={base_xref} on page {page_num + 1}"
                            )
                            continue
                        img_bytes = img_info.get("image")
                        if not img_bytes:
                            page_failures += 1
                            continue
                        ext = (img_info.get("ext") or "png").lower()
                        supported_exts = {"png", "jpg", "jpeg", "gif", "webp"}
                        if ext not in supported_exts:
                            # PyMuPDF can return formats such as jpx/jp2. Browsers may not render those
                            # (and simply renaming the extension produces broken images). Convert to PNG.
                            try:
                                pix = fitz.Pixmap(doc, base_xref)
                                if pix.n - pix.alpha > 3:
                                    pix = fitz.Pixmap(fitz.csRGB, pix)
                                img_bytes = pix.tobytes("png")
                                ext = "png"
                            except Exception as convert_exc:
                                page_failures += 1
                                logger.warning(
                                    f"Failed to convert unsupported image format '{img_info.get('ext')}' "
                                    f"for xref={base_xref} on page {page_num}: {convert_exc}"
                                )
                                continue
                        name = f"{sanitized_title}_p{page_num}_i{img_idx}.{ext}"
                        out_path = os.path.join(app_images_path, name)
                        with open(out_path, "wb") as f:
                            f.write(img_bytes)
                        filenames.append(name)
                    except Exception as e:
                        page_failures += 1
                        logger.warning(f"Failed to extract image xref={xref} on page {page_num}: {e}")
                images_per_page.append(filenames)
                logger.info(
                    f"extract_pdf_images page={page_num + 1} found={len(xref_list)} saved={len(filenames)} failed={page_failures}"
                )
        finally:
            doc.close()
    except Exception as e:
        logger.error(f"extract_pdf_images failed: {e}")
        return []
    return images_per_page


def inject_image_links_into_markdown(
    raw_md: str,
    images_per_page: List[List[str]],
    web_image_base_path: str = "/images/app",
    page_separator: str = "\n\n---\n\n",
) -> str:
    """Append markdown image links for each page's extracted images. Preserves page separator."""
    if not images_per_page:
        return raw_md
    parts = raw_md.split(page_separator)
    # Align by page index; if we have more image pages than text segments, extend parts
    while len(parts) < len(images_per_page):
        parts.append("")
    # Trim if more segments than pages (e.g. extra --- at end)
    parts = parts[: len(images_per_page)]
    injected = []
    for i, (seg, img_names) in enumerate(zip(parts, images_per_page)):
        block = seg.rstrip()
        if img_names:
            links = "\n\n".join(
                f"![]({web_image_base_path.rstrip('/')}/{name})" for name in img_names
            )
            block = f"{block}\n\n{links}" if block else links
        injected.append(block)
    return page_separator.join(injected)


def sanitize_extracted_text(text: str) -> str:
    """Normalize extracted text and remove problematic control characters."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFKC", text)
    cleaned_chars = []
    for ch in normalized:
        # Keep printable text, newline, tab. Drop most control/non-printable chars.
        if ch in ("\n", "\t") or ch.isprintable():
            cleaned_chars.append(ch)
    cleaned = "".join(cleaned_chars)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _protect_markdown_image_links(text: str) -> Tuple[str, Dict[str, str]]:
    """Replace markdown image links with placeholders to avoid LLM corruption."""
    token_map: Dict[str, str] = {}

    def replacer(match: re.Match) -> str:
        idx = len(token_map)
        token = f"__IMG_TOKEN_{idx}__"
        token_map[token] = match.group(0)
        return token

    protected = re.sub(r"!\[[^\]]*\]\([^)]+\)", replacer, text)
    return protected, token_map


def _restore_markdown_image_links(text: str, token_map: Dict[str, str]) -> str:
    restored = text
    for token, original in token_map.items():
        restored = restored.replace(token, original)
    return restored


_GEMINI_REFORMAT_SYSTEM_INSTRUCTION = """
You are an expert in Markdown formatting and text organization. Your task is to reformat the given Markdown text to significantly improve its readability, consistency, and structural organization.

Rules:
- Preserve all original text, headings, lists, code blocks, tables, and image links exactly (do not summarize or rephrase).
- Improve paragraph breaks, heading hierarchy, list formatting, and spacing.
- Output ONLY the reformatted Markdown (no commentary, no wrapping code fences).
"""


def _gemini_reformat_generate_config() -> genai_types.GenerateContentConfig:
    """Gemini config for upload-time markdown reformat (no tools / AFC)."""
    return genai_types.GenerateContentConfig(
        system_instruction=_GEMINI_REFORMAT_SYSTEM_INSTRUCTION,
        temperature=0.1,
        http_options=genai_types.HttpOptions(timeout=PDF_GEMINI_REFORMAT_TIMEOUT_MS),
        automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
    )


def _extract_gemini_response_text(response: Any) -> str:
    """Read text from a generate_content response; empty string if blocked or missing."""
    if response is None:
        return ""
    text = getattr(response, "text", None)
    if text:
        return text
    candidates = getattr(response, "candidates", None) or []
    parts: List[str] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        if not content:
            continue
        for part in getattr(content, "parts", None) or []:
            part_text = getattr(part, "text", None)
            if part_text:
                parts.append(part_text)
    return "".join(parts)


# --- Updated ProcessResponse model for async initiation ---
class ProcessResponse(BaseModel):
    success: bool
    message: str
    job_id: str
    status: str # e.g., "pending", "processing"


# RENAME function and update logic to use Ollama
def reformat_markdown_with_ollama(md_text):
    # Check if Ollama configuration is available
    if not OLLAMA_API_BASE or not OLLAMA_REFORMAT_MODEL:
        logger.warning("OLLAMA_API_BASE or OLLAMA_REFORMAT_MODEL not set. Skipping markdown reformatting with Ollama.")
        return md_text # Return original text if config is not available

    try:
        logger.info(f"Attempting to initialize Ollama client at {OLLAMA_API_BASE} for reformatting with model {OLLAMA_REFORMAT_MODEL}...")
        client = ollama.Client(host=OLLAMA_API_BASE)
        logger.info(f"Ollama client initialized successfully for reformatting at {OLLAMA_API_BASE} using model {OLLAMA_REFORMAT_MODEL}.")
    except Exception as e:
        logger.error(f"Failed to initialize Ollama client: {e}. Skipping markdown reformatting.")
        return md_text

    # Reduce max chunk characters significantly for smaller models like Phi.
    # Old: MAX_CHUNK_CHARS = 18000
    # A 4096 token context window might handle ~12000-16000 characters of text (1 token ~ 3-4 chars).
    # System prompt is ~3000 chars (~750-1000 tokens).
    # So, for user content, aim for ~7000-8000 chars to leave room for prompt and output.
    MAX_CHUNK_CHARS = 7000 # Adjusted from 18000

    logger.info(f"Splitting markdown into chunks for Ollama reformatting (model: {OLLAMA_REFORMAT_MODEL}, max_chunk_size={MAX_CHUNK_CHARS})...")
    # Max chunks can be increased if documents are very long and this becomes a bottleneck
    # Increased max_chunks to prevent problematic recombination into overly large chunks.
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS, max_chunks=1000)
    logger.info(f"Markdown split into {len(chunks)} chunks.")

    reformatted_chunks = []
    
    # Enhanced System Prompt for Ollama with focus on paragraph breaks, headings, lists, and readability
    system_prompt = """You are an expert in Markdown formatting and text organization. Your task is to reformat the given Markdown text to significantly improve its readability, consistency, and structural organization.

**CRITICAL INSTRUCTIONS - ADHERE STRICTLY:**

1. **CONTENT PRESERVATION:** You MUST preserve ALL original text content VERBATIM. This includes all words, sentences, paragraphs, headings, list items, code within code blocks, table cell content, etc. Do NOT summarize, expand, rephrase, or change the meaning of ANY content.

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

6. **EXACT IMAGE LINK PRESERVATION:** Image links (e.g., `![](path/to/image.png)` or `![alt text](path/to/image.png)`) MUST be preserved EXACTLY as they appear in the input. Do not modify paths, alt text, or the link syntax in any way.

7. **STANDARD MARKDOWN SYNTAX:** Ensure all output uses standard, common Markdown syntax. If you encounter malformed or non-standard syntax in the input, correct it to standard Markdown while preserving the original intent and content.

8. **TABLES:** If Markdown tables are present, ensure they are correctly formatted using standard Markdown table syntax (pipes and hyphens). Preserve all table content.

9. **CODE BLOCKS:** Preserve code blocks and inline code exactly as they appear. Ensure proper triple backticks and language specifiers if present.

10. **OUTPUT FORMAT:** Your entire output MUST be ONLY the reformatted Markdown text. Do NOT include any conversational text, apologies, explanations, or any text before or after the Markdown content. **Specifically, do NOT wrap the entire output in a Markdown code block (e.g., using ```markdown ... ``` or ``` ... ```).**

Reformat the following Markdown text according to these strict instructions:
"""

    logger.info(f"Starting Ollama reformatting loop for {len(chunks)} chunks using model {OLLAMA_REFORMAT_MODEL}.")
    strip_pattern = re.compile(r"^\s*```(?:markdown)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)

    for i, chunk in enumerate(chunks):
        if not chunk.strip(): # Skip empty or whitespace-only chunks
            reformatted_chunks.append(chunk)
            continue
        try:
            logger.info(f"Sending chunk {i+1}/{len(chunks)} to Ollama ({OLLAMA_REFORMAT_MODEL}). Length: {len(chunk)} characters.")
            protected_chunk, token_map = _protect_markdown_image_links(chunk)
            response = client.chat(
                model=OLLAMA_REFORMAT_MODEL,
                messages=[
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': protected_chunk } # Just the chunk, the instruction is in the system prompt
                ],
                options={
                    'temperature': 0.05, # Very low temperature for deterministic output
                    'num_predict': -1,    # Allow model to generate as much as needed (up to its context limit)
                    # Adjust context_length to a value appropriate for the model (e.g., phi models often have 2k or 4k context)
                    # Old: 'context_length': 52022,
                    'context_length': 20000, # Adjusted to a common context size for smaller models
                    # 'top_p': 0.5,       # Optional: Further restrict token choice if needed
                }
            )
            reformatted_chunk_raw = response['message']['content'] if response and 'message' in response and 'content' in response['message'] else ""
            
            # Strip ```markdown ... ``` wrappers
            match = strip_pattern.match(reformatted_chunk_raw)
            if match:
                reformatted_chunk = match.group(1).strip()
                logger.info(f"Stripped ```markdown wrapper from Ollama chunk {i+1}.")
            else:
                reformatted_chunk = reformatted_chunk_raw.strip() # Strip leading/trailing whitespace anyway
            reformatted_chunk = _restore_markdown_image_links(reformatted_chunk, token_map)
            
            # Basic validation: Check if the reformatted chunk is not empty if the original wasn't
            if not reformatted_chunk.strip() and chunk.strip():
                logger.warning(f"Ollama ({OLLAMA_REFORMAT_MODEL}) returned an empty reformatted chunk {i+1} for a non-empty original chunk (after potential stripping). USING ORIGINAL CHUNK.")
                reformatted_chunks.append(chunk)
            # Check for significant reduction in content, which might indicate over-summarization or errors by the LLM
            elif len(reformatted_chunk) < len(chunk) * 0.75 and len(chunk) > 200: # If shrunk by more than 25% for reasonably sized chunks
                logger.warning(f"Chunk {i+1} significantly shrunk after Ollama ({OLLAMA_REFORMAT_MODEL}) reformatting. Original: {len(chunk)}, Reformatted: {len(reformatted_chunk)}. USING ORIGINAL CHUNK.")
                reformatted_chunks.append(chunk) # Use original chunk if significantly shrunk
            else:
                reformatted_chunks.append(reformatted_chunk)
            logger.info(f"Received response for chunk {i+1}. Reformatted length: {len(reformatted_chunk)} characters.")

        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Ollama ({OLLAMA_REFORMAT_MODEL}): {e}", exc_info=True)
            logger.info(f"Appending original chunk {i+1} due to Ollama error. Length: {len(chunk)} characters.")
            reformatted_chunks.append(chunk)

    logger.info("Finished Ollama reformatting loop. Combining reformatted chunks...")
    combined_text = "\n\n".join(reformatted_chunks)
    logger.info(f"Ollama ({OLLAMA_REFORMAT_MODEL}) reformatting complete.")
    return combined_text


def split_markdown_into_chunks(md_text: str, max_chunk_size: int = 10000, max_chunks: int = 10) -> List[str]:
    """Split markdown text into chunks based on max_chunk_size and limit to max_chunks."""
    logger.info(f"Original md_text length: {len(md_text)} characters.")
    # Initial splitting based on max_chunk_size
    chunks = []
    current_chunk = ''

    # Split by lines first
    lines = md_text.split('\n')

    for line in lines:
        # Check if adding the current line plus a newline separator exceeds the max size
        # Add 1 for the potential newline character
        if len(current_chunk) + len(line) + 1 > max_chunk_size and current_chunk:
            chunks.append(current_chunk.strip())
            current_chunk = line
        else:
            # Add newline before the line if current_chunk is not empty
            current_chunk += ('\n' + line) if current_chunk else line

    # Add the last chunk if it's not empty
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    logger.info(f"Initial split resulted in {len(chunks)} chunks.")
    for i, chunk_item in enumerate(chunks):
        logger.info(f"Initial chunk {i} length: {len(chunk_item)} characters.")

    # If the number of chunks exceeds max_chunks, recombine them
    # This part aims to merge smaller chunks if the initial split was too granular
    if len(chunks) > max_chunks:
        logger.warning(f"Initial markdown split resulted in {len(chunks)} chunks, exceeding max_chunks {max_chunks}. Recombining...")
        combined_chunks = []
        current_chunk = ''
        chunk_count = 0

        # Calculate an approximate target length per chunk after combining
        total_length = sum(len(chunk) for chunk in chunks)
        avg_length = total_length // max_chunks if max_chunks > 0 else total_length # Avoid division by zero
        logger.info(f"Recombining: total_length={total_length}, avg_length_target_per_chunk={avg_length}")

        for chunk in chunks:
             # Check if adding the current chunk exceeds the average length AND we haven't reached the max chunk count yet
             # This heuristic tries to make chunks roughly equal, but respects the max_chunks limit
            if len(current_chunk) + len(chunk) + 1 > avg_length and chunk_count < max_chunks - 1:
                combined_chunks.append(current_chunk.strip())
                current_chunk = chunk
                chunk_count += 1
            else:
                current_chunk += ('\n\n' + chunk) if current_chunk else chunk # Use double newline for separation

        # Add the last combined chunk
        if current_chunk:
            combined_chunks.append(current_chunk.strip())

        # If after combining we still have more than max_chunks (shouldn't happen with the logic above, but as a safeguard)
        # or if the combining logic resulted in fewer than max_chunks, just use the combined list.
        # If combined_chunks is empty but original chunks wasn't, add the original text as a single chunk.
        if not combined_chunks and chunks:
             logger.warning("Recombination resulted in empty combined_chunks, falling back to single chunk of original text.")
             return [md_text] # Fallback to single chunk if combining failed

        chunks = combined_chunks
        logger.warning(f"Recombined into {len(chunks)} chunks.")
        for i, chunk_item in enumerate(chunks):
            logger.info(f"  Recombined chunk {i} length: {len(chunk_item)} characters.")


    # Final check to ensure no empty chunks are returned
    final_chunks = [chunk for chunk in chunks if chunk]
    logger.info(f"Returning {len(final_chunks)} final chunks.")
    return final_chunks


def reformat_markdown_with_gemini(md_text: str) -> str:
    """
    Reformats markdown text using the Google Gemini API.
    """
    if not GEMINI_API_KEY_REFORMAT:
        logger.warning("GEMINI_API_KEY not set (used for reformatting) or configuration failed. Skipping Gemini markdown reformatting.")
        return md_text

    if not gemini_reformat_client:
        logger.warning("Gemini reformat client not available. Skipping markdown reformatting.")
        return md_text

    # Approximate tokens per character (this is a rough estimate for Gemini)
    # Gemini models have larger context windows (e.g. gemini-2.5-flash).
    # However, processing very large single chunks can be slow or hit other limits.
    # Let's use a generous chunk character size, e.g., 100k characters.
    # Large context; aim for chunks well under the limit.
    # Let's aim for chunks well under this, e.g., ~200k characters.
    # 1 token ~ 4 chars. So 200k chars ~ 50k tokens.
    # Keep chunks moderate; very large chunks were often summarized instead of reformatted.
    MAX_CHUNK_CHARS_GEMINI = 40000

    logger.info(f"Splitting markdown into chunks for Gemini reformatting (max_chunk_size={MAX_CHUNK_CHARS_GEMINI})...")
    # Increased max_chunks to prevent problematic recombination into overly large chunks.
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS_GEMINI, max_chunks=1000)
    logger.info(f"Markdown split into {len(chunks)} chunks for Gemini.")

    reformatted_chunks = []
    gemini_config = _gemini_reformat_generate_config()
    strip_pattern = re.compile(r"^\s*```(?:markdown)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)

    logger.info(
        f"Starting Gemini reformatting loop for {len(chunks)} chunks "
        f"(timeout={PDF_GEMINI_REFORMAT_TIMEOUT_MS}ms, AFC disabled)..."
    )
    for i, chunk in enumerate(chunks):
        if not chunk.strip(): # Skip empty chunks
            reformatted_chunks.append(chunk)
            continue
        try:
            logger.info(f"Sending chunk {i+1}/{len(chunks)} to Gemini. Length: {len(chunk)} characters.")
            
            # Protect markdown image links so they survive model rewriting.
            protected_chunk, token_map = _protect_markdown_image_links(chunk)

            response = gemini_reformat_client.models.generate_content(
                model=GEMINI_REFORMAT_MODEL_NAME,
                contents=protected_chunk,
                config=gemini_config,
            )
            
            reformatted_chunk_raw = _extract_gemini_response_text(response)
            
            # Strip ```markdown ... ``` wrappers
            match = strip_pattern.match(reformatted_chunk_raw)
            if match:
                reformatted_chunk = match.group(1).strip()
                logger.info(f"Stripped ```markdown wrapper from Gemini chunk {i+1}.")
            else:
                reformatted_chunk = reformatted_chunk_raw.strip() # Strip leading/trailing whitespace anyway
            reformatted_chunk = _restore_markdown_image_links(reformatted_chunk, token_map)

            logger.info(f"Received response for chunk {i+1}. Reformatted length: {len(reformatted_chunk)} characters.")

            # Basic validation: Check if the reformatted chunk is not empty if the original wasn't
            if not reformatted_chunk.strip() and chunk.strip():
                logger.warning(f"Gemini returned an empty reformatted chunk {i+1} for a non-empty original chunk. USING ORIGINAL CHUNK.")
                reformatted_chunks.append(chunk)
            # Check for significant reduction in content (standardized to 75% threshold, 200 char min like Ollama)
            elif len(reformatted_chunk) < len(chunk) * 0.75 and len(chunk) > 200:
                logger.warning(f"Gemini Chunk {i+1} significantly shrunk (reformatted < 75% of original). Original: {len(chunk)}, Reformatted: {len(reformatted_chunk)}. USING ORIGINAL CHUNK.")
                reformatted_chunks.append(chunk) # Use original chunk if significantly shrunk
            else:
                reformatted_chunks.append(reformatted_chunk)
        except Exception as e:
            logger.error(f"Error reformatting chunk {i+1} with Gemini: {e}", exc_info=True)
            # Fallback: return the original chunk if reformatting fails
            logger.info(f"Appending original chunk {i+1} due to Gemini error. Length: {len(chunk)} characters.")
            reformatted_chunks.append(chunk)

    logger.info("Finished Gemini reformatting loop. Combining reformatted chunks...")
    combined_text = "\n\n".join(reformatted_chunks) # Ensure good separation
    logger.info("Gemini reformatting complete.")
    return combined_text


# --- Text-only PDF extraction (no OCR) ---
def process_text_pdf(pdf_bytes: bytes) -> str:
    """Extract text from a PDF with an embedded text layer and return markdown-like content."""
    parts = []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            for i in range(len(doc)):
                page = doc[i]
                text = sanitize_extracted_text(page.get_text())
                if text.strip():
                    # Normalize whitespace; separate paragraphs by blank lines
                    blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
                    parts.append("\n\n".join(blocks))
            return "\n\n---\n\n".join(parts) if parts else ""
        finally:
            doc.close()
    except Exception as e:
        logger.error(f"process_text_pdf failed: {e}")
        raise


def process_pdf_bytes(pdf_bytes: bytes, sanitized_title: str) -> Tuple[str, List[List[str]]]:
    """Extract markdown and embedded images from a PDF document."""
    if PDF_OCR_ENGINE == "text-only":
        has_text = True
    elif PDF_OCR_ENGINE == "none":
        has_text = True
    else:
        has_text = pdf_has_text(pdf_bytes)

    image_heavy = pdf_is_image_heavy_scan(pdf_bytes)
    if PDF_EXTRACTION_BACKEND == "mineru" and not mineru_is_available():
        logger.warning(
            "PDF_EXTRACTION_BACKEND=mineru but MinerU is not installed in this environment; "
            "falling back to PaddleOCR/layout extraction."
        )
    use_mineru = PDF_EXTRACTION_BACKEND == "mineru" and mineru_is_available()
    use_scanned_pipeline = (not has_text) or image_heavy

    logger.info(
        "PDF routing: has_text=%s image_heavy=%s backend=%s mineru_available=%s "
        "scan_figure_engine=%s",
        has_text,
        image_heavy,
        PDF_EXTRACTION_BACKEND,
        mineru_is_available(),
        os.getenv("PDF_SCAN_FIGURE_ENGINE", "layout"),
    )

    scanned_images_per_page: List[List[str]] = []

    if use_mineru and use_scanned_pipeline:
        logger.info("Using MinerU for scanned/image-heavy PDF.")
        raw_md_text, scanned_images_per_page = process_pdf_with_mineru(
            pdf_bytes,
            sanitized_title=sanitized_title,
            app_images_path=APP_IMAGES_PATH or "",
        )
    elif use_scanned_pipeline and not has_text:
        logger.info("PDF appears scanned; using PaddleOCR for text.")
        raw_md_text, scanned_images_per_page = process_scanned_pdf_with_paddleocr(
            pdf_bytes,
            sanitized_title=sanitized_title,
            app_images_path=APP_IMAGES_PATH or "",
        )
    elif use_scanned_pipeline and has_text:
        logger.info(
            "PDF has OCR text layer but is image-heavy; using text extraction + layout figures."
        )
        raw_md_text = process_text_pdf(pdf_bytes)
        scanned_images_per_page = extract_layout_figures_from_pdf_pages(
            pdf_bytes,
            sanitized_title=sanitized_title,
            app_images_path=APP_IMAGES_PATH or "",
            dpi=PDF_PAGE_DPI,
        )
    else:
        logger.info("PDF has text layer; using text extraction (no OCR).")
        raw_md_text = process_text_pdf(pdf_bytes)

    # Always skip page-covering scan backgrounds; they are not figure assets.
    embedded_images_per_page = extract_pdf_images(
        pdf_bytes,
        sanitized_title,
        APP_IMAGES_PATH or "",
        skip_full_page_background=True,
    )

    if use_scanned_pipeline and not use_mineru:
        images_per_page: List[List[str]] = []
        page_count = max(len(embedded_images_per_page), len(scanned_images_per_page))
        for page_idx in range(page_count):
            merged: List[str] = []
            if page_idx < len(embedded_images_per_page):
                merged.extend(embedded_images_per_page[page_idx])
            if page_idx < len(scanned_images_per_page):
                merged.extend(scanned_images_per_page[page_idx])
            deduped = list(dict.fromkeys(name for name in merged if name))
            images_per_page.append(deduped)
        return raw_md_text, images_per_page

    if use_mineru:
        # MinerU markdown already contains image links; avoid duplicating via inject.
        return raw_md_text, scanned_images_per_page

    return raw_md_text, embedded_images_per_page


def process_document_bytes(
    source_bytes: bytes,
    source_extension: str,
    sanitized_title: str,
) -> Tuple[str, List[List[str]]]:
    """Route supported formats into markdown and optional per-page images."""
    ext = source_extension.lower()
    if ext == ".pdf":
        return process_pdf_bytes(source_bytes, sanitized_title)
    if ext == ".epub":
        return epub_bytes_to_markdown(source_bytes), []
    if ext in {".mobi", ".azw", ".azw3"}:
        epub_bytes = mobi_or_azw_to_epub_bytes(source_bytes, ext)
        return epub_bytes_to_markdown(epub_bytes), []
    if ext == ".docx":
        return docx_bytes_to_markdown(source_bytes), []
    if ext in {".html", ".htm"}:
        return html_bytes_to_markdown(source_bytes), []
    if ext == ".txt":
        return txt_bytes_to_markdown(source_bytes), []
    raise ValueError(f"Unsupported document format: {ext}")


# --- PaddleOCR singleton and scanned-PDF pipeline ---
_paddle_ocr_instance: Optional[Any] = None


def get_paddle_ocr(use_gpu: bool = True):
    """Lazy-initialize and return a single PaddleOCR instance (GPU or CPU)."""
    global _paddle_ocr_instance
    if PaddleOCR is None:
        raise RuntimeError("PaddleOCR is not available in this environment.")
    if _paddle_ocr_instance is None:
        # PaddleOCR 3.x uses device instead of use_gpu; show_log was removed.
        if use_gpu:
            device = resolve_paddle_device("PDF_OCR_DEVICE", default_gpu="gpu:0")
        else:
            device = "cpu"
        base_kwargs: dict = {
            "lang": PDF_OCR_LANG,
            "device": device,
        }
        # use_angle_cls may be unsupported in some 3.x releases; omit if it causes errors
        try:
            _paddle_ocr_instance = PaddleOCR(use_angle_cls=True, **base_kwargs)
        except ValueError as exc:
            if "Unknown argument: use_angle_cls" in str(exc):
                _paddle_ocr_instance = PaddleOCR(**base_kwargs)
            else:
                raise
    return _paddle_ocr_instance


def _ocr_results_to_markdown_page(lines_with_boxes: List[Tuple[List, Tuple[str, float]]]) -> str:
    """Convert one page's OCR result (list of (box, (text, conf))) into paragraph markdown."""
    if not lines_with_boxes:
        return ""
    # Sort by vertical position (y of centroid), then x
    def sort_key(item):
        box, (_text, _conf) = item
        pts = np.array(box)
        y = float(pts[:, 1].mean())
        x = float(pts[:, 0].mean())
        return (y, x)
    sorted_items = sorted(lines_with_boxes, key=sort_key)
    # Group into paragraphs by vertical gap (e.g. > 1.5 * typical line height)
    texts = []
    for _box, (text, conf) in sorted_items:
        cleaned = sanitize_extracted_text(text or "")
        if not cleaned:
            continue
        # Drop very low-confidence OCR lines to reduce gibberish/noise.
        if conf is not None and conf < 0.45:
            continue
        texts.append(cleaned)
    if not texts:
        return ""
    return "\n\n".join(texts)


def process_scanned_pdf_with_paddleocr(
    pdf_bytes: bytes,
    sanitized_title: str,
    app_images_path: str,
) -> Tuple[str, List[List[str]]]:
    """Render PDF to images, run OCR, and crop likely figure images from scanned pages."""
    dpi = PDF_PAGE_DPI
    images = pdf_to_page_images(pdf_bytes, dpi=dpi)
    if not images:
        return "", []
    use_gpu = PDF_OCR_ENGINE == "paddle"
    ocr_engine = get_paddle_ocr(use_gpu=use_gpu)
    page_markdowns = []
    scanned_images_per_page: List[List[str]] = []
    for i, img in enumerate(images):
        try:
            result = ocr_engine.ocr(img, cls=True)
            if not result or not result[0]:
                page_markdowns.append("")
                scanned_images_per_page.append([])
                continue
            lines = result[0]
            page_markdowns.append(_ocr_results_to_markdown_page(lines))
            scanned_images_per_page.append(
                extract_scanned_page_figures(
                    page_img=img,
                    lines_with_boxes=lines,
                    sanitized_title=sanitized_title,
                    page_num=i,
                    app_images_path=app_images_path,
                    sanitize_text=sanitize_extracted_text,
                )
            )
        except Exception as e:
            logger.warning(f"PaddleOCR failed for page {i + 1}: {e}")
            page_markdowns.append("")
            scanned_images_per_page.append([])
    return "\n\n---\n\n".join(page_markdowns), scanned_images_per_page


# Serialise heavy MinerU/Paddle jobs so the API event loop stays responsive for new uploads.
_document_processing_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="pdf-document-job",
)


def _extract_and_merge_document_sync(
    temp_input_path: str,
    source_filename: str,
    sanitized_title: str,
    job_id: str,
) -> Tuple[str, List[Dict[str, str]]]:
    """
    Blocking document extraction + page merge. Runs off the asyncio event loop so
    /process-pdf can accept new uploads while MinerU/Paddle work continues.
    """
    source_extension = detect_document_extension(source_filename)
    logger.info(
        "Job %s: Reading source bytes from %s (format=%s, filename=%s)...",
        job_id,
        temp_input_path,
        source_extension,
        source_filename,
    )
    with open(temp_input_path, "rb") as f:
        source_bytes = f.read()
    logger.info("Job %s: Source bytes read successfully.", job_id)

    raw_md_text_from_pipe, images_per_page = process_document_bytes(
        source_bytes,
        source_extension,
        sanitized_title,
    )

    callback_images: List[Dict[str, str]] = []
    total_images = sum(len(imgs) for imgs in images_per_page)
    if total_images > 0:
        logger.info("Job %s: Extracted %s images from source document.", job_id, total_images)
        raw_md_text_from_pipe = inject_image_links_into_markdown(
            raw_md_text_from_pipe,
            images_per_page,
            web_image_base_path="/images/app",
            page_separator="\n\n---\n\n",
        )
        callback_images = [
            {"filename": name, "path": f"/images/app/{name}"}
            for page_images in images_per_page
            for name in page_images
            if name
        ]
        logger.info(
            "Job %s: Prepared callback image metadata for %s images.",
            job_id,
            len(callback_images),
        )
    else:
        logger.info("Job %s: No extractable embedded raster images found.", job_id)

    if not raw_md_text_from_pipe.strip():
        raise RuntimeError(
            f"Document extraction produced no markdown content for '{source_filename}'."
        )

    logger.info(
        "Job %s: Raw markdown content. Length: %s chars.",
        job_id,
        len(raw_md_text_from_pipe),
    )

    raw_markdown_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}_raw.md")
    try:
        with open(raw_markdown_path, "w", encoding="utf-8") as raw_f:
            raw_f.write(raw_md_text_from_pipe)
        logger.info("Job %s: Saved raw markdown (pre-merge) to %s", job_id, raw_markdown_path)
    except Exception as e_raw_save:
        logger.error("Job %s: Failed to save raw markdown (pre-merge): %s", job_id, e_raw_save)

    num_original_pages_to_merge = 5
    page_separator_token = "\n\n---\n\n"
    page_separator_pattern = r"\n-{3,}\n"

    if num_original_pages_to_merge > 1 and raw_md_text_from_pipe.strip():
        logger.info(
            "Job %s: Attempting to merge %s original pages into one.",
            job_id,
            num_original_pages_to_merge,
        )
        original_pages = re.split(page_separator_pattern, raw_md_text_from_pipe)
        merged_content_parts = []
        for i in range(0, len(original_pages), num_original_pages_to_merge):
            chunk_to_merge = original_pages[i : i + num_original_pages_to_merge]
            merged_chunk = "\n\n".join(part.strip() for part in chunk_to_merge if part.strip())
            if merged_chunk:
                merged_content_parts.append(merged_chunk)

        if merged_content_parts:
            md_text_for_reformatting = page_separator_token.join(merged_content_parts)
            logger.info(
                "Job %s: Page merging complete. New length: %s chars. "
                "Original sections: %s, New sections: %s",
                job_id,
                len(md_text_for_reformatting),
                len(original_pages),
                len(merged_content_parts),
            )
        else:
            md_text_for_reformatting = raw_md_text_from_pipe
            logger.info(
                "Job %s: Page merging resulted in no content, using original raw markdown.",
                job_id,
            )
    else:
        md_text_for_reformatting = raw_md_text_from_pipe
        logger.info(
            "Job %s: Page merging skipped (NUM_ORIGINAL_PAGES_TO_MERGE <= 1 or empty input).",
            job_id,
        )

    return md_text_for_reformatting, callback_images


# --- Background task function for PDF processing ---
async def perform_pdf_processing(
    job_id: str,
    temp_input_path: str,
    sanitized_title: str,
    source_filename: str,
):
    """
    Performs the actual PDF processing in a background task and sends a callback.
    """
    logger.info(f"Job {job_id}: Starting background document processing for {temp_input_path}")

    # Initialize local variables for callback data
    callback_status = "processing" # Default status
    callback_message = "Processing started"
    callback_file_path = None
    processing_error_detail = None
    callback_images: List[Dict[str, str]] = []

    try:
        md_text_for_reformatting, callback_images = await asyncio.get_running_loop().run_in_executor(
            _document_processing_executor,
            _extract_and_merge_document_sync,
            temp_input_path,
            source_filename,
            sanitized_title,
            job_id,
        )

        # Reformat markdown using the potentially merged text (blocking LLM calls in a thread)
        reformatted_md_text = ""
        if GEMINI_API_KEY_REFORMAT: # Check if Gemini API key is available and configured
            logger.info(f"Job {job_id}: Attempting markdown reformatting with Google Gemini...")
            reformatted_md_text = await asyncio.to_thread(
                reformat_markdown_with_gemini, md_text_for_reformatting
            )
        elif OLLAMA_API_BASE and OLLAMA_REFORMAT_MODEL: # Fallback to Ollama if configured
            logger.info(f"Job {job_id}: Gemini not available/configured. Attempting markdown reformatting with Ollama...")
            reformatted_md_text = await asyncio.to_thread(
                reformat_markdown_with_ollama, md_text_for_reformatting
            )
        else:
            logger.warning(f"Job {job_id}: Neither Gemini nor Ollama reformatting services are configured. Using raw markdown.")
            reformatted_md_text = md_text_for_reformatting
        
        logger.info(f"Job {job_id}: Markdown reformatting process chosen. Result length: {len(reformatted_md_text)} chars.")

        # Keep a narrow backward-compatibility rewrite only for legacy absolute paths.
        if APP_IMAGES_PATH and isinstance(reformatted_md_text, str):
            reformatted_md_text = reformatted_md_text.replace(APP_IMAGES_PATH, "/images/app")

        # Save markdown content to a file using the sanitized title
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{sanitized_title}.md")
        logger.info(f"Job {job_id}: Preparing to save final (paths rewritten) markdown to: {markdown_file_path}")

        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text) # This now contains web-ready paths

        logger.info(f"Job {job_id}: Final markdown saved.")
        logger.info(f"Job {job_id}: Document processed and converted to markdown successfully")

        # Update local variables for successful callback
        callback_status = "completed"
        callback_message = "Processing complete"
        callback_file_path = markdown_file_path

    except Exception as e:
        logger.error(f"Job {job_id}: Error during background PDF processing: {e}", exc_info=True)
        # Update local variables for failed callback
        callback_status = "failed"
        callback_message = f"Processing failed: {str(e)}"
        processing_error_detail = str(e)
    finally:
        # Cleanup temporary file regardless of success or failure
        try:
            if os.path.exists(temp_input_path):
                os.remove(temp_input_path)
                logger.info(f"Job {job_id}: Cleaned up temporary file: {temp_input_path}")
        except Exception as e:
            logger.error(f"Job {job_id}: Failed to cleanup temp file {temp_input_path}: {e}")

    # Prepare and send callback
    logger.info(f"Job {job_id}: Attempting to send callback to backend with status: {callback_status}")

    
    if not BACKEND_CALLBACK_URL:
        logger.error(f"Job {job_id}: BACKEND_CALLBACK_URL is not set. Cannot send callback.")
    else:
        callback_url = f"{BACKEND_CALLBACK_URL}" 

        # Prepare data for the callback using local variables
        callback_data = {
            "job_id": job_id,
            "status": callback_status,
            "message": callback_message,
            "processing_error": processing_error_detail, # This will be None if status is not 'failed'
        }

        if callback_status == "completed":
            callback_data["file_path"] = callback_file_path
            callback_data["images"] = callback_images
        
        try:
            response = await asyncio.to_thread(
                requests.post, callback_url, json=callback_data, timeout=60
            )
            response.raise_for_status() # Raise an exception for bad status codes
            logger.info(f"Job {job_id}: Callback sent successfully to {callback_url}. Backend response status: {response.status_code}")
        except requests.exceptions.RequestException as e:
            logger.error(f"Job {job_id}: Failed to send callback to backend {callback_url}: {e}")
        except Exception as e:
            logger.error(f"Job {job_id}: An unexpected error occurred while sending callback: {e}", exc_info=True)


@app.post("/process-pdf", response_model=ProcessResponse)
async def process_pdf(
    background_tasks: BackgroundTasks, # Inject BackgroundTasks
    file: UploadFile = File(...),
    title: Optional[str] = None
):
    """
    Receives a supported document file, saves it temporarily, starts a background processing task,
    and immediately returns a job ID and status.
    """
    logger.info(f"Received request to process document: {file.filename}")
    job_id = str(uuid.uuid4()) # Generate a unique job ID
    base_title = title if title else os.path.splitext(file.filename)[0]
    sanitized_title = sanitize_filename(base_title)
    source_filename = file.filename or "upload.pdf"

    try:
        source_extension = detect_document_extension(source_filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    logger.info(
        f"Created job {job_id} for file {source_filename} "
        f"(format={source_extension}) with sanitized title {sanitized_title}"
    )

    # Save uploaded file using a job-scoped name to avoid collisions.
    safe_upload_name = sanitize_filename(source_filename) or f"upload{source_extension}"
    temp_filename = f"{job_id}_{safe_upload_name}"
    temp_path = os.path.join(PDF_STORAGE_PATH, temp_filename)
    logger.info(f"Job {job_id}: Saving temporary file to: {temp_path}")
    try:
        await file.seek(0)
        with open(temp_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        logger.info(f"Job {job_id}: Temporary file saved: {temp_path}")
    except Exception as e:
        logger.error(f"Job {job_id}: Failed to save temporary file {temp_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save temporary file: {e}")

    # Add the processing task to background tasks
    background_tasks.add_task(
        perform_pdf_processing,
        job_id,
        temp_path,
        sanitized_title,
        source_filename,
    )
    logger.info(f"Job {job_id}: Added background task for processing.")

    # Return immediate response with job ID
    return ProcessResponse(
        success=True,
        message="Processing job started",
        job_id=job_id,
        status="pending" 
    )

# --- Removed /status/{job_id} endpoint and its associated StatusResponse model ---

if __name__ == "__main__":
    import uvicorn
    # Ensure env vars are loaded before running uvicorn when running directly
    # load_dotenv() # REMOVE this line from here - it's now at the top level
    # Re-ensure paths in case running directly
    try:
        ensure_storage_paths()
    except Exception as e:
        logger.critical(f"Failed to initialize storage paths before running server: {e}")
        sys.exit(1)
    
    if not BACKEND_CALLBACK_URL:
        logger.warning("BACKEND_CALLBACK_URL environment variable is not set. Callbacks will not be sent.")


    port = int(os.getenv("PORT", "8502"))
    uvicorn.run(app, host="0.0.0.0", port=port)
