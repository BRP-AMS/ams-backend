# Use Node.js version 18
FROM node:18-alpine

# Set the folder where your code will live inside the container
WORKDIR /app

# Copy your package files first
COPY package*.json ./

# Install your backend dependencies
RUN npm install

# Copy all your backend code into the container
COPY . .

# Expose the port your backend uses (check your server.js, usually 5000 or 8080)
EXPOSE 5000

# The command to start your server
CMD ["node", "server.js"]
