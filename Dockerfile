FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY migrations ./migrations
COPY seed ./seed
COPY scripts ./scripts
COPY src ./src
USER node
