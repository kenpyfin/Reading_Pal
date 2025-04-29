# User Goal
The Reading Pal application aims to provide users with an efficient and engaging way to read books, extract insights, and enhance their understanding through the use of Large Language Models (LLMs). The app will allow users to upload PDF files, process them into a readable format, and interact with LLM services to summarize, analyze, and annotate content. Additionally, the app will feature a user-friendly interface that enables seamless reading, note-taking, and synchronization between the book content and notes.

# Key Features
- PDF Upload and Processing. Users can upload PDF files from their device. The PDF is converted into a readable format (e.g., Markdown) for easy navigation and display in the app using the pdf_reader project included in this directory.
  - The pdfConvertor will extract images from the PDF and save it in a file with a url in the Markdown
- LLM-Powered Reading Assistance. 
  - Integrated with LLM services to provide real-time insights, summaries, and interpretations of the book content. 
  - Users can ask questions or request specific analyses of the text using natural language prompts. The LLM services sample code base can be found in llm_services.py.
- Dual-Pane UI:
  - Book Component: Displays the processed PDF content in a clean, readable format with options for zooming, searching, and navigating through pages.
    - Book component should be able to display images  
  - Note Component: A synchronized scrolling pane where users can:
    - Take notes directly while reading.
    - Interact with LLM services to generate insights or ask questions about specific passages.
    - Organize and categorize notes for easy reference later.
- Note Synchronization
  - The note component scrolls in sync with the book component, ensuring that notes are tied to specific sections of the text.
  - Notes can be saved, edited, and organized within the app.
- Insight Extraction and Recall
  - LLM services will generate summaries, key takeaways, and actionable insights from the book content.
  - Users can review these insights to quickly grasp the main ideas of the book or revisit specific points during future reads.


# Implementation Requirements
- Use Python for backend and React for frontend.
- Use MongoDB to store notes and any metadata needed.
- Only use env files for global variable or configuration settings. Do not use a config file layer.
- The pdf_service folder contains a pdf processing service that needs to run separately and integrate with this app. The backend of this app needs to connect with this service correctly.

