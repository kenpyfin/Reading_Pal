# Use an official Node.js runtime as a parent image
FROM node:18-alpine as builder

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if any)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# --- MODIFICATION START ---
# Clear Create React App's cache before building
RUN rm -rf node_modules/.cache && npm run build
# --- MODIFICATION END ---

# --- Runtime stage ---
FROM node:18-alpine

# Set a default for FRONTEND_PORT, can be overridden at runtime
# (e.g., by Docker Compose from .env file)
ENV FRONTEND_PORT=3100

WORKDIR /app

# Install 'serve' to serve static files
RUN npm install -g serve

# Copy the build output from the builder stage
# This copies the contents of /app/build from the builder stage
# into /app/build in the current stage (since WORKDIR is /app).
COPY --from=builder /app/build ./build

# Expose the port the app runs on. Uses the FRONTEND_PORT env var.
EXPOSE ${FRONTEND_PORT}

# Command to serve the app using the FRONTEND_PORT environment variable.
# The '-s' flag is important for Single Page Applications like React.
# 'serve' will listen on 0.0.0.0 within the container.
# The 'sh -c' form allows environment variable substitution in the CMD.
CMD ["sh", "-c", "serve -s build -l tcp://0.0.0.0:${FRONTEND_PORT}"]
