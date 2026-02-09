FROM node:20-slim

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Install and rebuild native modules
RUN npm ci --only=production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /data

ENV DATABASE_PATH=/data/agentlog.db

EXPOSE 3000

CMD ["node", "index.js"]
