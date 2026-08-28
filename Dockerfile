FROM node:lts-slim

RUN apt-get update && apt-get install avahi-utils -y
 
WORKDIR /app

COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm ci
 
COPY . .
 
ENV meter=""
# p1 is deprecated, use meter instead
ENV p1=""

# Provisioning credentials are read at runtime from /run/secrets, never from a build argument or ENV
CMD ["npx", "hw-hooks", "-r"]
