import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONFIG = window.SCRIPTROOM_CONFIG || {};
const SUPABASE_URL = CONFIG.SUPABASE_URL || "";
const SUPABASE_KEY = CONFIG.SUPABASE_PUBLISHABLE_KEY || "";
const BUCKET = "screenplays";
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const configured = Boolean(
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_KEY &&
  !SUPABASE_URL.includes("PASTE_") &&
  !SUPABASE_KEY.includes("PASTE_")
);
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const $ = (selector) => document.querySelector(selector);
const grid = $("#screenplay-grid");
const toastRegion = $("#toast-region");
let screenplays = [];
let currentUser = null;
let isAdmin = false;
let activeReaderId = null;
let pdfjsLibraryPromise = null;
let readerDocument = null;
let readerLoadingTask = null;
let readerRenderTask = null;
let readerPageNumber = 1;
let readerZoom = 1;
let readerFitWidth = true;
let readerNightPage = false;
let readerSearchMatches = [];
let readerSearchMatchIndex = -1;
let readerSearchCache = new Map();

// ---------- Theme ----------
const savedTheme = localStorage.getItem("scriptroom-theme");
if (savedTheme === "light" || savedTheme === "dark") {
  document.documentElement.dataset.theme = savedTheme;
}
updateThemeButton();

$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("scriptroom-theme", next);
  updateThemeButton();
});

function updateThemeButton() {
  const light = document.documentElement.dataset.theme === "light";
  $("#theme-toggle").setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
  document.querySelector('meta[name="theme-color"]').content = light ? "#f4f1e9" : "#11110f";
}

// ---------- Small helpers ----------
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function formatDate(value) {
  if (!value) return "DATE UNKNOWN";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNKNOWN";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(date).toUpperCase();
}

