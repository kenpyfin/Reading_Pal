import os
import logging
import sys
from typing import Optional, List
from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
import torch
from dotenv import load_dotenv
from magic_pdf.data.data_reader_writer import FileBasedDataWriter, FileBasedDataReader
from magic_pdf.config.make_content_config import DropMode, MakeMode
from magic_pdf.pipe.OCRPipe import OCRPipe
from torch.cuda.amp import autocast

# Initialize FastAPI app
app = FastAPI(title="PDF Processing Service")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
if __name__ == "__main__":
    load_dotenv()

# Get paths from environment variables
PDF_STORAGE_PATH = os.getenv('PDF_STORAGE_PATH')
MARKDOWN_PATH = os.getenv('MARKDOWN_PATH')
IMAGES_PATH = os.getenv('IMAGES_PATH')

def ensure_storage_paths():
    """Ensure all required storage directories exist with proper permissions"""
    paths = [PDF_STORAGE_PATH, MARKDOWN_PATH, IMAGES_PATH]
    for path in paths:
        try:
            os.makedirs(path, exist_ok=True)
            os.chmod(path, 0o755)
            logger.info(f"Storage directory ensured: {path}")
        except Exception as e:
            logger.error(f"Error creating/configuring directory {path}: {e}")
            raise RuntimeError(f"Failed to setup storage directory {path}: {e}")

# Ensure storage paths with error handling
try:
    ensure_storage_paths()
except Exception as e:
    logger.critical(f"Failed to initialize storage paths: {e}")
    sys.exit(1)

class ImageInfo(BaseModel):
    filename: str
    path: str

class ProcessResponse(BaseModel):
    success: bool
    message: str
    title: str
    markdown_content: Optional[str] = None
    images: Optional[List[ImageInfo]] = None
    file_path: str

def reformat_markdown_with_claude(md_text):
    from anthropic import Anthropic
    
    # Approximate tokens per character (this is a rough estimate)
    TOKENS_PER_CHAR = 0.25
    # Leave room for system prompt and other message components
    MAX_CHUNK_CHARS = int((4096 * 0.8) / TOKENS_PER_CHAR)  # Using 80% of max tokens
    
    client = Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    chunks = split_markdown_into_chunks(md_text, max_chunk_size=MAX_CHUNK_CHARS)
    reformatted_chunks = []
    system_prompt = "You are a helpful assistant that reformats markdown text to be more readable and consistent. Only output the reformatted markdown without any other words."

    for chunk in chunks:
        try:
            message = client.messages.create(
                model="claude-3-haiku-20240307",
                max_tokens=4096,
                system=system_prompt,
                messages=[
                    {
                        "role": "user",
                        "content": f"Please reformat this markdown text to be more readable without adding or deleting a single word:\n\n{chunk}"
                    }
                ]
            )
            reformatted_chunk = message.content[0].text if message.content else ""
            reformatted_chunks.append(reformatted_chunk)
        except Exception as e:
            logger.error(f"Error reformatting chunk: {e}")
            # Fallback: return the original chunk if reformatting fails
            reformatted_chunks.append(chunk)
    
    # Combine all reformatted chunks
    return "\n\n".join(reformatted_chunks)

def split_markdown_into_chunks(md_text: str, max_chunk_size: int = 10000, max_chunks: int = 10) -> List[str]:
    """Split markdown text into chunks based on max_chunk_size and limit to max_chunks."""
    # Initial splitting based on max_chunk_size
    chunks = []
    current_chunk = ''
    
    for line in md_text.split('\n'):
        if len(current_chunk) + len(line) + 1 > max_chunk_size:
            chunks.append(current_chunk.strip())
            current_chunk = line
        else:
            current_chunk += '\n' + line if current_chunk else line
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    # If the number of chunks exceeds max_chunks, recombine them
    if len(chunks) > max_chunks:
        combined_chunks = []
        total_length = sum(len(chunk) for chunk in chunks)
        avg_length = total_length // max_chunks
        current_chunk = ''
        chunk_count = 0
        
        for chunk in chunks:
            if len(current_chunk) + len(chunk) + 1 > avg_length and chunk_count < max_chunks - 1:
                combined_chunks.append(current_chunk.strip())
                current_chunk = chunk
                chunk_count += 1
            else:
                current_chunk += '\n' + chunk if current_chunk else chunk
        if current_chunk:
            combined_chunks.append(current_chunk.strip())
        chunks = combined_chunks
    
    return chunks

