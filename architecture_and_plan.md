# Reading Pal Application: Architecture Document

**1. Overview**

The Reading Pal application is a web-based platform designed to enhance the reading experience of PDF documents by integrating Large Language Model (LLM) capabilities. It features a dual-pane interface for synchronized reading and note-taking, leveraging a separate PDF processing service and interacting with various LLM providers.

**2. High-Level Architecture**

The system follows a microservice-oriented approach, primarily consisting of:

*   **Frontend:** A React application providing the user interface.
*   **Backend:** A Python application serving as the API gateway and orchestrating interactions between the Frontend, Database, PDF Service, and LLM Services.
*   **PDF Service:** A separate Python service responsible for processing PDF files into Markdown and extracting images.
*   **LLM Services:** External or internal services providing LLM capabilities (summarization, Q&A, etc.).
*   **Database:** A MongoDB instance used for storing user data, notes, and book metadata.
    *Note: The MongoDB instance is expected to be running externally to the Docker Compose setup (e.g., on the host machine or a separate server) and accessible to the Backend service.*

```mermaid
graph LR
    User(User) --> Frontend(React Frontend);
    Frontend --> Backend(Python Backend API);
    Backend --> Database(MongoDB);
    Backend --> PDFService(PDF Processing Service);
    Backend --> LLMServices(LLM Services - Reading Assistance);
    PDFService --> LLMServicesPDF(LLM Services - Markdown Reformatting);
    PDFService --> Storage(File Storage: Markdown, Images);
    Backend --> Storage; %% Add connection from Backend to Storage for reading markdown/serving images
    Frontend --> StorageFrontend(File Storage: Images via Nginx); %% Add connection from Frontend to Storage via Nginx
```
*Note: The diagram shows two interactions with LLM Services to highlight the distinct purposes found in the code. The Backend now interacts directly with File Storage for reading markdown, and the Frontend interacts with File Storage (Images) via Nginx.*

**3. Component Details**

*   **Frontend (React):**
    *   Handles user interaction, rendering the UI.
    *   Displays processed book content (Markdown, Images).
    *   Provides the dual-pane view for book and notes.
    *   Manages synchronized scrolling between panes.
    *   Allows users to input notes and LLM prompts.
    *   Communicates with the Backend via REST APIs.
    *   Provides UI controls on the BookList page for renaming and deleting books (appearing on hover, with user confirmations).
    *   **Relies on Nginx (running in the same container) to serve static files and proxy API requests.**
*   **Backend (Python):**
    *   Acts as the central hub.
    *   Manages user authentication (if implemented later).
    *   Receives PDF uploads from the Frontend (`POST /api/books/upload`).
    *   Forwards the PDF file to the PDF Service's `/process-pdf` endpoint, receiving an immediate `job_id` and "pending" status. Creates a book record with this `job_id`.
    *   **Receives a callback from the PDF Service (`POST /api/books/callback`) with `job_id`, `status`, and the server-side path to the saved Markdown file (if successful).**
    *   **Updates book metadata in MongoDB, storing the filename of the processed Markdown file (derived from the received path). It does not receive or store a separate list of image filenames from the PDF service callback.**
    *   **Implements logic to read the markdown content from the file system using the stored filename and a configured base path (via volume mounts) when needed (e.g., for serving to the Frontend or providing context to LLMs).**
    *   **Relies on a static file server (e.g., Nginx in the frontend container) to serve images. The Markdown content contains web-relative image paths (e.g., `/images/image.png`) that the browser uses.**
    *   Provides APIs for the Frontend to:
        *   Upload PDFs.
        *   Fetch book content and metadata (including the markdown content string read from file). Image URLs are already embedded in the markdown.
        *   Fetch/Save/Update notes.
        *   Rename books (updating metadata and renaming the corresponding markdown file).
        *   Delete books (removing metadata and the markdown file. Deleting individual image files is complex as their names are not explicitly tracked from the PDF service callback).
        *   Send prompts to LLM Services for reading assistance.
    *   Communicates with LLM Services (configured via `.env`) for reading assistance tasks (summaries, Q&A).
    *   Retrieves LLM responses and potentially stores them or sends them to the Frontend.