function formatBytes(bytes = 0) {
  if (!Number(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function hueFromTitle(title = "Script") {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function setConnectionStatus(label, state = "") {
  const pill = $("#connection-status");
  pill.className = `connection-pill ${state}`.trim();
  pill.querySelector("span").textContent = label;
}

function setButtonBusy(button, busy, busyText = "Working...") {
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => closeDialog(button.dataset.close));
});

document.querySelectorAll("dialog.modal").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

// ---------- Library rendering ----------
function getVisibleScreenplays() {
  const query = $("#search-input").value.trim().toLowerCase();
  const genre = $("#genre-filter").value;
  const sort = $("#sort-filter").value;
  let visible = screenplays.filter((item) => {
    const haystack = `${item.title || ""} ${item.genre || ""} ${item.description || ""} ${item.script_year || ""}`.toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesGenre = genre === "all" || item.genre === genre;
    return matchesQuery && matchesGenre;
  });

  if (sort === "oldest") visible.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  else if (sort === "az") visible.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  else visible.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return visible;
}

function renderStats() {
  const genres = new Set(screenplays.map((item) => item.genre).filter(Boolean));
  const totalBytes = screenplays.reduce((sum, item) => sum + Number(item.file_size || 0), 0);
  $("#stat-total").textContent = String(screenplays.length).padStart(2, "0");
  $("#stat-genres").textContent = String(genres.size).padStart(2, "0");
  $("#stat-size").textContent = formatBytes(totalBytes);
}

function renderGenreOptions() {
  const select = $("#genre-filter");
  const current = select.value;
  const genres = [...new Set(screenplays.map((item) => item.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="all">All genres</option>' + genres.map((genre) => `<option value="${escapeHtml(genre)}">${escapeHtml(genre)}</option>`).join("");
  if (genres.includes(current)) select.value = current;
}

function renderLibrary() {
  const visible = getVisibleScreenplays();
  $("#results-count").textContent = `${visible.length} ${visible.length === 1 ? "TITLE" : "TITLES"} ${visible.length !== screenplays.length ? ` / ${screenplays.length} IN ARCHIVE` : "IN ARCHIVE"}`;
  grid.setAttribute("aria-busy", "false");

  if (!visible.length) {
    const hasFilters = $("#search-input").value.trim() || $("#genre-filter").value !== "all";
    const title = hasFilters ? "No matching screenplays." : "The first page is waiting.";
    const message = hasFilters
      ? "Try a different title, note or genre. The archive is a little particular."
      : configured
        ? "There are no screenplays in the collection yet. The next story can start here."
        : "Connect your Supabase project in config.js, then the library will be ready for its first upload.";
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3.8h8l4 4V20H6V3.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 4v4h4M8.5 14h7m-7 3h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
        <h3>${title}</h3><p>${message}</p>
      </div>`;
    return;
  }

  grid.innerHTML = visible.map((item, index) => {
    const hue = hueFromTitle(item.title || "Script");
    const genre = item.genre || "Uncategorized";
    const date = formatDate(item.created_at);
    const year = item.script_year ? ` · ${escapeHtml(item.script_year)}` : "";
    return `
      <article class="script-card" style="animation-delay:${Math.min(index * 45, 350)}ms">
        <button class="card-main" type="button" data-open-id="${escapeHtml(item.id)}" aria-label="Read ${escapeHtml(item.title)}">
          <div class="poster" style="--hue:${hue}">
            <div class="poster-top"><span>SCREENPLAY / ${String(index + 1).padStart(2, "0")}</span><span>SR—${String(index + 1).padStart(3, "0")}</span></div>
            <div class="poster-monogram">${escapeHtml((item.title || "S").trim().charAt(0).toUpperCase())}</div>
            <div class="poster-bottom"><span>${escapeHtml(genre)}</span><span>PDF / ${escapeHtml(item.file_size ? formatBytes(item.file_size) : "FILE")}</span></div>
          </div>
          <div class="card-info">
            <div class="card-title-row"><h3 class="card-title">${escapeHtml(item.title)}</h3></div>
            <div class="card-date">ADDED ${date}${year}</div>
            ${item.description ? `<p class="card-description">${escapeHtml(item.description)}</p>` : ""}
          </div>
        </button>
        ${isAdmin ? `<button class="card-admin-delete" type="button" data-delete-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)}" title="Delete screenplay"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
      </article>`;
  }).join("");
}

async function loadScreenplays() {
  if (!configured) {
    setConnectionStatus("Setup required", "error");
    screenplays = [];
    renderStats();
    renderGenreOptions();
    renderLibrary();
    return;
  }

  grid.setAttribute("aria-busy", "true");
  setConnectionStatus("Connecting", "");
  const { data, error } = await supabase
    .from("screenplays")
    .select("id,title,description,genre,script_year,file_path,file_name,file_size,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Could not load screenplays:", error);
    setConnectionStatus("Connection issue", "error");
    grid.setAttribute("aria-busy", "false");
    grid.innerHTML = `<div class="empty-state"><h3>Couldn't open the archive.</h3><p>${escapeHtml(error.message)} Check the Supabase setup and table permissions, then refresh.</p></div>`;
    $("#results-count").textContent = "LIBRARY UNAVAILABLE";
    return;
  }

  screenplays = data || [];
  setConnectionStatus("Library online", "connected");
  renderStats();
  renderGenreOptions();
  renderLibrary();
}

// ---------- Authentication / admin-only controls ----------
function renderAuthState() {
  $("#admin-button").hidden = Boolean(currentUser && isAdmin);
  $("#admin-session").hidden = !(currentUser && isAdmin);
  $("#upload-button").hidden = !isAdmin;
  if (!isAdmin) renderLibrary();
}

async function checkAdmin() {
  if (!currentUser || !supabase) {
    isAdmin = false;
    renderAuthState();
    return false;
  }
  const userId = currentUser.id;
  const { data, error } = await supabase
    .from("admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  isAdmin = !error && Boolean(data);
  renderAuthState();
  return isAdmin;
}

$("#admin-button").addEventListener("click", () => {
  if (!configured) {
    showToast("Add your Supabase URL and key in config.js first.", "error");
    return;
  }
  openDialog("login-dialog");
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase) return;
  const button = $("#login-submit");
  setButtonBusy(button, true, "Signing in...");
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  setButtonBusy(button, false);

  if (error) {
    showToast(error.message || "Sign-in failed.", "error");
    return;
  }

  currentUser = data.user;
  const admin = await checkAdmin();
  if (!admin) {
    await supabase.auth.signOut();
    currentUser = null;
    isAdmin = false;
    renderAuthState();
    showToast("This account is not registered as a Scriptroom administrator.", "error");
    return;
  }

  closeDialog("login-dialog");
  $("#login-form").reset();
  showToast("Signed in. The archive is yours to manage.");
});

$("#sign-out-button").addEventListener("click", async () => {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) showToast(error.message, "error");
  else showToast("You have signed out.");
  currentUser = null;
  isAdmin = false;
  renderAuthState();
});

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    if (!currentUser) {
      isAdmin = false;
      renderAuthState();
    } else {
      // Run after the auth callback returns; Supabase requests inside this callback can deadlock.
      window.setTimeout(() => checkAdmin(), 0);
    }
  });
}

