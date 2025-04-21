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


**3. Component Details**

*   **Frontend (React):**
    *   Handles user interaction, rendering the UI.
    *   Displays processed book content (Markdown, Images).
    *   Provides the dual-pane view for book and notes.
    *   Manages synchronized scrolling between panes.
    *   Allows users to input notes and LLM prompts.
    *   Communicates with the Backend via REST APIs.
*   **Backend (Python):**
    *   Acts as the central hub.
    *   Manages user authentication (if implemented later).
    *   Receives PDF uploads from the Frontend.
    *   Sends PDF processing requests to the PDF Service.
    *   Receives processed data (Markdown, image URLs) from the PDF Service.
    *   Stores book metadata and note data in MongoDB.
    *   Provides APIs for the Frontend to:
        *   Upload PDFs.
        *   Fetch book content and metadata.
        *   Fetch/Save/Update notes.
        *   Send prompts to LLM Services.
    *   Communicates with LLM Services based on user requests.
    *   Retrieves LLM responses and potentially stores them or sends them to the Frontend.
*   **PDF Service (Python):**
    *   A standalone service (as per `pdr.md` and `.env`).
    *   Receives PDF files or paths from the Backend.
    *   Uses `pdf_reader` project logic to:
        *   Convert PDF content to Markdown.
        *   Extract images and save them to a designated storage path.
        *   Generate URLs/paths for the extracted images within the Markdown.
    *   Returns the processed Markdown content and potentially image metadata/urls back to the Backend.
    *   Requires access to shared file storage paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`).
*   **LLM Services:**
    *   External APIs (Anthropic, DeepSeek, Gemini) or local services (Ollama) as configured in `.env`.
    *   Receive prompts and relevant context (book passages) from the Backend.
    *   Return generated text (summaries, answers, insights).
    *   The Backend needs to abstract the interaction with different LLM providers based on configuration (`LLM_SERVICE`, `LLM_MODEL`).
*   **Database (MongoDB):**
    *   Stores structured and unstructured data.
    *   Primary data entities:
        *   Books (metadata: title, author, file path, processed status, link to Markdown/images).
        *   Notes (content, timestamp, reference to book section/page, link to LLM interaction if applicable).
        *   Users (if authentication is added).

**4. Data Flow Examples**

*   **PDF Upload & Processing:**
    1.  User uploads PDF via Frontend.
    2.  Frontend sends PDF file to Backend API (`/upload-pdf`).
    3.  Backend saves the raw PDF temporarily or to a designated input path.
    4.  Backend sends a processing request (e.g., file path) to the PDF Service API.
    5.  PDF Service reads the PDF, processes it, saves Markdown and images to storage.
    6.  PDF Service returns Markdown content and image references to the Backend.
    7.  Backend saves book metadata, Markdown content (or path), and image references in MongoDB.
    8.  Backend signals Frontend that processing is complete and provides book ID.
    9.  Frontend fetches book content from Backend API (`/book/{id}`).
*   **LLM Interaction (e.g., Summarize Passage):**
    1.  User selects text in the book pane and clicks "Summarize" in the Frontend.
    2.  Frontend sends the selected text and book context (book ID, section) to Backend API (`/llm/summarize`).
    3.  Backend retrieves necessary context from MongoDB or the processed book data.
    4.  Backend calls the appropriate LLM Service API with the prompt and context.
    5.  LLM Service processes the request and returns a summary.
    6.  Backend receives the summary.
    7.  Backend can optionally save the interaction/summary as a special type of note in MongoDB.
    8.  Backend sends the summary back to the Frontend.
    9.  Frontend displays the summary (e.g., in the notes pane).

**5. Technology Stack**

*   **Frontend:** React, HTML, CSS/JavaScript
*   **Backend:** Python (e.g., FastAPI or Flask), Requests library, PyMongo (MongoDB driver)
*   **PDF Service:** Python (using `pdf_reader` project)
*   **Database:** MongoDB
*   **Configuration:** `.env` files

**6. Key Considerations**

*   **File Storage:** The PDF Service requires access to specific file paths (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`). These paths must be accessible by the PDF Service process. The Backend needs to know the URLs/paths to serve these images to the Frontend.
*   **LLM Abstraction:** The Backend should abstract the specific LLM provider logic to allow easy switching via environment variables.
*   **Synchronization:** Implementing smooth and accurate synchronized scrolling between potentially different content types (Markdown vs. editable notes) is crucial.
*   **Scalability:** Consider potential bottlenecks, especially in PDF processing and LLM interactions. The separate PDF service helps distribute load.
*   **Error Handling:** Robust error handling is needed for file uploads, PDF processing failures, LLM API errors, and database issues.

---

# Reading Pal Application: Implementation Plan

This plan outlines a phased approach to building the Reading Pal application based on the `pdr.md` requirements.

**Phase 1: Foundation & Setup**

