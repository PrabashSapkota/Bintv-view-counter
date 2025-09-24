FROM node:bookworm-slim

WORKDIR /app

# Install Redis server and necessary tools
RUN apt-get update && \
    apt-get install -y redis-server && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install

RUN npm install express socket.io axios cors redis @socket.io/redis-adapter

COPY . .

CMD service redis-server start && node index.js

ENV NODE_ENV=production