// ---------- Upload / delete ----------
$("#upload-button").addEventListener("click", () => {
  if (!isAdmin) return showToast("Administrator access is required.", "error");
  $("#upload-form").reset();
  $("#file-name").textContent = "Choose a PDF to upload";
  $("#file-help").textContent = "Click to browse or drop a file here · MAX 50 MB";
  openDialog("upload-dialog");
});

$("#script-file").addEventListener("change", updateSelectedFile);
function updateSelectedFile() {
  const file = $("#script-file").files?.[0];
  if (!file) {
    $("#file-name").textContent = "Choose a PDF to upload";
    $("#file-help").textContent = "Click to browse or drop a file here · MAX 50 MB";
    return;
  }
  $("#file-name").textContent = file.name;
  $("#file-help").textContent = `${formatBytes(file.size)} · PDF DOCUMENT`;
}

const dropArea = $("#file-drop");
["dragenter", "dragover"].forEach((name) => dropArea.addEventListener(name, (event) => {
  event.preventDefault();
  dropArea.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropArea.addEventListener(name, (event) => {
  event.preventDefault();
  dropArea.classList.remove("dragging");
}));
dropArea.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  $("#script-file").files = transfer.files;
  updateSelectedFile();
});

$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase || !isAdmin) return showToast("Administrator access is required to upload.", "error");

  const title = $("#script-title").value.trim();
  const genre = $("#script-genre").value;
  const description = $("#script-description").value.trim();
  const yearValue = $("#script-year").value.trim();
  const file = $("#script-file").files?.[0];

  if (!title || !file) return showToast("Add a title and choose a PDF file.", "error");
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") return showToast("That file does not look like a PDF.", "error");
  if (file.size > MAX_FILE_SIZE) return showToast("This PDF is larger than 50 MB.", "error");
  if (file.size === 0) return showToast("The selected PDF is empty.", "error");
  const scriptYear = yearValue ? Number(yearValue) : null;
  if (scriptYear && (scriptYear < 1900 || scriptYear > 2100)) return showToast("Enter a year between 1900 and 2100.", "error");

  const button = $("#upload-submit");
  setButtonBusy(button, true, "Uploading PDF...");
  const filePath = `${crypto.randomUUID()}.pdf`;
  let uploaded = false;

  try {
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(filePath, file, {
      cacheControl: "3600",
      contentType: "application/pdf",
      upsert: false
    });
    if (uploadError) throw uploadError;
    uploaded = true;

    const { error: insertError } = await supabase.from("screenplays").insert({
      title,
      genre,
      description,
      script_year: scriptYear,
      file_path: filePath,
      file_name: file.name,
      file_size: file.size
    });
    if (insertError) throw insertError;

    closeDialog("upload-dialog");
    $("#upload-form").reset();
    updateSelectedFile();
    showToast("Screenplay added to the library.");
    await loadScreenplays();
  } catch (error) {
    console.error("Upload failed:", error);
    if (uploaded) {
      const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([filePath]);
      if (cleanupError) console.error("Could not clean up the uploaded file:", cleanupError);
    }
    showToast(error.message || "Upload failed. Check your connection and try again.", "error");
  } finally {
    setButtonBusy(button, false);
  }
});

grid.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-id]");
  if (openButton) {
    const item = screenplays.find((entry) => entry.id === openButton.dataset.openId);
    if (item) await openReader(item);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) {
    if (!isAdmin) return showToast("Administrator access is required.", "error");
    const item = screenplays.find((entry) => entry.id === deleteButton.dataset.deleteId);
    if (!item) return;
    const confirmed = window.confirm(`Delete “${item.title}” from the library? This also removes its PDF file.`);
    if (!confirmed) return;
    deleteButton.disabled = true;
    try {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove([item.file_path]);
      if (storageError) throw storageError;
      const { error: rowError } = await supabase.from("screenplays").delete().eq("id", item.id);
      if (rowError) throw rowError;
      showToast("Screenplay removed from the archive.");
      await loadScreenplays();
    } catch (error) {
      console.error("Delete failed:", error);
      showToast(error.message || "Could not delete this screenplay.", "error");
      deleteButton.disabled = false;
    }
  }
});

