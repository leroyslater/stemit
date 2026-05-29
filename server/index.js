import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import express from "express";
import multer from "multer";
import ws from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const storageRoot = path.join(projectRoot, "storage");
const uploadsRoot = path.join(storageRoot, "uploads");
const jobsRoot = path.join(storageRoot, "jobs");
const libraryManifestPath = path.join(storageRoot, "library.json");
const workerScript = path.join(projectRoot, "server", "separate_track.py");
const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const port = Number(process.env.PORT || 8787);
const host =
  process.env.HOST ||
  (process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
const pythonCertificateFile = resolvePythonCertificateFile();
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseStorageBucket = process.env.SUPABASE_STORAGE_BUCKET || "audio-assets";
const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
        realtime: {
          transport: ws,
        },
      })
    : null;

fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(jobsRoot, { recursive: true });

const app = express();
const jobs = new Map();
const library = loadLibraryManifest();

const upload = multer({
  dest: uploadsRoot,
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

function logJobStage(job, message) {
  console.log(`[job ${job.id}] ${message}`);
}

app.use(express.json());
app.use(cors());
app.use("/stems", express.static(jobsRoot));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "song-layer-studio-api",
  });
});

app.get("/api/library", (request, response) => {
  void (async () => {
  const query = String(request.query.q || "")
    .trim()
    .toLowerCase();

  const sourceItems = supabase ? await loadSupabaseLibrary() : [...library];
  const items = sourceItems
    .filter((item) => matchesLibraryQuery(item, query))
    .sort((left, right) => {
      return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
    });

  response.json({
    items,
    total: items.length,
  });
  })().catch((error) => {
    response.status(500).json({
      error: error?.message || "Could not load library.",
    });
  });
});

app.post("/api/library/:id/expand-other", (request, response) => {
  void (async () => {
    const item = await findLibraryItemById(request.params.id);

    if (!item) {
      response.status(404).json({ error: "Library item not found." });
      return;
    }

    const otherStem = (item.stems || []).find((stem) => stem.id === "other");
    if (!otherStem?.url) {
      response.status(400).json({ error: "This item does not have an other stem to expand." });
      return;
    }

    const otherStemPath = await resolveStoredAssetToLocalPath(
      otherStem.url,
      `${item.id}/expand-source/other.wav`
    );

    if (!otherStemPath || !fs.existsSync(otherStemPath)) {
      response.status(404).json({ error: "The saved other stem file could not be found on disk." });
      return;
    }

    const jobId = crypto.randomUUID();
    const jobDirectory = path.join(jobsRoot, jobId);
    fs.mkdirSync(jobDirectory, { recursive: true });

    const job = {
      id: jobId,
      kind: "expand-other",
      libraryId: item.id,
      status: "queued",
      createdAt: new Date().toISOString(),
      trackName: `${item.trackName} (Expand Other)`,
      inputPath: otherStemPath,
      outputDirectory: jobDirectory,
      error: "",
      result: null,
    };

    jobs.set(jobId, job);
    runExpandOtherJob(job);

    response.status(202).json({
      jobId,
      status: job.status,
    });
  })().catch((error) => {
    response.status(500).json({
      error: error?.message || "Could not expand the other stem.",
    });
  });
});

app.post("/api/jobs", upload.single("track"), (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "No audio file was uploaded." });
      return;
    }

    const jobId = crypto.randomUUID();
    const jobDirectory = path.join(jobsRoot, jobId);
    const safeOriginalName = path.basename(request.file.originalname);
    const inputPath = path.join(jobDirectory, safeOriginalName);

    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.renameSync(request.file.path, inputPath);

    const job = {
      id: jobId,
      status: "queued",
      createdAt: new Date().toISOString(),
      trackName: safeOriginalName,
      sizeBytes: request.file.size,
      inputPath,
      outputDirectory: jobDirectory,
      error: "",
      result: null,
    };

    jobs.set(jobId, job);
    logJobStage(job, `Upload received for ${job.trackName} (${job.sizeBytes} bytes)`);
    runSeparationJob(job);

    response.status(202).json({
      jobId,
      status: job.status,
    });
  } catch (error) {
    response.status(500).json({
      error: error?.message || "Could not create a separation job.",
    });
  }
});

app.get("/api/jobs/:jobId", (request, response) => {
  const job = jobs.get(request.params.jobId);

  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  response.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    trackName: job.trackName,
    sizeBytes: job.sizeBytes,
    error: job.error,
    result: job.result,
  });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: error?.message || "Unexpected server error.",
  });
});

if (fs.existsSync(distRoot)) {
  app.use(express.static(distRoot));
  app.get(/^(?!\/api|\/stems).*/, (_request, response) => {
    response.sendFile(path.join(distRoot, "index.html"));
  });
}