*   **PDF Service (Python - FastAPI):**
    *   A standalone FastAPI service.
    *   Receives PDF files via a `/process-pdf` endpoint (`UploadFile`).
    *   Saves the uploaded PDF temporarily to `PDF_STORAGE_PATH`.
    *   Uses the `magic_pdf` library (`OCRPipe`) to process the PDF, extract text, and identify images.
    *   Extracts images and saves them to the configured `IMAGES_PATH`.
    *   Generates initial Markdown content and then reformats it using a configured LLM (Gemini preferred, fallback to Ollama).
    *   **Rewrites image paths within the Markdown content to be web-accessible (e.g., `/images/image_name.png`) before saving.**
    *   Saves the final reformatted Markdown content **to a file** in the configured `MARKDOWN_PATH`.
    *   Cleans up the temporary input PDF file.
    *   **Sends a callback to the `BACKEND_CALLBACK_URL` with `job_id`, `status`, the server-side path to the saved Markdown file (if successful), and error details (if any). It does not send a separate list of image filenames in this callback.**
    *   Requires access to specific, configured absolute file storage paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`).
*   **LLM Services:**
    *   **Reading Assistance LLMs:** External APIs (Anthropic, DeepSeek, Gemini) or local services (Ollama) as configured in `.env` (`LLM_SERVICE`, `LLM_MODEL`). Used by the **Backend** for user-initiated tasks like summarization and Q&A.
    *   **Markdown Reformatting LLM:** Anthropic Claude or Ollama, configured via `.env` (`ANTHROPIC_API_KEY` or `OLLAMA_API_BASE`/`OLLAMA_REFORMAT_MODEL`). Used *internally* by the **PDF Service** during the processing pipeline.
    *   Receive prompts and relevant context (book passages, **read from the markdown file by the Backend**) from the component interacting with them.
    *   Return generated text.
*   **Database (MongoDB):**
    *   Stores structured and unstructured data.
    *   Primary data entities:
        *   Books (metadata: title, original filename, processed status, **job_id**, **sanitized_title**, **the filename of the processed Markdown file**, **created_at**, **updated_at**, **processing_error**). Image paths are embedded within the markdown file. Note: `_id` is the MongoDB primary key, aliased to `id` in the backend model.
        *   Notes (content, timestamp, reference to book section/page, link to LLM interaction if applicable, **scroll_percentage**).
        *   Users (if authentication is added).

**4. Data Flow Examples**

*   **PDF Upload & Processing:**
    1.  User uploads PDF via Frontend.
    2.  Frontend sends PDF file to Backend API (`POST /upload-pdf`).
    3.  **Backend forwards the PDF file to the PDF Service's `/process-pdf` endpoint. PDF Service immediately returns a `job_id` and "pending" status. Backend creates a book record in MongoDB with this `job_id` and status.**
    4.  PDF Service processes the file asynchronously: saves it temporarily, uses `magic_pdf`, extracts/saves images, generates Markdown, reformats Markdown (rewriting image paths to be web-relative like `/images/...`), saves the final Markdown to a file, and cleans up the temporary input file.
    5.  **Upon completion/failure, PDF Service sends a callback (POST request) to the Backend's configured callback URL (e.g., `/api/books/callback`) containing the `job_id`, final `status`, and `file_path` (path to the saved markdown file, if successful).**
    6.  **Backend receives the callback, updates the corresponding book record in MongoDB with the new status and the markdown filename (derived from `file_path`).**
    7.  The Frontend UI (book list) reflects the updated status (e.g., 'completed' or 'failed').
    8.  Frontend fetches book content from Backend API (`GET /book/{book_id}`).
    9.  **Backend retrieves the markdown filename from MongoDB, reads the markdown content string from the file system. This markdown string already contains web-relative image paths (e.g., `/images/image.png`). Backend returns the markdown content string.**
    10. **Frontend displays the Markdown content. The browser renders images by making requests to these `/images/...` paths, which are served by a static file server (e.g., Nginx).**
*   **LLM Interaction (e.g., Summarize Passage):**
    1.  User selects text in the book pane and clicks "Summarize" in the Frontend.
    2.  Frontend sends the selected text and book context (book ID, section) to Backend API (`POST /llm/summarize`).
    3.  **Backend retrieves the markdown filename from the book's metadata in MongoDB.**
    4.  **Backend reads the full markdown content or relevant sections from the markdown file using the stored filename and a configured base path (via volume mounts).**
    5.  Backend calls the appropriate **Reading Assistance** LLM Service API with the prompt and context (derived from the markdown content).
    6.  LLM Service processes the request and returns a summary.
    7.  Backend receives the summary.
    8.  Backend can optionally save the interaction/summary as a special type of note in MongoDB.
    9.  Backend sends the summary back to the Frontend.
    10. Frontend displays the summary (e.g., in the notes pane).

**5. Technology Stack**

*   **Frontend:** React, HTML, CSS/JavaScript, **Nginx (for serving static files and proxying API)**
*   **Backend:** Python (e.g., FastAPI or Flask), Requests library, PyMongo (MongoDB driver), **Relies on Nginx for static file serving**, **File system access for managing markdown and image files (reading, renaming, deleting via volume mounts).**
*   **PDF Service:** Python (FastAPI), `magic_pdf`, LLM client library (Anthropic or Ollama)
*   **Database:** MongoDB
*   **Configuration:** `.env` files

**6. Key Considerations**

*   **File Storage & Serving:**
    *   The PDF Service saves files to specific absolute paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`) on its host.
    *   The PDF Service callback returns the full server-side path for the markdown file. The markdown content itself has image paths rewritten to web-relative format (e.g., `/images/image.png`).
    *   **The Backend stores only the filename of the markdown file in MongoDB (derived from the path received in the callback). It does not store a separate list of image filenames from the PDF service.**
    *   **The Backend container and the Frontend (Nginx) container must have the `MARKDOWN_PATH` and `IMAGES_PATH` directories mounted as volumes to consistent paths (e.g., `/app/storage/markdown`, `/app/storage/images`).**
    *   **The Backend reads markdown files by joining its mounted `MARKDOWN_PATH` with the stored markdown filename.**
    *   **A static file server (e.g., Nginx in the frontend container) serves images by mapping a public URL prefix (e.g., `/images/`) to its mounted `IMAGES_PATH`. The browser requests images using paths found in the markdown.**
