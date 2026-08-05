FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf ghostscript libreoffice \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
ENV PDFMANIAC_QPDF_PATH=/usr/bin/qpdf
ENV PDFMANIAC_GHOSTSCRIPT_PATH=/usr/bin/gs
ENV PDFMANIAC_LIBREOFFICE_PATH=/usr/bin/libreoffice

EXPOSE 8787
CMD ["npm", "run", "server"]
