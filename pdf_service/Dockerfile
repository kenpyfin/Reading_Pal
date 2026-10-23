# PDF processing service (PaddleOCR + PyMuPDF). GPU-only: requires NVIDIA GPU and nvidia-container-toolkit.
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

WORKDIR /app

# Avoid interactive apt prompts (tzdata/calibre dependencies) during image builds.
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# System libs for OpenCV (PaddleOCR), pdf2image (poppler), and ebook conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    libxcb1 libxcb-xfixes0 libxcb-shm0 libxcb-render0 libxcb-shape0 libxcb-sync1 \
    libgl1-mesa-glx libglib2.0-0 \
    poppler-utils \
    calibre \
    && rm -rf /var/lib/apt/lists/*

# App dependencies
COPY requirements.txt ./
# Install PaddlePaddle GPU 3.x first so paddleocr does not pull CPU paddle from PyPI.
# PaddleX/PaddleOCR 3.x require set_optimization_level (Paddle 3.0+).
# Use cu118 (not cu126): Maxwell GPUs (Tesla M40, sm_52) segfault in cuBLAS with CUDA 12 wheels.
RUN pip install --no-cache-dir paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/
RUN pip install --no-cache-dir \
    fastapi==0.104.1 python-multipart==0.0.6 uvicorn==0.24.0 python-dotenv \
    requests ollama google-genai anthropic \
    pymupdf pdf2image paddleocr \
    ebooklib beautifulsoup4 markdownify python-docx charset-normalizer

RUN mkdir -p /app/models
ENV HOME=/app
# Avoid blocking model-host connectivity checks during container startup.
ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

COPY app.py ./
COPY parsers ./parsers

ENV PORT=8502
EXPOSE 8502

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
