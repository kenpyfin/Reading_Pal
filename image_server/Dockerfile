# Use an official Python runtime as a parent image
FROM python:3.9-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container at /app
COPY requirements.txt .

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code into the container at /app
COPY . .

# Make port available to the world outside this container (defined by PORT env var)
# This is informational; actual port mapping is done in docker-compose.yml
# EXPOSE $PORT # Uvicorn will use the PORT env var

# Define environment variable for the port (can be overridden in docker-compose.yml)
ENV PORT=8503 
ENV IMAGES_BASE_PATH=/app/storage/images
ENV LOG_LEVEL=INFO

# Command to run the application
# Uvicorn will be started by app.py's if __name__ == "__main__": block
CMD ["python", "app.py"]
