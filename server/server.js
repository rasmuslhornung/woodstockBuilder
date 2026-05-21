const express = require("express");
const path    = require("path");
const fs      = require("fs");
const cors    = require("cors");
const multer  = require("multer");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 4000;

// Set ADMIN_PASSWORD env var before deploying, or change the fallback here
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

const PROJECTS_PATH = path.join(__dirname, "projects.json");
const UPLOADS_DIR   = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOADS_DIR))   fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROJECTS_PATH)) fs.writeFileSync(PROJECTS_PATH, "[]");

// ── Auto-recover on startup ───────────────────────────────────────────────────
// If projects.json is empty but uploads exist, rebuild from disk automatically.
// This ensures Railway redeploys never lose the project list.
(function autoRecover() {
  try {
    const existing = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
    if (existing.length > 0) return; // already populated, nothing to do

    const recovered = [];
    if (fs.existsSync(UPLOADS_DIR)) {
      for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "_tmp") continue;
        const code  = entry.name.toUpperCase();
        const dir   = path.join(UPLOADS_DIR, entry.name);
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".3dm"));
        if (!files.length) continue;
        const filename = files[0];
        const stat     = fs.statSync(path.join(dir, filename));
        recovered.push({
          code,
          projectName: filename.replace(/\.3dm$/i, ""),
          clientName:  "",
          modelType:   "production",
          filename,
          fileSize:    stat.size,
          createdAt:   stat.birthtime.toISOString()
        });
      }
    }
    if (recovered.length > 0) {
      fs.writeFileSync(PROJECTS_PATH, JSON.stringify(recovered, null, 2));
      console.log(`[startup] Auto-recovered ${recovered.length} project(s) from uploads/`);
    }
  } catch (err) {
    console.error("[startup] Auto-recover failed:", err);
  }
})();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ------- Helpers -------
function readProjects()          { return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8")); }
function writeProjects(projects) { fs.writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2)); }

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  let code;
  do {
    code = Array.from(crypto.randomBytes(6)).map(b => chars[b % chars.length]).join("");
  } while (readProjects().some(p => p.code === code));
  return code;
}

function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Multer: land in _tmp, rename into code folder after code is assigned
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmp = path.join(UPLOADS_DIR, "_tmp");
      fs.mkdirSync(tmp, { recursive: true });
      cb(null, tmp);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
  }),
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".3dm")
      return cb(new Error("Only .3dm files are allowed"));
    cb(null, true);
  },
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

// ------- Routes -------

// POST /api/viewer/projects — upload file + create project (admin)
app.post("/api/viewer/projects", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { projectName, clientName, modelType } = req.body;
  if (!projectName?.trim()) return res.status(400).json({ error: "projectName is required" });

  const code       = generateCode();
  const projectDir = path.join(UPLOADS_DIR, code);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.renameSync(req.file.path, path.join(projectDir, req.file.originalname));

  const project = {
    code,
    projectName: projectName.trim(),
    clientName:  (clientName || "").trim(),
    modelType:   modelType === "quotation" ? "quotation" : "production",
    filename:    req.file.originalname,
    fileSize:    req.file.size,
    createdAt:   new Date().toISOString()
  };

  const projects = readProjects();
  projects.unshift(project);
  writeProjects(projects);
  res.json({ ok: true, project });
});

// GET /api/viewer/projects — list all projects (admin)
app.get("/api/viewer/projects", requireAdmin, (req, res) => res.json(readProjects()));

// DELETE /api/viewer/projects/:code — delete project + files (admin)
app.delete("/api/viewer/projects/:code", requireAdmin, (req, res) => {
  const code   = req.params.code.toUpperCase();
  let projects = readProjects();
  const idx    = projects.findIndex(p => p.code === code);
  if (idx === -1) return res.status(404).json({ error: "Project not found" });

  projects.splice(idx, 1);
  writeProjects(projects);

  const dir = path.join(UPLOADS_DIR, code);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
    fs.rmdirSync(dir);
  }
  res.json({ ok: true });
});

// GET /api/viewer/project/:code — public lookup by code
app.get("/api/viewer/project/:code", (req, res) => {
  const project = readProjects().find(p => p.code === req.params.code.toUpperCase());
  if (!project) return res.status(404).json({ error: "Invalid code" });
  res.json({
    projectName: project.projectName,
    clientName:  project.clientName,
    filename:    project.filename,
    modelType:   project.modelType || "production"
  });
});

// PATCH /api/viewer/projects/:code/type — update model type (admin)
app.patch("/api/viewer/projects/:code/type", requireAdmin, express.json(), (req, res) => {
  const code = req.params.code.toUpperCase();
  const { modelType } = req.body || {};
  if (!["production", "quotation"].includes(modelType))
    return res.status(400).json({ error: "modelType must be 'production' or 'quotation'" });
  const projects = readProjects();
  const project  = projects.find(p => p.code === code);
  if (!project) return res.status(404).json({ error: "Project not found" });
  project.modelType = modelType;
  writeProjects(projects);
  res.json({ ok: true });
});

// GET /api/viewer/files/:code/:filename — stream the .3dm file
app.get("/api/viewer/files/:code/:filename", (req, res) => {
  const code    = req.params.code.toUpperCase();
  const { filename } = req.params;
  const project = readProjects().find(p => p.code === code);
  if (!project || project.filename !== filename) return res.status(404).json({ error: "Not found" });
  const filePath = path.join(UPLOADS_DIR, code, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });
  res.sendFile(filePath);
});

