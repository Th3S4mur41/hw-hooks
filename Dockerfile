FROM node:lts-slim

# Deprecated: use ghcr.io/th3s4mur41/hw-hooks instead
LABEL org.opencontainers.image.description="DEPRECATED: hw2energyid v1 is no longer maintained. Use ghcr.io/th3s4mur41/hw-hooks instead."
LABEL org.opencontainers.image.url="https://github.com/Th3S4mur41/hw-hooks"

RUN apt-get update && apt-get install avahi-utils -y
 
WORKDIR /app

COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm ci
 
COPY . .
 
ENV energyid ''
# p1 is deprecated, use meter instead
ENV p1 ''
ENV meter ${p1}

CMD npx hw2energyid --energyid=${energyid} --meter=${meter} -r
