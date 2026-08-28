FROM node:lts-slim

RUN apt-get update && apt-get install avahi-utils -y
 
WORKDIR /app

COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm ci
 
COPY . .
 
ENV meter ''
# p1 is deprecated, use meter instead
ENV p1 ''
ENV meter ${p1}
ENV provisioning_key ''
ENV provisioning_secret ''

CMD npx hw-hooks --meter=${meter} --provisioning-key=${provisioning_key} --provisioning-secret=${provisioning_secret} -r
