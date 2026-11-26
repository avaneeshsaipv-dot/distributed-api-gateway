FROM node:20-alpine

# curl is used by the Docker health-check probes for backends
RUN apk add --no-cache curl

WORKDIR /app

# Install dependencies first (layer cached unless package.json changes)
COPY package.json .
RUN npm install --omit=dev

COPY . .

# No CMD — each service in docker-compose.yml overrides it
EXPOSE 8080 5001 5002 5003