// ---------- Custom PDF reader (PDF.js) ----------
const PDFJS_VERSION = "6.5.438";
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

async function getPdfJs() {
  if (!pdfjsLibraryPromise) {
    pdfjsLibraryPromise = import(`${PDFJS_CDN}/pdf.mjs`).then((library) => {
      library.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.mjs`;
      return library;
    }).catch((error) => {
      pdfjsLibraryPromise = null;
      throw error;
    });
  }
  return pdfjsLibraryPromise;
}

function setReaderLoading(message, detail = "") {
  const loading = $("#reader-loading");
  loading.hidden = false;
  loading.innerHTML = `
    <span class="loading-spinner"></span>
    <strong>${escapeHtml(message)}</strong>
    <span>${escapeHtml(detail)}</span>`;
  $("#reader-stage").hidden = true;
}

function setReaderError(message) {
  const loading = $("#reader-loading");
  loading.hidden = false;
  loading.innerHTML = `
    <span class="reader-error-mark">!</span>
    <strong>We couldn't open this PDF</strong>
    <span>${escapeHtml(message || "Check your connection and try again.")}</span>`;
  $("#reader-stage").hidden = true;
}

function updateReaderControls() {
  const pageCount = readerDocument?.numPages || 0;
  $("#reader-page-input").value = String(readerPageNumber);
  $("#reader-page-input").max = String(pageCount || 1);
  $("#reader-page-count").textContent = pageCount ? String(pageCount) : "—";
  $("#reader-prev").disabled = !pageCount || readerPageNumber <= 1;
  $("#reader-next").disabled = !pageCount || readerPageNumber >= pageCount;
  $("#reader-zoom-value").textContent = readerFitWidth ? "Fit" : `${Math.round(readerZoom * 100)}%`;
  $("#reader-fit").setAttribute("aria-pressed", String(readerFitWidth));
  $("#reader-night-toggle").setAttribute("aria-pressed", String(readerNightPage));
  $("#reader-canvas").classList.toggle("night-page", readerNightPage);
  $("#reader-footer-page").textContent = pageCount ? `PAGE ${readerPageNumber} / ${pageCount}` : "PAGE —";
}

async function renderReaderPage({ scrollToTop = true } = {}) {
  if (!readerDocument) return;
  const pageNumber = Math.min(Math.max(readerPageNumber, 1), readerDocument.numPages);
  readerPageNumber = pageNumber;
  updateReaderControls();

  if (readerRenderTask) {
    try { readerRenderTask.cancel(); } catch (_) { /* A completed task cannot be cancelled. */ }
    readerRenderTask = null;
  }

  const pdfPage = await readerDocument.getPage(pageNumber);
  if (!readerDocument || pageNumber !== readerPageNumber) return;

  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const availableWidth = Math.max(280, $("#reader-body").clientWidth - 64);
  const scale = readerFitWidth
    ? Math.max(0.45, Math.min(1.8, availableWidth / baseViewport.width))
    : Math.max(0.5, Math.min(2.5, readerZoom));
  const viewport = pdfPage.getViewport({ scale });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = $("#reader-canvas");
  const context = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.classList.toggle("night-page", readerNightPage);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const renderTask = pdfPage.render({
    canvasContext: context,
    viewport,
    transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
  });
  readerRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
  } finally {
    if (readerRenderTask === renderTask) readerRenderTask = null;
  }

  if (scrollToTop) $("#reader-body").scrollTo({ top: 0, behavior: "smooth" });
  updateReaderControls();
}

async function openReader(item) {
  if (!supabase) return;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(item.file_path);
  const url = data?.publicUrl;
  if (!url) return showToast("Could not create a PDF link.", "error");

  activeReaderId = item.id;
  readerPageNumber = 1;
  readerZoom = 1;
  readerFitWidth = true;
  readerNightPage = false;
  readerSearchMatches = [];
  readerSearchMatchIndex = -1;
  readerSearchCache = new Map();
  $("#reader-title").textContent = item.title;
  $("#reader-meta").textContent = `${item.genre || "Uncategorized"} · ${formatDate(item.created_at)} · ${formatBytes(item.file_size || 0)}`;
  $("#reader-open-link").href = url;
  $("#reader-search-input").value = "";
  $("#reader-search-status").textContent = "Search the script";
  updateReaderControls();
  setReaderLoading("Preparing your screenplay", "Loading the PDF reader…");
  openDialog("reader-dialog");

  try {
    if (readerRenderTask) {
      try { readerRenderTask.cancel(); } catch (_) { /* Ignore completed render. */ }
      readerRenderTask = null;
    }
    if (readerLoadingTask) {
      try { await readerLoadingTask.destroy(); } catch (_) { /* Ignore previous loading task cleanup. */ }
      readerLoadingTask = null;
    }
    if (readerDocument) {
      try { await readerDocument.destroy(); } catch (_) { /* Ignore previous document cleanup. */ }
      readerDocument = null;
    }

    const pdfjs = await getPdfJs();
    if (activeReaderId !== item.id) return;
    readerLoadingTask = pdfjs.getDocument({ url, isEvalSupported: false });
    readerDocument = await readerLoadingTask.promise;
    if (activeReaderId !== item.id) return;

    $("#reader-loading").hidden = true;
    $("#reader-stage").hidden = false;
    updateReaderControls();
    await renderReaderPage();
  } catch (error) {
    console.error("PDF reader error:", error);
    if (activeReaderId === item.id) {
      const message = error?.message?.includes("CORS")
        ? "The PDF host blocked cross-origin reading. Check the Supabase Storage settings."
        : error?.message || "The PDF may be damaged or unavailable.";
      setReaderError(message);
    }
  }
}

async function changeReaderPage(nextPage) {
  if (!readerDocument) return;
  readerPageNumber = Math.min(Math.max(Number(nextPage) || 1, 1), readerDocument.numPages);
  try {
    await renderReaderPage();
  } catch (error) {
    console.error("Page render failed:", error);
    setReaderError(error.message);
  }
}

$("#reader-prev").addEventListener("click", () => changeReaderPage(readerPageNumber - 1));
$("#reader-next").addEventListener("click", () => changeReaderPage(readerPageNumber + 1));
$("#reader-page-input").addEventListener("change", (event) => changeReaderPage(event.target.value));
$("#reader-page-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    changeReaderPage(event.currentTarget.value);
    event.currentTarget.blur();
  }
});

$("#reader-zoom-in").addEventListener("click", () => {
  readerFitWidth = false;
  readerZoom = Math.min(2.5, Math.round((readerZoom + 0.1) * 10) / 10);
  updateReaderControls();
  renderReaderPage({ scrollToTop: false }).catch((error) => setReaderError(error.message));
});
$("#reader-zoom-out").addEventListener("click", () => {
  readerFitWidth = false;
  readerZoom = Math.max(0.5, Math.round((readerZoom - 0.1) * 10) / 10);
  updateReaderControls();
  renderReaderPage({ scrollToTop: false }).catch((error) => setReaderError(error.message));
});
$("#reader-fit").addEventListener("click", () => {
  readerFitWidth = true;
  updateReaderControls();
  renderReaderPage({ scrollToTop: false }).catch((error) => setReaderError(error.message));
});
$("#reader-night-toggle").addEventListener("click", () => {
  readerNightPage = !readerNightPage;
  updateReaderControls();
});
$("#reader-fullscreen").addEventListener("click", async () => {
  const shell = $(".reader-shell");
  try {
    if (!document.fullscreenElement) await shell.requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) {
    showToast("Fullscreen is unavailable in this browser.", "error");
  }
});

async function getReaderSearchMatches(query) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery || !readerDocument) return [];
  const matches = [];
  for (let pageNumber = 1; pageNumber <= readerDocument.numPages; pageNumber += 1) {
    if (activeReaderId === null) return [];
    let text = readerSearchCache.get(pageNumber);
    if (text === undefined) {
      const page = await readerDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      text = content.items.map((item) => item.str || "").join(" ").toLocaleLowerCase();
      readerSearchCache.set(pageNumber, text);
    }
    let offset = 0;
    while ((offset = text.indexOf(normalizedQuery, offset)) !== -1) {
      matches.push({ page: pageNumber, offset });
      offset += normalizedQuery.length;
    }
    if (pageNumber % 12 === 0) {
      $("#reader-search-status").textContent = `Searching ${pageNumber} / ${readerDocument.numPages}…`;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return matches;
}

async function runReaderSearch(direction = 1, fresh = false) {
  const query = $("#reader-search-input").value.trim();
  if (!query) {
    readerSearchMatches = [];
    readerSearchMatchIndex = -1;
    $("#reader-search-status").textContent = "Search the script";
    return;
  }
  if (!readerDocument) return;
  if (fresh || !readerSearchMatches.length) {
    $("#reader-search-status").textContent = "Searching…";
    try {
      readerSearchMatches = await getReaderSearchMatches(query);
    } catch (error) {
      console.error("PDF search failed:", error);
      $("#reader-search-status").textContent = "Search unavailable";
      return;
    }
    readerSearchMatchIndex = direction > 0 ? 0 : readerSearchMatches.length - 1;
  } else {
    readerSearchMatchIndex = (readerSearchMatchIndex + direction + readerSearchMatches.length) % readerSearchMatches.length;
  }

  if (!readerSearchMatches.length) {
    $("#reader-search-status").textContent = "No matches";
    return;
  }
  const match = readerSearchMatches[readerSearchMatchIndex];
  $("#reader-search-status").textContent = `Match ${readerSearchMatchIndex + 1} of ${readerSearchMatches.length} · page ${match.page}`;
  await changeReaderPage(match.page);
}

$("#reader-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runReaderSearch(1, true);
  }
});
$("#reader-search-next").addEventListener("click", () => runReaderSearch(1));
$("#reader-search-prev").addEventListener("click", () => runReaderSearch(-1));
$("#reader-search-input").addEventListener("input", () => {
  readerSearchMatches = [];
  readerSearchMatchIndex = -1;
  $("#reader-search-status").textContent = "Press Enter to search";
});

window.addEventListener("resize", () => {
  if (!readerDocument || !readerFitWidth || !$("#reader-dialog").open) return;
  window.clearTimeout(window.__scriptroomReaderResize);
  window.__scriptroomReaderResize = window.setTimeout(() => {
    renderReaderPage({ scrollToTop: false }).catch((error) => console.warn("Reader resize failed:", error));
  }, 140);
});

document.addEventListener("keydown", (event) => {
  if (!$("#reader-dialog").open) return;
  const target = event.target;
  const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
  if (typing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    changeReaderPage(readerPageNumber - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    changeReaderPage(readerPageNumber + 1);
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    $("#reader-zoom-in").click();
  } else if (event.key === "-") {
    event.preventDefault();
    $("#reader-zoom-out").click();
  }
});

$("#reader-dialog").addEventListener("close", async () => {
  activeReaderId = null;
  readerSearchMatches = [];
  readerSearchCache.clear();
  if (readerRenderTask) {
    try { readerRenderTask.cancel(); } catch (_) { /* Ignore completed render. */ }
    readerRenderTask = null;
  }
  if (readerLoadingTask) {
    try { await readerLoadingTask.destroy(); } catch (_) { /* Ignore cleanup errors. */ }
    readerLoadingTask = null;
  }
  if (readerDocument) {
    try { await readerDocument.destroy(); } catch (_) { /* Ignore cleanup errors. */ }
    readerDocument = null;
  }
  const canvas = $("#reader-canvas");
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
});

// ---------- Search and sorting ----------
$("#search-input").addEventListener("input", renderLibrary);
$("#genre-filter").addEventListener("change", renderLibrary);
$("#sort-filter").addEventListener("change", renderLibrary);
document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.activeElement?.isContentEditable;
  if (event.key === "/" && !typing && !$("#reader-dialog").open && !$("#login-dialog").open && !$("#upload-dialog").open) {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape" && activeReaderId) {
    // The native dialog handles Escape; this branch is intentionally just a state guard.
  }
});

// ---------- Startup ----------
async function start() {
  if (!configured) {
    await loadScreenplays();
    return;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) console.warn("Could not restore admin session:", error.message);
  currentUser = data?.session?.user || null;
  if (currentUser) await checkAdmin();
  await loadScreenplays();
}

start().catch((error) => {
  console.error("Scriptroom startup error:", error);
  setConnectionStatus("Connection issue", "error");
  grid.setAttribute("aria-busy", "false");
  grid.innerHTML = '<div class="empty-state"><h3>The archive hit a snag.</h3><p>Refresh the page and try again. If it keeps happening, check the Supabase setup.</p></div>';
});