*   **File Management for Book Operations:** Renaming a book involves renaming its markdown file. Deleting a book involves deleting its markdown file. Deleting associated image files is challenging because their individual names are not explicitly tracked by the backend (as they are not part of the PDF service callback) and are typically stored in a shared directory. Robust deletion of images would require changes to how image metadata is passed or how images are stored (e.g., in book-specific subdirectories).
*   **Dual LLM Usage:** Be mindful of the two distinct uses of LLMs: one within the PDF Service for internal reformatting, and one orchestrated by the Backend for user-facing reading assistance. They may use different providers/models. The Markdown reformatting LLM configuration is now flexible (Anthropic or Ollama).
*   **PDF Service Communication:** The Backend calls the PDF Service's `/process-pdf` endpoint (sending file data via multipart form data) and receives an immediate `job_id`. The PDF Service later sends an asynchronous callback to the `BACKEND_CALLBACK_URL`.
*   **Synchronization:** Implementing smooth and accurate synchronized scrolling between potentially different content types (Markdown vs. editable notes) is crucial. The implementation now includes saving **scroll_percentage** with notes and clicking notes to jump to location.
*   **Scalability:** Consider potential bottlenecks, especially in PDF processing and LLM interactions. The separate PDF service helps distribute load. Reading markdown files from disk on demand might introduce I/O bottlenecks if not handled efficiently, especially for large files or high concurrency.
*   **Error Handling:** Robust error handling is needed for file uploads, PDF processing failures, LLM API errors, database issues, and **file system access errors (e.g., when reading, renaming, or deleting files).**

---
