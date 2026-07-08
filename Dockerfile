FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
# Install GMGN CLI and skills for deep token metrics
RUN npm install -g gmgn-cli && \
    npx skills add GMGNAI/gmgn-skills || true
COPY monitor.js .
CMD ["npm", "start"]
