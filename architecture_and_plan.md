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
    *   **Relies on Nginx (running in the same container) to serve static files and proxy API requests.**
*   **Backend (Python):**
    *   Acts as the central hub.
    *   Manages user authentication (if implemented later).
    *   Receives PDF uploads from the Frontend.
    *   **Forwards the PDF file content (read from the `UploadFile` and sent via multipart form data) to the PDF Service's `/process-pdf` endpoint.**
    *   **Receives processed data (server-side markdown file path, list of server-side image info including paths and filenames) from the PDF Service.**
    *   **Stores book metadata, the filename of the processed markdown file, and the filenames of the extracted images in MongoDB.**
    *   **Implements logic to read the markdown content from the file system using the stored filename and a configured base path (via volume mounts) when needed (e.g., for serving to the Frontend or providing context to LLMs).**
    *   **Relies on the frontend's Nginx proxy to serve images statically from the shared `IMAGES_PATH` volume mount.**
    *   Provides APIs for the Frontend to:
        *   Upload PDFs.
        *   Fetch book content and metadata (including the markdown content string read from file, and image URLs derived from stored filenames).
        *   Fetch/Save/Update notes.
        *   Send prompts to LLM Services for reading assistance.
    *   Communicates with LLM Services (configured via `.env`) for reading assistance tasks (summaries, Q&A).
    *   Retrieves LLM responses and potentially stores them or sends them to the Frontend.
*   **PDF Service (Python - FastAPI):**
    *   A standalone FastAPI service.
    *   Receives PDF files via a `/process-pdf` endpoint (`UploadFile`).
    *   Saves the uploaded PDF temporarily to `PDF_STORAGE_PATH`.
    *   Uses the `magic_pdf` library (`OCRPipe`) to process the PDF, extract text, and identify images.
    *   Extracts images and saves them to the configured `IMAGES_PATH`.
    *   Generates initial Markdown content.
    *   Uses an LLM (Anthropic Claude or Ollama, configured via `.env`) specifically to reformat the generated Markdown text for readability.
    *   Saves the final reformatted Markdown content **to a file** in the configured `MARKDOWN_PATH`.
    *   Cleans up the temporary input PDF file.
    *   **Returns the server-side path to the saved markdown file, a list of image info (including server-side path and filename) for saved images, and other metadata in a JSON response.**
    *   Requires access to specific, configured absolute file storage paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`).
*   **LLM Services:**
    *   **Reading Assistance LLMs:** External APIs (Anthropic, DeepSeek, Gemini) or local services (Ollama) as configured in `.env` (`LLM_SERVICE`, `LLM_MODEL`). Used by the **Backend** for user-initiated tasks like summarization and Q&A.
    *   **Markdown Reformatting LLM:** Anthropic Claude or Ollama, configured via `.env` (`ANTHROPIC_API_KEY` or `OLLAMA_API_BASE`/`OLLAMA_REFORMAT_MODEL`). Used *internally* by the **PDF Service** during the processing pipeline.
    *   Receive prompts and relevant context (book passages, **read from the markdown file by the Backend**) from the component interacting with them.
    *   Return generated text.
*   **Database (MongoDB):**
    *   Stores structured and unstructured data.
    *   Primary data entities:
        *   Books (metadata: title, original filename, processed status, **job_id**, **sanitized_title**, **the filename of the processed Markdown file**, **list of filenames for extracted images**, **created_at**, **updated_at**, **processing_error**). Note: `_id` is the MongoDB primary key, aliased to `id` in the backend model.
        *   Notes (content, timestamp, reference to book section/page, link to LLM interaction if applicable, **scroll_percentage**).
        *   Users (if authentication is added).

**4. Data Flow Examples**

*   **PDF Upload & Processing:**
    1.  User uploads PDF via Frontend.
    2.  Frontend sends PDF file to Backend API (`POST /upload-pdf`).
    3.  **Backend forwards the PDF file content (read from the `UploadFile` and sent via multipart form data) to the PDF Service's `/process-pdf` endpoint.**
    4.  PDF Service receives the file, saves it temporarily, processes it using `magic_pdf`, extracts/saves images, generates Markdown, reformats Markdown using the configured LLM, saves the reformatted Markdown content to a file, and cleans up the temporary file.
    5.  **PDF Service returns the server-side path to the saved markdown file and a list of image info (including server-side path and filename) to the Backend.**
    6.  **Backend saves book metadata, the filename extracted from the received markdown file path, and the filenames extracted from the received image info in MongoDB.**
    7.  Backend signals Frontend that processing is complete and provides book ID.
    8.  Frontend fetches book content from Backend API (`GET /book/{book_id}`).
    9.  **Backend retrieves the markdown filename and image filenames from MongoDB, reads the markdown content string from the file system using the stored filename and a configured base path (via volume mounts), converts image filenames to public URLs (e.g., `/images/{filename}`), and returns the markdown content string and image URLs to the Frontend.**
    10. **Frontend displays the Markdown content, using the provided image URLs to fetch images from the Frontend's Nginx static route.**
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
*   **Backend:** Python (e.g., FastAPI or Flask), Requests library, PyMongo (MongoDB driver), **Relies on Nginx for static file serving**, **File system access for reading markdown files (via volume mounts)**
*   **PDF Service:** Python (FastAPI), `magic_pdf`, LLM client library (Anthropic or Ollama)
*   **Database:** MongoDB
*   **Configuration:** `.env` files

**6. Key Considerations**

*   **File Storage & Serving:**
    *   The PDF Service saves files to specific absolute paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`) on its host.
    *   The PDF Service returns the full path for the markdown file and a list of info (including filename and full path) for images.
    *   **The Backend stores only the filename of the markdown file and the filenames of the images in MongoDB.**
    *   **The Backend container and the Frontend (Nginx) container must have the `MARKDOWN_PATH` and `IMAGES_PATH` directories mounted as volumes to consistent paths (e.g., `/app/storage/markdown`, `/app/storage/images`).**
    *   **The Backend reads markdown files by joining its mounted `MARKDOWN_PATH` with the stored markdown filename.**
    *   **The Frontend's Nginx serves images statically by mapping the public `/images/` URL prefix to its mounted `IMAGES_PATH` using the stored image filenames.**
