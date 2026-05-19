FROM node:20-bookworm-slim

ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  ffmpeg \
  libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
RUN python3 -m pip install demucs certifi torchcodec librosa

COPY . .

ENV HOST=0.0.0.0

CMD ["npm", "run", "start"]
