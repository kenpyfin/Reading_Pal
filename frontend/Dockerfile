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

# Build the React app
RUN npm run build

# --- Runtime stage ---
FROM nginx:alpine

# Install gettext for envsubst
RUN apk add --no-cache gettext

COPY --from=builder /app/build /usr/share/nginx/html

# Copy the nginx configuration template
# Copy it to a template location, not directly to conf.d
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

# Use /bin/sh -c to run envsubst and then start nginx
# envsubst reads the template, substitutes the variable, and outputs to the final config location
# exec replaces the shell process with the nginx process
CMD ["/bin/sh", "-c", "envsubst '$BACKEND_PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
