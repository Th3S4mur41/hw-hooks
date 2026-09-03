FROM node:lts-slim

RUN apt-get update && apt-get install avahi-utils -y
 
WORKDIR /app

COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm ci
 
COPY . .

RUN npm run build:cli
 
ENV meter=""
# p1 is deprecated, use meter instead
ENV p1=""
ENV LOG_LEVEL=info
ENV LOG_FILE_ENABLED=true

RUN mkdir -p /app/logs

# Provisioning credentials are read at runtime from /run/secrets, never from a build argument or ENV
CMD ["node", "bin/cli.mjs", "-r"]