// POST /api/viewer/reports — receive a flag/issue report from a customer
const REPORTS_PATH = path.join(__dirname, "reports.json");
if (!fs.existsSync(REPORTS_PATH)) fs.writeFileSync(REPORTS_PATH, "[]");

app.post("/api/viewer/reports", express.json({ limit: "12mb" }), (req, res) => {
  const { element, module: mod, step, note, photo, projectName, sentAt } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: "note is required" });

  const report = {
    id:          Date.now(),
    projectName: String(projectName || "").trim(),
    module:      String(mod        || "").trim(),
    element:     String(element    || "").trim(),
    step:        step ?? null,
    note:        String(note).trim(),
    photo:       photo || null,   // base64 data-URL or null
    receivedAt:  new Date().toISOString(),
    sentAt:      sentAt || null,
  };

  try {
    const reports = JSON.parse(fs.readFileSync(REPORTS_PATH, "utf8"));
    reports.unshift(report);
    // Keep most recent 500 reports; avoid unbounded growth
    if (reports.length > 500) reports.length = 500;
    fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
    console.log(`[report] ${report.projectName} / ${report.element}: ${report.note.slice(0, 80)}`);
    res.json({ ok: true, id: report.id });
  } catch (err) {
    console.error("Failed to save report:", err);
    res.status(500).json({ error: "Could not save report" });
  }
});

// GET /api/viewer/reports — list all reports (admin only)
app.get("/api/viewer/reports", requireAdmin, (req, res) => {
  try {
    const reports = JSON.parse(fs.readFileSync(REPORTS_PATH, "utf8"));
    // Strip photo payloads from list view to keep response small
    res.json(reports.map(r => ({ ...r, photo: r.photo ? "[photo attached]" : null })));
  } catch {
    res.json([]);
  }
});

// ── Demo project ─────────────────────────────────────────────────────────────
// Admin can mark one project as the "demo" used in the interactive guide.
const DEMO_PATH = path.join(__dirname, "demo.json");
if (!fs.existsSync(DEMO_PATH)) fs.writeFileSync(DEMO_PATH, "null");

// GET /api/viewer/demo — public: returns demo project info (or null)
app.get("/api/viewer/demo", (req, res) => {
  try {
    const code = JSON.parse(fs.readFileSync(DEMO_PATH, "utf8"));
    if (!code) return res.json({ demo: null });
    const project = readProjects().find(p => p.code === code);
    if (!project) return res.json({ demo: null });
    res.json({ demo: { code: project.code, projectName: project.projectName, filename: project.filename } });
  } catch { res.json({ demo: null }); }
});

// POST /api/viewer/demo — admin: set or clear the demo project
app.post("/api/viewer/demo", requireAdmin, express.json(), (req, res) => {
  const { code } = req.body || {};
  if (code && !readProjects().some(p => p.code === code))
    return res.status(404).json({ error: "Project not found" });
  fs.writeFileSync(DEMO_PATH, JSON.stringify(code || null));
  console.log(`[demo] Demo project set to: ${code || "(none)"}`);
  res.json({ ok: true });
});

// ── Recovery: scan uploads and rebuild projects.json ─────────────────────────
// GET /api/viewer/scan-uploads — admin: scan uploads dir and return discovered projects
// POST /api/viewer/scan-uploads — admin: scan AND write recovered projects to projects.json
app.get("/api/viewer/scan-uploads", requireAdmin, (req, res) => {
  try {
    const existing  = readProjects();
    const existCodes = new Set(existing.map(p => p.code));
    const discovered = [];

    if (fs.existsSync(UPLOADS_DIR)) {
      for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "_tmp") continue;
        const code = entry.name.toUpperCase();
        if (existCodes.has(code)) continue; // already in projects.json

        const dir   = path.join(UPLOADS_DIR, entry.name);
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".3dm"));
        if (!files.length) continue;

        const filename = files[0];
        const stat     = fs.statSync(path.join(dir, filename));
        discovered.push({
          code,
          projectName: filename.replace(/\.3dm$/i, ""),
          clientName:  "",
          modelType:   "production",
          filename,
          fileSize:    stat.size,
          createdAt:   stat.birthtime.toISOString()
        });
      }
    }
    res.json({ existing: existing.length, discovered });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/viewer/scan-uploads", requireAdmin, (req, res) => {
  try {
    const existing   = readProjects();
    const existCodes = new Set(existing.map(p => p.code));
    const recovered  = [];

    if (fs.existsSync(UPLOADS_DIR)) {
      for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "_tmp") continue;
        const code = entry.name.toUpperCase();
        if (existCodes.has(code)) continue;

        const dir   = path.join(UPLOADS_DIR, entry.name);
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".3dm"));
        if (!files.length) continue;

        const filename = files[0];
        const stat     = fs.statSync(path.join(dir, filename));
        recovered.push({
          code,
          projectName: filename.replace(/\.3dm$/i, ""),
          clientName:  "",
          modelType:   "production",
          filename,
          fileSize:    stat.size,
          createdAt:   stat.birthtime.toISOString()
        });
      }
    }

    const merged = [...existing, ...recovered];
    writeProjects(merged);
    console.log(`[recover] Recovered ${recovered.length} project(s) from uploads/`);
    res.json({ ok: true, recovered: recovered.length, total: merged.length, projects: recovered });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Convenience routes
app.get("/",      (req, res) => res.redirect("/viewer.html"));
app.get("/admin", (req, res) => res.redirect("/viewer-admin.html"));

app.listen(PORT, () => {
  console.log(`Woodstock Assembly Viewer running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
