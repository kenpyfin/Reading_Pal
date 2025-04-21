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

