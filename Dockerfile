FROM node:22-alpine

RUN apk add --no-cache ca-certificates lsof procps \
  && npm install -g pm2@latest \
  && npm cache clean --force

WORKDIR /app

ENV NODE_ENV=production \
  NAV_HOST=0.0.0.0 \
  NAV_PORT=80 \
  PM2_BIN=pm2 \
  PM2_HOME=/root/.pm2 \
  PM2_NAV_HIDE_SELF=1 \
  PM2_NAV_DETECT_LISTEN=1

COPY package.json ./
COPY server.js ./server.js
COPY public ./public

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('node:http');const req=http.get({host:'127.0.0.1',port:process.env.NAV_PORT||80,path:'/health',timeout:2000},res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"

CMD ["node", "server.js"]
