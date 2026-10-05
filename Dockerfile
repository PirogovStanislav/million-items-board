FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