function runSeparationJob(job) {
  job.status = "processing";
  logJobStage(job, "Separation job started");

  const child = spawn(
    pythonBin,
    [workerScript, "--input", job.inputPath, "--output", job.outputDirectory],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...(pythonCertificateFile
          ? {
              SSL_CERT_FILE: pythonCertificateFile,
              REQUESTS_CA_BUNDLE: pythonCertificateFile,
            }
          : {}),
      },
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    const next = chunk.toString();
    stderr += next;
    next
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        console.log(`[job ${job.id}] ${line}`);
      });
  });

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    logJobStage(job, `Process error: ${error.message}`);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      job.status = "failed";
      job.error = (stderr || stdout || "Separation failed.").trim();
      logJobStage(job, `Separation failed: ${job.error}`);
      return;
    }

    void (async () => {
      const payload = JSON.parse(stdout.trim());
      job.status = "completed";
      job.result = payload;
      logJobStage(job, "Demucs finished, persisting stems");
      await persistCompletedJob(job);
      logJobStage(job, "Stems persisted");
    })().catch((error) => {
      job.status = "failed";
      job.error = `Could not parse separator output: ${error.message}`;
      logJobStage(job, job.error);
    });
  });
}

function runExpandOtherJob(job) {
  job.status = "processing";
  logJobStage(job, "Expand-other job started");

  const child = spawn(
    pythonBin,
    [
      workerScript,
      "--mode",
      "expand-other",
      "--input",
      job.inputPath,
      "--output",
      job.outputDirectory,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...(pythonCertificateFile
          ? {
              SSL_CERT_FILE: pythonCertificateFile,
              REQUESTS_CA_BUNDLE: pythonCertificateFile,
            }
          : {}),
      },
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    const next = chunk.toString();
    stderr += next;
    next
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        console.log(`[job ${job.id}] ${line}`);
      });
  });

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    logJobStage(job, `Process error: ${error.message}`);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      job.status = "failed";
      job.error = (stderr || stdout || "Could not expand the other stem.").trim();
      logJobStage(job, `Expand-other failed: ${job.error}`);
      return;
    }

    void (async () => {
      const payload = JSON.parse(stdout.trim());
      job.status = "completed";
      job.result = payload;
      logJobStage(job, "Expanded layers created, persisting output");
      await persistExpandedOther(job);
      logJobStage(job, "Expanded layers persisted");
    })().catch((error) => {
      job.status = "failed";
      job.error = `Could not parse expanded other output: ${error.message}`;
      logJobStage(job, job.error);
    });
  });
}

async function persistCompletedJob(job) {
  const record = await buildTrackRecord(job);

  if (supabase) {
    await upsertSupabaseTrack(record);
    return;
  }

  const existingIndex = library.findIndex((item) => item.id === job.id);
  if (existingIndex === -1) {
    library.unshift(record);
  } else {
    library[existingIndex] = record;
  }

  saveLibraryManifest();
}

