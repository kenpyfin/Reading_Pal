# User Goal
The Reading Pal application aims to provide users with an efficient and engaging way to read books, extract insights, and enhance their understanding through the use of Large Language Models (LLMs). The app will allow users to upload PDF files, process them into a readable format, and interact with LLM services to summarize, analyze, and annotate content. Additionally, the app will feature a user-friendly interface that enables seamless reading, note-taking, and synchronization between the book content and notes.

# Key Features
- PDF Upload and Processing: Users can upload PDF files from their device via an **authenticated API call** (`POST /api/books/upload`).
  - The backend calls a separate PDF processing service, which returns a `job_id` and "pending" status immediately. The backend creates a book record with this `job_id`.
  - The user is redirected to the book list page, where the new book appears with a 'pending' or 'processing' status.
  - The PDF is processed **asynchronously** by the PDF service.
  - The processing service extracts images from the PDF and saves them.
  - The processed Markdown content is saved **to a file** by the PDF service.
  - The PDF service rewrites image paths within the Markdown content to be web-accessible (e.g., `/images/image_name.png`).
  - **Upon completion or failure, the PDF service sends a callback to a backend endpoint (`/api/books/callback`) with the `job_id`, `status`, the server-side path to the saved Markdown file (if successful), and any error messages.**
  - **The backend receives this callback, updates the book's record in the database (e.g., status, markdown filename derived from the path). It does not receive or store a separate list of image filenames from the callback.**
  - The frontend can optionally poll a backend endpoint (`/api/books/status/{job_id}`) to check processing status, but the primary update mechanism is the callback.
  - Once processing is 'completed', the book is available for reading.
  - **The backend reads the Markdown content from the file system using the stored filename and a configured base path (via volume mounts) when needed for the reading view.**
  - **The application serves extracted images statically. The Markdown content contains relative paths (e.g., `/images/image.png`) that the browser uses to request images, typically served by Nginx via a route mapped to the images storage path.**
  - **Book Management:**
    - **Rename Book:** Users can rename books from the book list.
      - This action triggers an **authenticated API call** to the backend, which updates the book's `title` and `sanitized_title` in the database.
      - The backend renames the corresponding Markdown file on the file system to match the new sanitized title.
    - **Delete Book:** Users can delete books from the book list. 
      - This action triggers an **authenticated API call** to the backend, which deletes the book's record from the database.
      - The backend deletes the associated Markdown file. Deletion of individual image files is complex as their names are not explicitly tracked by the backend from the PDF service callback; images are stored in a common directory.
- LLM-Powered Reading Assistance:
  - Integrated with LLM services to provide real-time insights, summaries, and interpretations of the book content.
  - Users can ask questions or request specific analyses of the text using natural language prompts.
  - **The backend provides context to the LLM by reading relevant sections from the Markdown file (using the stored filename and a configured base path).**
- Dual-Pane UI:
  - Book Component: Displays the processed PDF content (Markdown read from file, and Images served statically) in a clean, readable format with options for zooming, searching, and navigating through pages.
  - Note Component: A synchronized pane where users can:
    - Take notes directly while reading.
    - **Notes can optionally be linked to selected text from the book pane, saving the source text along with the note.**
    - **Notes can optionally be linked to a specific location in the book pane (e.g., via scroll position), saving this location data.**
    - Interact with LLM services to generate insights or ask questions about specific passages.
    - Organize and categorize notes for easy reference later.
- Note Synchronization:
  - The note component scrolls in sync with the book component, ensuring that notes are tied to specific sections of the text during reading.
  - **Clicking on a note in the Note Pane will instantly scroll the Book Pane to the corresponding location if location data (like scroll percentage) is available for that note.**
  - Notes can be saved, edited, and organized within the app.
- Insight Extraction and Recall:
  - LLM services will generate summaries, key takeaways, and actionable insights from the book content.
  - Users can review these insights to quickly grasp the main ideas of the book or revisit specific points during future reads.


# Implementation Requirements
- Use Python for backend and React for frontend.
- Use MongoDB to store notes and book metadata, including the **filename** of the processed Markdown file for each book. The Markdown content itself contains web-relative paths to images.
- **Do not store the full Markdown content string in the database; store only its filename.**
- Only use env files for global variable or configuration settings. Do not use a config file layer.
- The `pdf_service` folder contains a PDF processing service. The backend sends the PDF to this service. The PDF service processes it asynchronously and sends a callback to the backend with the `job_id`, `status`, and the path to the resulting Markdown file.
- **The backend must implement logic to read the Markdown content from the file system using the stored filename and a configured base path (via volume mounts).**
- **The backend includes authenticated API endpoints for listing books, retrieving individual book details, uploading PDFs (`POST /api/books/upload`), renaming (`PUT /api/books/{book_id}/rename`), and deleting (`DELETE /api/books/{book_id}`) books. These operations include managing associated files (Markdown, images) on the file system where applicable.**
- **The application relies on a static file server (e.g., Nginx) to serve images from the designated storage path, using relative paths embedded in the Markdown content.**
- **The Docker Compose setup uses `host` network mode, meaning services communicate via `localhost` or the host's IP and exposed ports, not internal Docker service names.**
- **The frontend (BookList page) provides UI controls (e.g., buttons appearing on hover) for renaming and deleting books, with appropriate user confirmations. These UI controls trigger the respective authenticated API calls.**

