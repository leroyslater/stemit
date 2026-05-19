import { useEffect, useMemo, useRef, useState } from "react";

const STEM_ORDER = ["vocals", "drums", "bass", "other"];

const stemDescriptions = {
  vocals: "Lead and backing voices separated into a dedicated stem.",
  drums: "Kick, snare, cymbals, and the main percussive energy.",
  bass: "Low-end melodic movement and bass foundation.",
  other: "Everything else, usually keys, guitars, synths, and textures.",
};

const otherLayerDescriptions = {
  foundation: "Lower support and weight from the catch-all stem.",
  groove: "Rhythmic mids and body pulled from the other stem.",
  detail: "Forward harmonics and melodic articulation.",
  air: "Top-end shimmer and upper texture from the other stem.",
};
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getAnalysisValue(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "--";
  return `${value}${suffix}`;
}

function normalizeStems(stems = []) {
  const sortedStems = [...stems].sort((left, right) => {
    return STEM_ORDER.indexOf(left.id) - STEM_ORDER.indexOf(right.id);
  });

  return sortedStems.map((stem) => ({
    ...stem,
    description: stemDescriptions[stem.id] || "Separated audio stem.",
  }));
}

async function readJsonSafely(response) {
  const rawText = await response.text();

  if (!rawText) {
    return { payload: {}, rawText: "" };
  }

  try {
    return { payload: JSON.parse(rawText), rawText };
  } catch {
    throw new Error(
      response.ok
        ? "The server returned an invalid response."
        : rawText || "The server returned an invalid error response."
    );
  }
}

function buildHttpError(response, payload, fallbackMessage, rawText = "") {
  const details =
    payload?.error ||
    rawText.trim() ||
    `${response.status} ${response.statusText}`.trim();

  return new Error(details ? `${fallbackMessage} ${details}` : fallbackMessage);
}

function getProgressState(job, isSubmitting) {
  if (isSubmitting) {
    return {
      value: 12,
      label: "Uploading track to the local separator",
    };
  }

  if (!job) {
    return {
      value: 0,
      label: "Waiting for a track",
    };
  }

  if (job.status === "queued") {
    return {
      value: 22,
      label: "Job queued and ready to start",
    };
  }

  if (job.status === "processing") {
    const startedAt = Date.parse(job.createdAt || "");
    const elapsedSeconds = Number.isFinite(startedAt)
      ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      : 0;
    const progressValue = Math.min(94, 28 + Math.round(elapsedSeconds / 2.4));

    let label = "Preparing the model and loading audio";
    if (elapsedSeconds >= 20) label = "Separating vocals, drums, bass, and other";
    if (elapsedSeconds >= 60) label = "Finishing stems and writing output files";

    return {
      value: progressValue,
      label,
    };
  }

  if (job.status === "completed") {
    return {
      value: 100,
      label: "Stems ready",
    };
  }

  if (job.status === "failed") {
    return {
      value: 100,
      label: "Separation failed",
    };
  }

  return {
    value: 0,
    label: "Waiting for a track",
  };
}

function getLibraryExpandStatus(item, expandingLibraryId) {
  if (expandingLibraryId === item.id) {
    return {
      label: "Expanding...",
      className: "is-expanding",
      detail: "Creating secondary layers from the saved other stem.",
    };
  }

  if (item.otherLayers?.length) {
    return {
      label: "Expanded",
      className: "is-expanded",
      detail: `${item.otherLayers.length} secondary layers saved.`,
    };
  }

  return {
    label: "Ready",
    className: "",
    detail: "You can generate extra layers from the other stem.",
  };
}