async function persistExpandedOther(job) {
  const existingIndex = library.findIndex((item) => item.id === job.libraryId);
  const currentItem =
    existingIndex === -1
      ? (await loadSupabaseLibrary()).find((item) => item.id === job.libraryId)
      : library[existingIndex];

  if (!currentItem) {
    return;
  }

  const otherLayers = await persistOtherLayerAssets(job);

  if (supabase) {
    await upsertSupabaseTrack({
      ...currentItem,
      otherLayers,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  library[existingIndex] = {
    ...library[existingIndex],
    otherLayers,
    updatedAt: new Date().toISOString(),
  };

  saveLibraryManifest();
}

async function buildTrackRecord(job) {
  const sourceUrl = supabase
    ? await persistAssetToSupabase(job.inputPath, `${job.id}/source/${path.basename(job.inputPath)}`)
    : `/stems/${path.relative(jobsRoot, job.inputPath).split(path.sep).join("/")}`;

  const stems = supabase
    ? await Promise.all(
        (job.result?.stems || []).map(async (stem) => {
          const localPath = path.join(jobsRoot, stem.url.replace("/stems/", ""));
          const uploadedUrl = await persistAssetToSupabase(
            localPath,
            `${job.id}/stems/${path.basename(localPath)}`
          );
          return {
            ...stem,
            url: uploadedUrl,
          };
        })
      )
    : job.result?.stems || [];

  return {
    id: job.id,
    createdAt: job.createdAt,
    trackName: job.trackName,
    sizeBytes: job.sizeBytes,
    sourceUrl,
    analysis: job.result?.analysis || null,
    stems,
    otherLayers: [],
  };
}

async function persistOtherLayerAssets(job) {
  if (!supabase) {
    return job.result?.layers || [];
  }

  return Promise.all(
    (job.result?.layers || []).map(async (layer) => {
      const localPath = path.join(jobsRoot, layer.url.replace("/stems/", ""));
      const uploadedUrl = await persistAssetToSupabase(
        localPath,
        `${job.libraryId}/other-layers/${path.basename(localPath)}`
      );
      return {
        ...layer,
        url: uploadedUrl,
      };
    })
  );
}

function loadLibraryManifest() {
  try {
    if (!fs.existsSync(libraryManifestPath)) {
      return [];
    }

    const rawText = fs.readFileSync(libraryManifestPath, "utf8");
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not load library manifest.", error);
    return [];
  }
}

function saveLibraryManifest() {
  fs.writeFileSync(libraryManifestPath, JSON.stringify(library, null, 2));
}

async function loadSupabaseLibrary() {
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(mapSupabaseTrackRecord);
}

async function upsertSupabaseTrack(record) {
  const payload = {
    id: record.id,
    created_at: record.createdAt,
    updated_at: record.updatedAt || null,
    track_name: record.trackName,
    size_bytes: record.sizeBytes,
    source_url: record.sourceUrl,
    bpm: record.analysis?.bpm ?? null,
    musical_key: record.analysis?.key ?? null,
    key_scale: record.analysis?.scale ?? null,
    key_label: record.analysis?.keyLabel ?? null,
    stems: record.stems || [],
    other_layers: record.otherLayers || [],
  };

  const { error } = await supabase.from("tracks").upsert(payload);
  if (error) {
    throw new Error(error.message);
  }
}

async function findLibraryItemById(id) {
  if (!supabase) {
    return library.find((entry) => entry.id === id) || null;
  }

  const { data, error } = await supabase.from("tracks").select("*").eq("id", id).maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data ? mapSupabaseTrackRecord(data) : null;
}

function mapSupabaseTrackRecord(record) {
  return {
    id: record.id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    trackName: record.track_name,
    sizeBytes: record.size_bytes,
    sourceUrl: record.source_url,
    analysis: {
      bpm: record.bpm,
      key: record.musical_key,
      scale: record.key_scale,
      keyLabel: record.key_label,
    },
    stems: record.stems || [],
    otherLayers: record.other_layers || [],
  };
}

async function persistAssetToSupabase(localPath, remotePath) {
  const fileBuffer = fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from(supabaseStorageBucket)
    .upload(remotePath, fileBuffer, {
      upsert: true,
      contentType: getContentType(localPath),
    });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage.from(supabaseStorageBucket).getPublicUrl(remotePath);
  return data.publicUrl;
}

async function resolveStoredAssetToLocalPath(assetUrl, cachePathFragment) {
  if (!supabase || assetUrl.startsWith("/stems/")) {
    return path.join(jobsRoot, decodeURIComponent(assetUrl.replace("/stems/", "")));
  }

  const remotePath = extractStoragePathFromPublicUrl(assetUrl);
  if (!remotePath) {
    return "";
  }

  const cachePath = path.join(storageRoot, "cache", cachePathFragment);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  const { data, error } = await supabase.storage.from(supabaseStorageBucket).download(remotePath);
  if (error) {
    throw new Error(error.message);
  }

  const arrayBuffer = await data.arrayBuffer();
  fs.writeFileSync(cachePath, Buffer.from(arrayBuffer));
  return cachePath;
}

function extractStoragePathFromPublicUrl(assetUrl) {
  const marker = `/storage/v1/object/public/${supabaseStorageBucket}/`;
  const index = assetUrl.indexOf(marker);
  if (index === -1) {
    return "";
  }

  return assetUrl.slice(index + marker.length);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

function matchesLibraryQuery(item, query) {
  if (!query) return true;

  const haystack = [
    item.trackName,
    item.analysis?.key,
    item.analysis?.scale,
    item.analysis?.keyLabel,
    item.analysis?.bpm,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function resolvePythonCertificateFile() {
  const certifiResult = spawnSync(
    "python3",
    ["-c", "import certifi; print(certifi.where())"],
    { encoding: "utf8" }
  );

  if (certifiResult.status === 0) {
    return certifiResult.stdout.trim();
  }

  const sslResult = spawnSync(
    "python3",
    ["-c", "import ssl; print(ssl.get_default_verify_paths().openssl_cafile or '')"],
    { encoding: "utf8" }
  );

  if (sslResult.status === 0) {
    return sslResult.stdout.trim();
  }

  return "";
}

app.listen(port, host, () => {
  console.log(`Song Layer Studio API listening on http://${host}:${port}`);
});
