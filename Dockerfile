FROM node:20-bookworm-slim

ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV NODE_ENV=production
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  python3-venv \
  ffmpeg \
  libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server ./server
RUN python3 -m venv "$VIRTUAL_ENV"
RUN pip install --upgrade pip setuptools wheel
RUN pip install demucs certifi librosa

COPY . .

ENV HOST=0.0.0.0

CMD ["npm", "run", "start"]
