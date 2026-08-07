FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY migrations ./migrations
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
ENV API_PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "npm run migrate && npm run start"]
