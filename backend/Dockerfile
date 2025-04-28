# Use an official Python runtime as a parent image
FROM python:3.9-slim

# Set the working directory in the container
WORKDIR /app

# Copy the current directory contents into the container at /app
# Copy the backend code into a 'backend' subdirectory within the working directory
COPY . /app/backend

# Install any needed packages specified in requirements.txt
COPY requirements.txt /app/backend/

# Install dependencies
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# Make port 8000 available to the world outside this container
# EXPOSE 8000 - This is just documentation, the actual port mapping is in docker-compose
# We will rely on the port specified in the environment variable passed via docker-compose

# Run main.py when the container launches
# Run uvicorn using the module path 'backend.main:app'
# Use the BACKEND_PORT environment variable for the port
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "${BACKEND_PORT}"]
