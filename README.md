# Song Layer Studio

A React + Vite audio app with:

- stem separation through a Node/Python worker
- searchable song metadata
- optional Supabase persistence for production
- a Vercel-friendly frontend that can talk to an external worker API

## Recommended Production Architecture

Use three separate pieces:

1. GitHub repo for this app
2. Vercel project for the frontend
3. Separate worker service for the `/api` backend and Demucs/FFmpeg processing

Use Supabase for:

- Postgres metadata in `tracks`
- public file storage for original uploads and generated stems

Why this split:

- Vercel is a good fit for the frontend
- Supabase is a good fit for search metadata and asset URLs
- Demucs and FFmpeg are better hosted on a separate worker than inside Vercel Functions

## Environment Variables

Copy [.env.example](/Users/simonnegrelli/Documents/New%20project/song-layer-studio/.env.example) and set the values needed for your environment.

### Frontend

- `VITE_API_BASE_URL`
  Use the full base URL of your worker API in production, for example `https://your-worker.example.com`

### Worker API

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `DEMUCS_MODEL`
- `DEMUCS_SEGMENT`

When Supabase env vars are present, the worker:

- uploads source audio and stems to Supabase Storage
- stores searchable records in Supabase Postgres

Without Supabase env vars, it falls back to local disk and `storage/library.json`.

Recommended low-memory defaults for Render free:

- `DEMUCS_MODEL=mdx_q`
- `DEMUCS_SEGMENT=6`

## Supabase Setup

Run the SQL in [supabase/schema.sql](/Users/simonnegrelli/Documents/New%20project/song-layer-studio/supabase/schema.sql).

That creates:

- `public.tracks`
- a public storage bucket named `audio-assets`
- public read policies for metadata and stored audio files

## Local Development

1. Install JavaScript dependencies:

```bash
npm install
```

2. Install Python dependencies:

```bash
python3 -m pip install demucs certifi librosa
```

3. Install FFmpeg:

```bash
brew install ffmpeg
```

4. Run the worker API:

```bash
npm run dev:server
```

5. In another terminal, run the frontend:

```bash
npm run dev:client
```

The Vite app proxies to `127.0.0.1:8787` locally.

## Deployment Flow

### 1. Create a new GitHub repo

Use a separate repo for this app rather than your existing CMS repo.

### 2. Push this project to that repo

Typical flow:

```bash
git remote remove origin
git remote add origin <your-new-repo-url>
git push -u origin main
```

### 3. Create a new Supabase project

- create the project
- run `supabase/schema.sql`
- copy `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### 4. Deploy the worker API on Render

Set worker env vars:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`

### 5. Create a new Vercel project

Link the new GitHub repo to a new Vercel project.

Set frontend env vars:

- `VITE_API_BASE_URL=https://your-worker-api.example.com`

Then deploy the frontend on Vercel.

## Render Worker Setup

This repo includes:

- a root [Dockerfile](/Users/simonnegrelli/Documents/New%20project/song-layer-studio/Dockerfile) for the worker service
- a [render.yaml](/Users/simonnegrelli/Documents/New%20project/song-layer-studio/render.yaml) blueprint so Render can auto-detect the service settings from GitHub

Render will build the Docker image, expose the worker as a web service, and use `/api/health` as the health check.

### Render steps

1. Push the latest changes in `song-layer-studio` to [github.com/leroyslater/stemit](https://github.com/leroyslater/stemit)
2. In Render, click `New +` then `Blueprint`
3. Connect GitHub and choose `leroyslater/stemit`
4. Render should detect [render.yaml](/Users/simonnegrelli/Documents/New%20project/song-layer-studio/render.yaml) and create a web service named `stemit-worker`
5. In the service environment settings, set:

```env
SUPABASE_URL=https://mapqtamxnaxoytlfbicb.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-rotated-service-role-key
SUPABASE_STORAGE_BUCKET=audio-assets
HOST=0.0.0.0
DEMUCS_MODEL=mdx_q
DEMUCS_SEGMENT=6
```

6. Deploy
7. After deployment, open the worker URL and test:

```text
https://your-render-service.onrender.com/api/health
```

8. Set that base URL in Vercel as:

```env
VITE_API_BASE_URL=https://your-render-service.onrender.com
```

### Important

- Rotate the service role key before using it in production, because it was shared in chat.
- Render will provide `PORT`; the worker already reads it automatically.
- Free Render services can sleep when idle, so the first request after inactivity may be slow.
- Free Render instances have limited memory, so `mdx_q` with a small segment size is the safest starting point.
- Keep the frontend on Vercel and the heavy Demucs worker on Render.

## Current Features

- Upload and separate into `vocals`, `drums`, `bass`, and `other`
- Show estimated BPM and key
- Store and search previous songs
- Expand the `other` stem into secondary frequency layers

## Notes

- The first Demucs run downloads model weights.
- Demucs is CPU-heavy and can take a while on longer songs.
- Local fallback files are stored under `storage/jobs/<job-id>`.