def process_pdf_to_markdown(file_path: str, title: str) -> Optional[str]:
    """Process PDF using OCRPipe and convert to markdown format."""
    try:
        # Read PDF bytes
        reader = FileBasedDataReader("")
        pdf_bytes = reader.read(file_path)

        # Configure CUDA if available
        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
            torch.backends.cudnn.benchmark = True
            torch.backends.cudnn.enabled = True
            torch.set_default_dtype(torch.float32)
            torch.set_default_tensor_type(torch.cuda.FloatTensor)

        # Initialize and run OCR pipeline
        with autocast(dtype=torch.float16):
            model_list = []
            image_writer = FileBasedDataWriter(IMAGES_PATH)
            pipe = OCRPipe(pdf_bytes, model_list, image_writer)
            pipe.pipe_classify()
            pipe.pipe_analyze()
            pipe.pipe_parse()

            # Generate markdown content
            md_content = pipe.pipe_mk_markdown(
                IMAGES_PATH,
                drop_mode=DropMode.NONE,
                md_make_mode=MakeMode.MM_MD
            )

        # Get the file name and determine title
        if not title:
            file_name = os.path.basename(file_path)
            title = os.path.splitext(file_name)[0]
            
        # Save markdown content to a file
        markdown_file_path = os.path.join(MARKDOWN_PATH, f"{title}.md")
        if isinstance(md_content, list):
            md_text = "\n".join(md_content)
        else:
            md_text = md_content

        reformatted_md_text = reformat_markdown_with_claude(md_text)    
        with open(markdown_file_path, 'w', encoding='utf-8') as f:
            f.write(reformatted_md_text)

        logger.info("PDF processed and converted to markdown successfully")
        return reformatted_md_text
    except Exception as e:
        logger.error(f"Error in process_pdf_to_markdown: {e}")
        return None

@app.post("/process-pdf", response_model=ProcessResponse)
async def process_pdf(
    file: UploadFile = File(...),
    title: Optional[str] = None
):
    """
    Process a PDF file and convert it to markdown format
    """
    try:
        # Save uploaded file temporarily
        temp_path = os.path.join(PDF_STORAGE_PATH, file.filename)
        with open(temp_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)

        # Generate unique title if not provided
        if not title:
            title = os.path.splitext(file.filename)[0]

        # Process PDF and get markdown content
        markdown_content = process_pdf_to_markdown(temp_path, title)
        
        if not markdown_content:
            raise HTTPException(status_code=500, detail="Failed to process PDF")

        # Save markdown content
        markdown_path = os.path.join(MARKDOWN_PATH, f"{title}.md")
        with open(markdown_path, 'w', encoding='utf-8') as f:
            f.write(markdown_content)

        # Cleanup temporary file
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception as e:
            logger.error(f"Failed to cleanup temp file {temp_path}: {e}")

        # Get list of generated images
        images = []
        if os.path.exists(IMAGES_PATH):
            image_prefix = title
            for img_file in os.listdir(IMAGES_PATH):
                if img_file.startswith(image_prefix) and img_file.endswith('.png'):
                    images.append(ImageInfo(
                        filename=img_file,
                        path=os.path.join(IMAGES_PATH, img_file)
                    ))

        return ProcessResponse(
            success=True,
            message="PDF processed successfully",
            title=title,
            markdown_content=markdown_content,
            images=images,
            file_path=markdown_path
        )

    except Exception as e:
        logger.error(f"Error processing PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8502)
