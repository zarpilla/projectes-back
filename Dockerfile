# Strapi v5 backend — Node 20 required.
# Ported from the v3 Dockerfile (was node:16). v5 needs Node >= 20.
FROM node:20-bookworm-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies first (better layer caching).
# A wildcard ensures both package.json AND package-lock.json are copied.
COPY package*.json ./

RUN npm ci --omit=dev

# Bundle app source
COPY . .

# Build the admin panel for production
RUN npm run build

EXPOSE 1337
CMD ["npm", "run", "start"]

# Build for production:
#   docker build \
#     --build-arg NODE_ENV=production \
#     -t projectes-v5-backend:latest \
#     -f Dockerfile .