*   **Task 1.1:** Set up project repositories (Frontend, Backend, PDF Service - if separate repo).
*   **Task 1.2:** Define and populate the `.env` file with necessary configurations (DB URI, API keys, service URLs, file paths).
*   **Task 1.3:** Set up the Backend project structure (Python environment, install dependencies like FastAPI/Flask, PyMongo, Requests).
*   **Task 1.4:** Set up the Frontend project structure (React environment, install dependencies).
*   **Task 1.5:** Verify MongoDB connection from the Backend. Implement a simple health check endpoint.
*   **Task 1.6:** Set up basic logging configuration in the Backend.

**Phase 2: PDF Processing Integration**

*   **Task 2.1:** Ensure the PDF Service is runnable and accessible at the configured `PDF_CLIENT_URL`. (This service is assumed to exist based on `pdr.md`).
*   **Task 2.2:** Implement a Backend API endpoint (`POST /upload-pdf`) to receive PDF files from the Frontend.
*   **Task 2.3:** Implement Backend logic to save the uploaded PDF file temporarily or to `PDF_STORAGE_PATH`.
*   **Task 2.4:** Implement Backend logic to call the PDF Service API, passing the path to the saved PDF.
*   **Task 2.5:** Implement Backend logic to receive the processed Markdown content and image references from the PDF Service response.
*   **Task 2.6:** Design the MongoDB schema for storing book metadata, Markdown content (or path), and image references.
*   **Task 2.7:** Implement Backend logic to save the processed book data into MongoDB.
*   **Task 2.8:** Implement a Backend API endpoint (`GET /book/{book_id}`) to retrieve processed book data (Markdown, images) from MongoDB.
*   **Task 2.9:** Implement a basic Frontend component for uploading PDF files.
*   **Task 2.10:** Implement a basic Frontend component to display Markdown content, ensuring images are rendered correctly using the provided URLs/paths.

**Phase 3: Reading & Note Taking UI**

*   **Task 3.1:** Design and implement the dual-pane layout in the Frontend (Book Pane, Note Pane).
*   **Task 3.2:** Integrate the Markdown display component into the Book Pane.
*   **Task 3.3:** Implement a basic editable text area or rich text editor component for the Note Pane.
*   **Task 3.4:** Implement Frontend logic for synchronized scrolling between the Book Pane and Note Pane based on scroll position or visible content. (This might require mapping content sections to note sections).
*   **Task 3.5:** Design the MongoDB schema for storing notes (content, book ID, reference to book section/position).
*   **Task 3.6:** Implement Backend API endpoints for saving (`POST /notes`), fetching (`GET /notes/{book_id}`), and updating (`PUT /notes/{note_id}`) notes.
*   **Task 3.7:** Implement Frontend logic to save notes from the Note Pane via the Backend API.
*   **Task 3.8:** Implement Frontend logic to load and display existing notes for a given book.

**Phase 4: LLM Integration**

*   **Task 4.1:** Create a Python module/service in the Backend to abstract LLM interactions (e.g., `llm_service.py` as mentioned in `pdr.md`).
*   **Task 4.2:** Implement logic within the LLM module to select the correct LLM provider based on `.env` configuration (`LLM_SERVICE`).
*   **Task 4.3:** Implement functions within the LLM module for key operations (e.g., `summarize_text(text, context)`, `ask_question(prompt, context)`).
*   **Task 4.4:** Implement Backend API endpoints to trigger LLM operations (e.g., `POST /llm/summarize`, `POST /llm/ask`). These endpoints will receive text/prompts from the Frontend, potentially fetch additional context (surrounding text) from the book data, and call the LLM module.
*   **Task 4.5:** Implement Frontend UI elements (buttons, context menus) to allow users to select text and trigger LLM actions.
*   **Task 4.6:** Implement Frontend logic to send selected text/prompts to the Backend LLM APIs.
*   **Task 4.7:** Implement Frontend logic to receive LLM responses and display them, likely within the Note Pane or as temporary popups.
*   **Task 4.8:** (Optional but recommended) Implement Backend logic to save LLM interactions/responses as special types of notes in MongoDB.

**Phase 5: Refinements & Additional Features**

*   **Task 5.1:** Improve synchronized scrolling accuracy and robustness.
*   **Task 5.2:** Implement note organization features (e.g., tagging, categorization).
*   **Task 5.3:** Implement search functionality for book content and notes.
*   **Task 5.4:** Enhance UI/UX based on user feedback or design mockups.
*   **Task 5.5:** Implement more sophisticated error handling and user feedback mechanisms in the Frontend and Backend.
*   **Task 5.6:** Add input validation on API endpoints.

**Phase 6: Testing & Deployment**

*   **Task 6.1:** Write unit tests for Backend logic (API endpoints, database interactions, LLM module).
*   **Task 6.2:** Write integration tests covering the flow from Frontend action -> Backend -> Database/Services -> Backend -> Frontend.
*   **Task 6.3:** Perform manual testing of all features.
*   **Task 6.4:** Set up deployment configurations and scripts for the Backend and Frontend applications.
*   **Task 6.5:** Deploy the application to a staging or production environment.
*   **Task 6.6:** Monitor application performance and logs.
