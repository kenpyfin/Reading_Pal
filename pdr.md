# User Goal
The Reading Pal application aims to provide users with an efficient and engaging way to read books, extract insights, and enhance their understanding through the use of Large Language Models (LLMs). The app will allow users to upload PDF files, process them into a readable format, and interact with LLM services to summarize, analyze, and annotate content. Additionally, the app will feature a user-friendly interface that enables seamless reading, note-taking, and synchronization between the book content and notes.

# Key Features
- PDF Upload and Processing: Users can upload PDF files from their device via an **authenticated API call**.
  - Upon successful upload initiation, the user is immediately redirected to the book list page (which itself is loaded via an **authenticated API call**) where the newly uploaded book appears with a status indicator (e.g., 'pending' or 'processing').
  - The application periodically checks the processing status in the background by polling a backend endpoint (`/api/books/status/{job_id}`).
  - The PDF is processed **in the background** by a dedicated service and converted into a readable format (e.g., Markdown).
  - The processing service extracts images from the PDF and saves them.
  - The processed Markdown content is saved **to a file** by the PDF service.
  - **The PDF service returns the server-side path to the saved Markdown file and a list of server-side image info (including filenames and paths) to the backend upon processing completion or failure.**
  - **The backend receives this information and updates the book's record in the database, storing only the filename of the processed Markdown file and the filenames of the extracted images.**
  - Once processing is finished and the status updates to 'completed', the book title becomes a clickable link, allowing the user to navigate to the reading view (which involves an **authenticated API call** to fetch book details).
  - **Books with a 'failed' status are automatically excluded from the book list displayed to the user.**
  - **A background cleanup service runs periodically in the backend to mark 'processing' jobs as 'failed' if they appear stuck (no status update for a defined period) and to delete book records (with 'pending' or 'failed' status) that are older than a defined threshold (e.g., 6 hours).**
  - **The backend stores these filenames in the database upon processing completion.**
  - **The backend reads the Markdown content from the file system using the stored filename and a configured base path (via volume mounts) when needed for the reading view.**
  - **The application serves the extracted images statically via a dedicated route (handled by Nginx in the frontend container) using the stored image filenames and a configured base path (via volume mounts).**
  - **Book Management:**
    - **Rename Book:** Users can rename books from the book list.
      - This action triggers an **authenticated API call** to the backend, which updates the book's `title` and `sanitized_title` in the database.
      - The backend renames the corresponding Markdown file on the file system to match the new sanitized title.
    - **Delete Book:** Users can delete books from the book list.
      - This action triggers an **authenticated API call** to the backend, which deletes the book's record from the database.
      - The backend deletes the associated Markdown file and all extracted image files from the file system.
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
- Use MongoDB to store notes and any metadata needed, including the **filename** of the processed Markdown file and **filenames** of the extracted images for each book.
- **Do not store the full markdown content string in the database; store only the filename.**
- Only use env files for global variable or configuration settings. Do not use a config file layer.
- The pdf_service folder contains a pdf processing service that needs to run separately and integrate with this app. The backend of this app needs to connect with this service correctly, send the PDF (this initial upload from frontend to backend is **authenticated**), and receive the processed data (**Markdown file path**, image paths).
- **The backend must implement logic to read the Markdown content from the file system using the stored filename and a configured base path (via volume mounts).**
- **The backend includes authenticated API endpoints for listing books, retrieving individual book details, uploading PDFs (`POST /api/books/upload`), renaming (`PUT /api/books/{book_id}/rename`), and deleting (`DELETE /api/books/{book_id}`) books. These operations include managing associated files (Markdown, images) on the file system where applicable.**
- **The application must implement a static file server route to serve images from the designated storage path (handled by Nginx).**
- **The Docker Compose setup uses `host` network mode, meaning services communicate via `localhost` or the host's IP and exposed ports, not internal Docker service names.**
- **The frontend (BookList page) provides UI controls (e.g., buttons appearing on hover) for renaming and deleting books, with appropriate user confirmations. These UI controls trigger the respective authenticated API calls.**

