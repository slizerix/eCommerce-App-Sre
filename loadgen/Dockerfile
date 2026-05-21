FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY loadgen.js ./
CMD ["node", "loadgen.js"]
