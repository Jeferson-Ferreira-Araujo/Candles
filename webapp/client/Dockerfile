FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY client/package.json client/package.json
# --ignore-scripts pula o "postinstall" da raiz (builda o shared) -- o codigo-fonte ainda
# nao foi copiado nesse ponto; o build de verdade roda explicitamente mais abaixo.
RUN npm ci --ignore-scripts

COPY shared ./shared
COPY client ./client
# VITE_API_BASE_URL fica vazio de proposito: nessa implantacao o frontend e o backend
# ficam na MESMA origem (ob.jefersonaraujo.com.br, roteado por path no Traefik), entao o
# client usa URLs relativas (ver client/src/api.ts) — sem CORS, sem configurar dominio do
# backend separado.
RUN npm run build --workspace shared && npm run build --workspace client

FROM nginx:alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
