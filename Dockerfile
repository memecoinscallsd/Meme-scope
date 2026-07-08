FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY monitor.js .
CMD ["npm", "start"]
