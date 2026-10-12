# Imagen mínima para desplegar en Render, Railway, Fly.io o Azure
FROM oven/bun:1.2
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
EXPOSE 7477
CMD ["bun", "src/server.ts"]
