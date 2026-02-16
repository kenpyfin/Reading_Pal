# PDF processing service (PaddleOCR + PyMuPDF). GPU-only: requires NVIDIA GPU and nvidia-container-toolkit.
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

WORKDIR /app

# System libs for OpenCV (PaddleOCR) and pdf2image (poppler)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb1 libxcb-xfixes0 libxcb-shm0 libxcb-render0 libxcb-shape0 libxcb-sync1 \
    libgl1-mesa-glx libglib2.0-0 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# App dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir \
    fastapi==0.104.1 python-multipart==0.0.6 uvicorn==0.24.0 python-dotenv \
    requests ollama google-generativeai anthropic \
    pymupdf pdf2image paddleocr

# PaddlePaddle GPU for CUDA 12 (must match base image CUDA)
RUN pip install --no-cache-dir paddlepaddle-gpu

RUN mkdir -p /app/models
ENV HOME=/app

COPY app.py ./

ENV PORT=8502
EXPOSE 8502

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
