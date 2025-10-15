FROM node:20-alpine
WORKDIR /app

# copy only package files first for better caching
COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
