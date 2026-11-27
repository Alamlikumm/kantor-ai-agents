FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# FFmpeg sistem (dengan drawtext/libfreetype) untuk menggabungkan klip AI dari n8n
RUN apk add --no-cache ffmpeg font-dejavu
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/n8n_workflows ./n8n_workflows

EXPOSE 3001
CMD ["node", "server/index.js"]
