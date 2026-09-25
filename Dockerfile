FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
COPY server ./server
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=5188 DATA_DIRECTORY=/app/data
EXPOSE 5188
CMD ["node", "server/server.mjs"]
