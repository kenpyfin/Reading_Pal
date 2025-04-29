# User Goal
The Reading Pal application aims to provide users with an efficient and engaging way to read books, extract insights, and enhance their understanding through the use of Large Language Models (LLMs). The app will allow users to upload PDF files, process them into a readable format, and interact with LLM services to summarize, analyze, and annotate content. Additionally, the app will feature a user-friendly interface that enables seamless reading, note-taking, and synchronization between the book content and notes.

# Key Features
- PDF Upload and Processing: Users can upload PDF files from their device. The PDF is processed by a dedicated service and converted into a readable format (e.g., Markdown) for easy navigation and display in the app.
  - The processing service extracts images from the PDF and saves them to a designated location.
  - The processed Markdown content is saved **to a file** by the PDF service.
  - The **path to the processed Markdown file** and the paths to the extracted images are returned to the backend.
  - **The backend stores the path to the processed Markdown file and the image paths in the database.**
  - **The backend reads the Markdown content from the file system using the stored path when needed.**
  - **The backend serves the extracted images statically, providing URLs for the frontend to display them within the Markdown content.**
- LLM-Powered Reading Assistance:
  - Integrated with LLM services to provide real-time insights, summaries, and interpretations of the book content.
  - Users can ask questions or request specific analyses of the text using natural language prompts.
  - **The backend provides context to the LLM by reading relevant sections from the Markdown file.**
- Dual-Pane UI:
  - Book Component: Displays the processed PDF content (Markdown read from file, and Images) in a clean, readable format with options for zooming, searching, and navigating through pages.
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
- Use MongoDB to store notes and any metadata needed, including the **path to the processed Markdown file** and image file paths for each book.
- **Do not store the full markdown content string in the database; store only the file path.**
- Only use env files for global variable or configuration settings. Do not use a config file layer.
- The pdf_service folder contains a pdf processing service that needs to run separately and integrate with this app. The backend of this app needs to connect with this service correctly, send the PDF, and receive the processed data (**Markdown file path**, image paths).
- **The backend must implement logic to read the Markdown content from the file system using the stored path.**
- **The backend must implement a static file server route to serve images from the designated storage path to the frontend.**