*   **Dual LLM Usage:** Be mindful of the two distinct uses of LLMs: one within the PDF Service for internal reformatting, and one orchestrated by the Backend for user-facing reading assistance. They may use different providers/models. The Markdown reformatting LLM configuration is now flexible (Anthropic or Ollama).
*   **PDF Service Communication:** The Backend needs to correctly format the request to the PDF Service's `/process-pdf` endpoint, including sending the file data **via multipart form data**.
*   **Synchronization:** Implementing smooth and accurate synchronized scrolling between potentially different content types (Markdown vs. editable notes) is crucial. The implementation now includes saving **scroll_percentage** with notes and clicking notes to jump to location.
*   **Scalability:** Consider potential bottlenecks, especially in PDF processing and LLM interactions. The separate PDF service helps distribute load. Reading markdown files from disk on demand might introduce I/O bottlenecks if not handled efficiently, especially for large files or high concurrency.
*   **Error Handling:** Robust error handling is needed for file uploads, PDF processing failures, LLM API errors, database issues, and **file system access errors when reading markdown**.

---

# Reading Pal Application: Implementation Plan

This plan outlines a phased approach to building the Reading Pal application based on the `pdr.md` requirements and the details from `pdf_service/app.py`.

**Phase 1: Foundation & Setup**

*   **Task 1.1:** Set up project repositories (Frontend, Backend, PDF Service - if separate repo).
*   **Task 1.2:** Define and populate the `.env` file with necessary configurations (DB URI, API keys for *all* LLMs used, service URLs, absolute file paths for storage).
*   **Task 1.3:** Set up the Backend project structure (Python environment, install dependencies like FastAPI/Flask, PyMongo, Requests).
*   **Task 1.4:** Set up the Frontend project structure (React environment, install dependencies).
*   **Task 1.5:** Verify MongoDB connection from the Backend. Implement a simple health check endpoint.
*   **Task 1.6:** Set up basic logging configuration in the Backend.

**Phase 2: PDF Processing Integration**

*   **Task 2.1:** Ensure the PDF Service is runnable and accessible at the configured `PDF_CLIENT_URL`. Verify its `/process-pdf` endpoint is available.
*   **Task 2.2:** Implement a Backend API endpoint (`POST /upload-pdf`) to receive PDF files from the Frontend.
*   **Task 2.3:** Implement Backend logic to **forward the received PDF file data** to the PDF Service's `/process-pdf` endpoint using a library like `requests`.
*   **Task 2.4:** Implement Backend logic to handle the response from the PDF Service, expecting the server-side markdown file path and a list of server-side image info (including paths and filenames).
*   **Task 2.5:** Design the MongoDB schema for storing book metadata, the **filename** of the processed markdown file, and the **filenames** of the extracted images.
*   **Task 2.6:** Implement Backend logic to save the processed book data (including the markdown **filename** and image **filenames**) into MongoDB.
*   **Task 2.7:** Implement a Backend API endpoint (`GET /book/{book_id}`) to retrieve processed book data (markdown filename, image filenames) from MongoDB.
*   **Task 2.8:** Implement Backend logic in the `/book/{book_id}` endpoint to **read the markdown content string from the file system using the stored filename and a configured base path**, and convert the retrieved server-side image **filenames** into public URLs (e.g., `/images/{filename}`) before returning the markdown content string and image URLs to the Frontend.
*   **Task 2.9:** **Configure the Frontend's Nginx to implement a static file serving route** (e.g., `/images/{filename}`) that serves files directly from the configured `IMAGES_PATH` volume mount.
*   **Task 2.10:** Implement a basic Frontend component for uploading PDF files and handling the response (e.g., navigating to the book view).
*   **Task 2.11:** Implement a basic Frontend component to display Markdown content, ensuring it correctly uses the provided image URLs to load images from the Frontend's Nginx static route.