export default function App() {
  const [track, setTrack] = useState(null);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [job, setJob] = useState(null);
  const [stems, setStems] = useState([]);
  const [error, setError] = useState("");
  const [libraryItems, setLibraryItems] = useState([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [expandingLibraryId, setExpandingLibraryId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const trackUrlRef = useRef(null);
  const pollingRef = useRef(null);
  const isWorking =
    isSubmitting || job?.status === "queued" || job?.status === "processing";
  const progressState = useMemo(
    () => getProgressState(job, isSubmitting),
    [job, isSubmitting, now]
  );
  const startedAt = job?.createdAt ? Date.parse(job.createdAt) : NaN;
  const elapsedSeconds =
    isWorking && Number.isFinite(startedAt)
      ? Math.max(0, Math.round((now - startedAt) / 1000))
      : 0;

  useEffect(() => {
    return () => {
      if (trackUrlRef.current) {
        URL.revokeObjectURL(trackUrlRef.current);
      }
      if (pollingRef.current) {
        window.clearTimeout(pollingRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isWorking) return undefined;

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isWorking]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      loadLibrary(libraryQuery);
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [libraryQuery]);

  const stats = useMemo(
    () => [
      { label: "Mode", value: "Demucs backend" },
      { label: "Track length", value: formatDuration(duration) },
      {
        label: "BPM",
        value: getAnalysisValue(job?.result?.analysis?.bpm),
      },
      {
        label: "Key",
        value: getAnalysisValue(job?.result?.analysis?.keyLabel),
      },
    ],
    [duration, job]
  );

  function resetJobState() {
    if (pollingRef.current) {
      window.clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    setJob(null);
    setStems([]);
  }

  async function startExpandOther(item) {
    setError("");
    setExpandingLibraryId(item.id);

    try {
      const response = await fetch(`${apiBaseUrl}/api/library/${item.id}/expand-other`, {
        method: "POST",
      });
      const { payload, rawText } = await readJsonSafely(response);

      if (!response.ok) {
        throw buildHttpError(
          response,
          payload,
          "Could not expand the other stem.",
          rawText
        );
      }

      const nextJob = {
        id: payload.jobId,
        status: payload.status,
        trackName: item.trackName,
      };

      setJob(nextJob);
      pollJob(payload.jobId);
    } catch (expandError) {
      setError(expandError.message || "Could not expand the other stem.");
      setExpandingLibraryId("");
    }
  }

  async function loadLibrary(query = "") {
    setLibraryLoading(true);

    try {
      const searchParams = new URLSearchParams();
      if (query.trim()) {
        searchParams.set("q", query.trim());
      }

      const response = await fetch(
        `${apiBaseUrl}/api/library?${searchParams.toString()}`
      );
      const { payload, rawText } = await readJsonSafely(response);

      if (!response.ok) {
        throw buildHttpError(response, payload, "Could not load library.", rawText);
      }

      setLibraryItems(payload.items || []);
    } catch (libraryError) {
      setError(libraryError.message || "Could not load library.");
    } finally {
      setLibraryLoading(false);
    }
  }

  function handleTrack(file) {
    if (!file) return;

    if (!file.type.startsWith("audio/")) {
      setError("Please choose an audio file like WAV, MP3, or M4A.");
      return;
    }

    setError("");
    setDuration(0);
    resetJobState();

    if (trackUrlRef.current) {
      URL.revokeObjectURL(trackUrlRef.current);
    }

    const url = URL.createObjectURL(file);
    trackUrlRef.current = url;

    setTrack({
      file,
      name: file.name,
      sizeBytes: file.size,
      sizeLabel: formatBytes(file.size),
      url,
    });
  }

  function onFileChange(event) {
    const [file] = event.target.files || [];
    handleTrack(file);
    event.target.value = "";
  }

  function onDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    const [file] = event.dataTransfer.files || [];
    handleTrack(file);
  }

  async function pollJob(jobId) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/jobs/${jobId}`);
      const { payload, rawText } = await readJsonSafely(response);

      if (!response.ok) {
        throw buildHttpError(
          response,
          payload,
          "Could not refresh separation status.",
          rawText
        );
      }

      setJob(payload);

      if (payload.status === "completed") {
        if (payload.result?.stems) {
          setStems(normalizeStems(payload.result?.stems));
        }
        setExpandingLibraryId("");
        loadLibrary(libraryQuery);
        pollingRef.current = null;
        return;
      }

      if (payload.status === "failed") {
        setError(payload.error || "Stem separation failed.");
        setExpandingLibraryId("");
        pollingRef.current = null;
        return;
      }

      pollingRef.current = window.setTimeout(() => {
        pollJob(jobId);
      }, 1800);
    } catch (pollError) {
      setError(pollError.message || "Could not refresh job status.");
    }
  }

  async function startSeparation() {
    if (!track?.file) {
      setError("Upload a track first.");
      return;
    }

    setError("");
    setStems([]);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("track", track.file);

      const response = await fetch(`${apiBaseUrl}/api/jobs`, {
        method: "POST",
        body: formData,
      });
      const { payload, rawText } = await readJsonSafely(response);

      if (!response.ok) {
        throw buildHttpError(
          response,
          payload,
          "Could not start stem separation.",
          rawText
        );
      }

      const nextJob = {
        id: payload.jobId,
        status: payload.status,
        trackName: track.name,
      };

      setJob(nextJob);
      pollJob(payload.jobId);
    } catch (submitError) {
      setError(
        submitError.message ||
          "Could not reach the backend. Start `npm run dev:server` first."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Song Layer Studio</p>
          <h1>Split a song into real stems with a local React workflow.</h1>
          <p className="intro">
            Upload a track in the browser, send it to a local backend, and get
            playable Demucs-separated stems for vocals, drums, bass, and the rest
            of the arrangement.
          </p>

          <div className="hero-actions">
            <label className="button primary" htmlFor="track-upload">
              Choose audio
            </label>
            <button
              type="button"
              className="button secondary"
              onClick={startSeparation}
              disabled={!track || isWorking}
            >
              {isWorking ? "Separating..." : "Separate stems"}
            </button>
          </div>

          <div className="info-strip">
            <span>Local Node API</span>
            <span>Python Demucs worker</span>
            <span>WAV works best</span>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          {STEM_ORDER.map((stem, index) => (
            <div
              key={stem}
              className="visual-band"
              style={{ "--band-width": `${72 + index * 6}%` }}
            >
              <span>{stem}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel upload-panel">
        <div className="panel-header">
          <p className="eyebrow">Upload</p>
          <h2>Send one track into the separation pipeline</h2>
        </div>

        <div
          className={`dropzone ${isDragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <input
            id="track-upload"
            type="file"
            accept="audio/*"
            onChange={onFileChange}
          />
          <p className="dropzone-title">
            {track ? "Replace the current track" : "Drop your audio here"}
          </p>
          <p className="dropzone-copy">
            {track
              ? `${track.name} • ${track.sizeLabel}`
              : "Use WAV for the smoothest local setup. MP3 and M4A may need ffmpeg installed."}
          </p>
        </div>

        {error ? <p className="message error">{error}</p> : null}

        <div className="stats">
          {stats.map((stat) => (
            <article className="stat" key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </article>
          ))}
        </div>

        {track ? (
          <div className="player-card">
            <div className="player-head">
              <div>
                <p className="eyebrow">Source track</p>
                <h3>{track.name}</h3>
              </div>
              <div
                className={`status-pill ${
                  job?.status === "completed" ? "ready" : ""
                } ${job?.status === "failed" ? "failed" : ""}`}
              >
                {isSubmitting && "Uploading"}
                {!isSubmitting && !job && "Ready to submit"}
                {!isSubmitting && job?.status === "queued" && "Queued"}
                {!isSubmitting && job?.status === "processing" && "Separating"}
                {!isSubmitting && job?.status === "completed" && "Completed"}
                {!isSubmitting && job?.status === "failed" && "Failed"}
              </div>
            </div>

            <audio
              className="player"
              controls
              src={track.url}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
            />

            <div className="progress-card" aria-live="polite">
              <div className="progress-copy">
                <strong>{progressState.label}</strong>
                <span>
                  {isWorking
                    ? `Elapsed ${formatDuration(elapsedSeconds)}`
                    : job?.status === "completed"
                      ? "You can preview and download each stem below."
                      : "Start a separation job when you're ready."}
                </span>
              </div>
              <div
                className={`progress-track ${isWorking ? "is-active" : ""} ${
                  job?.status === "failed" ? "is-failed" : ""
                }`}
                aria-hidden="true"
              >
                <div
                  className="progress-fill"
                  style={{ width: `${progressState.value}%` }}
                />
              </div>
            </div>

            <div className="job-actions">
              <button
                type="button"
                className="button primary"
                onClick={startSeparation}
                disabled={isWorking}
              >
                {isWorking ? "Working..." : "Run Demucs separation"}
              </button>
              <p className="helper-copy">
                Backend endpoint: <code>/api/jobs</code>
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <p className="eyebrow">Status</p>
          <h2>Job progress and runtime notes</h2>
        </div>

        <div className="note-grid">
          <article className="note-card">
            <h3>Current job</h3>
            <p>
              {job
                ? `${job.trackName || track?.name} is ${job.status}.`
                : "No separation job has been submitted yet."}
            </p>
            {job ? (
              <p className="status-detail">
                {progressState.label}
                {isWorking ? ` • ${formatDuration(elapsedSeconds)} elapsed` : ""}
              </p>
            ) : null}
          </article>
          <article className="note-card">
            <h3>Song analysis</h3>
            <p>
              BPM: {getAnalysisValue(job?.result?.analysis?.bpm)}
              {" • "}
              Key: {getAnalysisValue(job?.result?.analysis?.keyLabel)}
            </p>
            <p className="status-detail">
              {job?.result?.analysis
                ? "Estimated from the uploaded source track."
                : "Analysis appears after the backend finishes processing."}
            </p>
          </article>
          <article className="note-card">
            <h3>Local setup</h3>
            <p>
              Start the API with <code>npm run dev:server</code> and install
              Python Demucs before submitting the first track.
            </p>
          </article>
        </div>
      </section>

      <section className="panel" id="library">
        <div className="panel-header">
          <p className="eyebrow">Library</p>
          <h2>Stored songs and search</h2>
        </div>

        <div className="library-toolbar">
          <input
            className="library-search"
            type="search"
            value={libraryQuery}
            onChange={(event) => setLibraryQuery(event.target.value)}
            placeholder="Search by name, BPM, or key"
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => loadLibrary(libraryQuery)}
            disabled={libraryLoading}
          >
            {libraryLoading ? "Searching..." : "Refresh library"}
          </button>
        </div>

        <div className="library-grid">
          {libraryItems.length > 0 ? (
            libraryItems.map((item) => (
              <article className="library-card" key={item.id}>
                {(() => {
                  const expandStatus = getLibraryExpandStatus(item, expandingLibraryId);

                  return (
                    <>
                <div className="library-card-top">
                  <div>
                    <h3>{item.trackName}</h3>
                    <p className="library-meta">
                      {new Date(item.createdAt).toLocaleString("en-AU")}
                    </p>
                  </div>
                  <div className="library-card-controls">
                    <span className={`library-status-pill ${expandStatus.className}`}>
                      {expandStatus.label}
                    </span>
                    <a className="button layer-button library-source" href={item.sourceUrl}>
                      Source
                    </a>
                  </div>
                </div>

                <div className="library-tags">
                  <span>{getAnalysisValue(item.analysis?.bpm, " BPM")}</span>
                  <span>{getAnalysisValue(item.analysis?.keyLabel)}</span>
                  <span>{formatBytes(item.sizeBytes)}</span>
                </div>

                <div className="library-stems">
                  {(item.stems || []).map((stem) => (
                    <a className="library-stem-link" key={stem.id} href={stem.url}>
                      {stem.name}
                    </a>
                  ))}
                </div>

                <div className="library-actions">
                  <button
                    type="button"
                    className="button secondary library-expand"
                    onClick={() => startExpandOther(item)}
                    disabled={Boolean(expandingLibraryId) || !(item.stems || []).some((stem) => stem.id === "other")}
                  >
                    {expandingLibraryId === item.id ? "Expanding..." : "Expand Other"}
                  </button>
                  <p className="library-status-detail">{expandStatus.detail}</p>
                </div>

                {item.otherLayers?.length ? (
                  <div className="other-layers-block">
                    <p className="other-layers-title">Expanded Other Layers</p>
                    <div className="other-layers-grid">
                      {item.otherLayers.map((layer) => (
                        <article className="other-layer-card" key={layer.id}>
                          <div className="layer-top">
                            <p>{layer.range}</p>
                            <span className="layer-chip" />
                          </div>
                          <h4>{layer.name}</h4>
                          <p>{otherLayerDescriptions[layer.id] || "Secondary layer from the other stem."}</p>
                          <audio className="player stem-player" controls src={layer.url} />
                          <a className="button layer-button" href={layer.url} download>
                            Download {layer.name}
                          </a>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
                    </>
                  );
                })()}
              </article>
            ))
          ) : (
            <article className="note-card library-empty">
              <h3>No saved songs yet</h3>
              <p>
                Complete a separation job and it will be stored here for future
                search.
              </p>
            </article>
          )}
        </div>
      </section>

      <section className="panel" id="stems">
        <div className="panel-header">
          <p className="eyebrow">Results</p>
          <h2>Separated stems</h2>
        </div>

        <div className="layer-grid">
          {stems.length > 0
            ? stems.map((stem) => (
                <article className="layer-card" key={stem.id}>
                  <div className="layer-top">
                    <p>{stem.id}</p>
                    <span className="layer-chip" />
                  </div>
                  <h3>{stem.name}</h3>
                  <p>{stem.description}</p>
                  <audio className="player stem-player" controls src={stem.url} />
                  <a className="button layer-button" href={stem.url} download>
                    Download {stem.name}
                  </a>
                </article>
              ))
            : STEM_ORDER.map((stem) => (
                <article className="layer-card is-placeholder" key={stem}>
                  <div className="layer-top">
                    <p>{stem}</p>
                    <span className="layer-chip muted" />
                  </div>
                  <h3>{stem[0].toUpperCase() + stem.slice(1)}</h3>
                  <p>{stemDescriptions[stem]}</p>
                </article>
              ))}
        </div>
      </section>
    </div>
  );
}
