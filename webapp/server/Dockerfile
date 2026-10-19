# Imagem oficial do Playwright: já vem com o Chromium e todas as libs de sistema que ele
# precisa (foi exatamente a dor que tivemos tentando instalar isso "na mão" no Render) —
# versao tem que bater com a do pacote "playwright" em package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app

# So os manifestos primeiro, pra cachear a camada do `npm ci` entre builds quando so o
# codigo muda (sem precisar reinstalar node_modules toda vez).
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY shared ./shared
COPY server ./server
RUN npm run build --workspace shared && npm run build --workspace server

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npm", "run", "start", "--workspace", "server"]