**Phase 3: Reading & Note Taking UI**

*   **Task 3.1:** Design and implement the dual-pane layout in the Frontend (Book Pane, Note Pane).
*   **Task 3.2:** Integrate the Markdown display component into the Book Pane.
*   **Task 3.3:** Implement a basic editable text area or rich text editor component for the Note Pane.
*   **Task 3.4:** Implement Frontend logic for synchronized scrolling between the Book Pane and Note Pane based on scroll position or visible content. (This might require mapping content sections to note sections).
*   **Task 3.5:** Design the MongoDB schema for storing notes (content, book ID, reference to book section/position, **scroll_percentage** location).
*   **Task 3.6:** Implement Backend API endpoints for saving (`POST /notes`), fetching (`GET /notes/{book_id}`), and updating (`PUT /notes/{note_id}`) notes. Ensure the save endpoint accepts and stores the `scroll_percentage`.
*   **Task 3.7:** Implement Frontend logic to capture the scroll percentage in the Book Pane when text is selected or a note is created, and send it along with the note data to the Backend API.
*   **Task 3.8:** Implement Frontend logic to load and display existing notes for a given book.
*   **Task 3.9:** Implement Frontend logic to make notes in the Note Pane clickable. When a note is clicked, if it has a stored `scroll_percentage`, trigger the Book Pane to scroll instantly to that position.

**Phase 4: LLM Integration (Reading Assistance)**

*   **Task 4.1:** Create a Python module/service in the Backend to abstract **Reading Assistance** LLM interactions (e.g., `llm_service.py`).
*   **Task 4.2:** Implement logic within the Backend's LLM module to select the correct LLM provider based on `.env` configuration (`LLM_SERVICE`).
*   **Task 4.3:** Implement functions within the Backend's LLM module for key operations (e.g., `summarize_text(text, context)`, `ask_question(prompt, context)`).
*   **Task 4.4:** Implement Backend API endpoints to trigger **Reading Assistance** LLM operations (e.g., `POST /llm/summarize`, `POST /llm/ask`). These endpoints will receive text/prompts from the Frontend, retrieve the markdown **filename** from the stored book metadata, read the necessary context (surrounding text) from the markdown file (using the stored **filename** and a configured base path), and call the Backend's LLM module.
*   **Task 4.5:** Implement Frontend UI elements (buttons, context menus) to allow users to select text and trigger **Reading Assistance** LLM actions.
*   **Task 4.6:** Implement Frontend logic to send selected text/prompts to the Backend **Reading Assistance** LLM APIs.
*   **Task 4.7:** Implement Frontend logic to receive LLM responses and display them, likely within the Note Pane or as temporary popups.
*   **Task 4.8:** (Optional but recommended) Implement Backend logic to save **Reading Assistance** LLM interactions/responses as special types of notes in MongoDB.

**Phase 5: Refinements & Additional Features**

*   **Task 5.1:** Improve synchronized scrolling accuracy and robustness.
*   **Task 5.2:** Implement note organization features (e.g., tagging, categorization).
*   **Task 5.3:** Implement search functionality for book content (requires reading from markdown files) and notes.
*   **Task 5.4:** Enhance UI/UX based on user feedback or design mockups.
*   **Task 5.5:** Implement more sophisticated error handling and user feedback mechanisms in the Frontend and Backend.
*   **Task 5.6:** Add input validation on API endpoints.

**Phase 6: Testing & Deployment**

*   **Task 6.1:** Write unit tests for Backend logic (API endpoints, database interactions, LLM module, static file serving, **markdown file reading**).
*   **Task 6.2:** Write integration tests covering the flow from Frontend action -> Backend -> PDF Service -> Backend -> Database/File System -> Backend -> Frontend.
*   **Task 6.3:** Perform manual testing of all features.
*   **Task 6.4:** Set up deployment configurations and scripts for the Backend and Frontend applications, ensuring correct configuration of file paths and environment variables for both the Backend and the PDF Service, and ensuring the Backend has access to the shared file storage volumes.
*   **Task 6.5:** Deploy the application to a staging or production environment.
*   **Task 6.6:** Monitor application performance and logs.
