require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const { Groq }     = require('groq-sdk');
const axios        = require('axios');
const PDFDocument  = require('pdfkit');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Database     = require('better-sqlite3');
const { createSpeechmaticsJWT } = require('@speechmatics/auth');

/* ─── App Setup ───────────────────────────────────────────────── */
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ─── SQLite Database ─────────────────────────────────────────── */
const DB_PATH = path.join(__dirname, 'banglameet.db');
const db = new Database(DB_PATH);

// WAL mode for better concurrent read perf
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    avatar     TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT 'Untitled Meeting',
    status      TEXT NOT NULL DEFAULT 'active',
    language    TEXT NOT NULL DEFAULT 'bn',
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    duration_s  INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    speaker    TEXT NOT NULL,
    text       TEXT NOT NULL,
    timestamp  INTEGER NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT UNIQUE NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
    FOREIGN KEY (user_id)    REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    tag        TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    text, speaker, meeting_id UNINDEXED,
    content='segments', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, text, speaker, meeting_id)
      VALUES (new.id, new.text, new.speaker, new.meeting_id);
  END;
`);

console.log('✅ SQLite database ready:', DB_PATH);

/* ─── Groq Client ─────────────────────────────────────────────── */
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─── JWT Helpers ─────────────────────────────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ═══════════════════════════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════════════════════════ */

/** POST /api/auth/register */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing)
      return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const id     = uuidv4();
    const avatar = `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=5b7fff`;

    db.prepare('INSERT INTO users (id, name, email, password, avatar) VALUES (?,?,?,?,?)')
      .run(id, name, email, hashed, avatar);

    const token = signToken({ id, name, email, avatar });
    res.status(201).json({ token, user: { id, name, email, avatar } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/** POST /api/auth/login */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user)
      return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: user.id, name: user.name, email: user.email, avatar: user.avatar });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** GET /api/auth/me */
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, name, email, avatar, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

/* ═══════════════════════════════════════════════════════════════
   MEETING ROUTES
═══════════════════════════════════════════════════════════════ */

/** POST /api/meetings — create a new meeting */
app.post('/api/meetings', authMiddleware, (req, res) => {
  try {
    const { title, language } = req.body;
    const id = uuidv4();
    db.prepare(`
      INSERT INTO meetings (id, user_id, title, language, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.user.id, title || 'Untitled Meeting', language || 'bn', Date.now());
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
    res.status(201).json({ meeting });
  } catch (err) {
    console.error('Create meeting error:', err);
    res.status(500).json({ error: 'Failed to create meeting' });
  }
});

/** GET /api/meetings — list meetings for current user */
app.get('/api/meetings', authMiddleware, (req, res) => {
  try {
    const { q, tag, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT m.*,
        (SELECT COUNT(*) FROM segments WHERE meeting_id = m.id) AS segment_count,
        (SELECT COUNT(DISTINCT speaker) FROM segments WHERE meeting_id = m.id) AS speaker_count,
        (SELECT content FROM summaries WHERE meeting_id = m.id) AS summary_preview,
        (SELECT GROUP_CONCAT(tag, ',') FROM tags WHERE meeting_id = m.id) AS tags
      FROM meetings m
      WHERE m.user_id = ?
    `;
    const params = [req.user.id];

    if (q) {
      query += ` AND m.title LIKE ?`;
      params.push(`%${q}%`);
    }
    if (tag) {
      query += ` AND m.id IN (SELECT meeting_id FROM tags WHERE tag = ?)`;
      params.push(tag);
    }

    query += ` ORDER BY m.started_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const meetings = db.prepare(query).all(...params);
    const total    = db.prepare(`SELECT COUNT(*) as c FROM meetings WHERE user_id = ?`).get(req.user.id).c;
    res.json({ meetings, total });
  } catch (err) {
    console.error('List meetings error:', err);
    res.status(500).json({ error: 'Failed to list meetings' });
  }
});

/** GET /api/meetings/:id — full meeting detail */
app.get('/api/meetings/:id', authMiddleware, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const segments = db.prepare('SELECT * FROM segments WHERE meeting_id = ? ORDER BY timestamp ASC')
      .all(req.params.id);
    const summary  = db.prepare('SELECT * FROM summaries WHERE meeting_id = ?').get(req.params.id);
    const notes    = db.prepare('SELECT * FROM notes WHERE meeting_id = ? AND user_id = ? ORDER BY created_at DESC')
      .all(req.params.id, req.user.id);
    const tags     = db.prepare('SELECT tag FROM tags WHERE meeting_id = ?').all(req.params.id).map(t => t.tag);

    res.json({ meeting, segments, summary: summary?.content || null, notes, tags });
  } catch (err) {
    console.error('Get meeting error:', err);
    res.status(500).json({ error: 'Failed to get meeting' });
  }
});

/** PATCH /api/meetings/:id — update title / status / tags */
app.patch('/api/meetings/:id', authMiddleware, (req, res) => {
  try {
    const { title, status, ended_at, duration_s, tags } = req.body;
    const meeting = db.prepare('SELECT id FROM meetings WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    if (title)     db.prepare('UPDATE meetings SET title = ?     WHERE id = ?').run(title, req.params.id);
    if (status)    db.prepare('UPDATE meetings SET status = ?    WHERE id = ?').run(status, req.params.id);
    if (ended_at)  db.prepare('UPDATE meetings SET ended_at = ?  WHERE id = ?').run(ended_at, req.params.id);
    if (duration_s !== undefined) db.prepare('UPDATE meetings SET duration_s = ? WHERE id = ?').run(duration_s, req.params.id);

    if (Array.isArray(tags)) {
      db.prepare('DELETE FROM tags WHERE meeting_id = ?').run(req.params.id);
      const insertTag = db.prepare('INSERT INTO tags (meeting_id, tag) VALUES (?,?)');
      tags.forEach(tag => insertTag.run(req.params.id, tag));
    }

    res.json({ meeting: db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) });
  } catch (err) {
    console.error('Patch meeting error:', err);
    res.status(500).json({ error: 'Failed to update meeting' });
  }
});

/** DELETE /api/meetings/:id */
app.delete('/api/meetings/:id', authMiddleware, (req, res) => {
  try {
    const meeting = db.prepare('SELECT id FROM meetings WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!meeting) return res.status(404).json({ error: 'Not found' });

    db.prepare('DELETE FROM segments  WHERE meeting_id = ?').run(req.params.id);
    db.prepare('DELETE FROM summaries WHERE meeting_id = ?').run(req.params.id);
    db.prepare('DELETE FROM notes     WHERE meeting_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tags      WHERE meeting_id = ?').run(req.params.id);
    db.prepare('DELETE FROM meetings  WHERE id = ?').run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete meeting' });
  }
});

/* ─── Segments ────────────────────────────────────────────────── */

/** POST /api/meetings/:id/segments — save transcript segments */
app.post('/api/meetings/:id/segments', authMiddleware, (req, res) => {
  try {
    const { segments } = req.body;
    if (!Array.isArray(segments)) return res.status(400).json({ error: 'segments array required' });

    const insert = db.prepare('INSERT INTO segments (meeting_id, speaker, text, timestamp) VALUES (?,?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const s of rows) insert.run(req.params.id, s.speaker, s.text, s.timestamp || Date.now());
    });
    insertMany(segments);

    res.json({ ok: true, inserted: segments.length });
  } catch (err) {
    console.error('Save segments error:', err);
    res.status(500).json({ error: 'Failed to save segments' });
  }
});

/* ─── Notes ───────────────────────────────────────────────────── */

/** POST /api/meetings/:id/notes */
app.post('/api/meetings/:id/notes', authMiddleware, (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const result = db.prepare(
      'INSERT INTO notes (meeting_id, user_id, content) VALUES (?,?,?)'
    ).run(req.params.id, req.user.id, content);
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ note });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save note' });
  }
});

/** PATCH /api/notes/:id */
app.patch('/api/notes/:id', authMiddleware, (req, res) => {
  try {
    const { content } = req.body;
    db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(content, Date.now(), req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update note' });
  }
});

/** DELETE /api/notes/:id */
app.delete('/api/notes/:id', authMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

/* ─── Search ──────────────────────────────────────────────────── */

/** GET /api/search?q=... */
app.get('/api/search', authMiddleware, (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ results: [] });

    // Full-text search in segments_fts filtered by user's meetings
    const rows = db.prepare(`
      SELECT s.meeting_id, s.speaker, s.text, s.timestamp,
             m.title, m.started_at
      FROM segments_fts fts
      JOIN segments s ON s.id = fts.rowid
      JOIN meetings m ON m.id = s.meeting_id
      WHERE segments_fts MATCH ?
        AND m.user_id = ?
      ORDER BY rank
      LIMIT 30
    `).all(q + '*', req.user.id);

    res.json({ results: rows });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/* ─── Dashboard Stats ─────────────────────────────────────────── */

/** GET /api/stats */
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const uid = req.user.id;

    const totalMeetings   = db.prepare('SELECT COUNT(*) c FROM meetings WHERE user_id = ?').get(uid).c;
    const totalSegments   = db.prepare(`
      SELECT COUNT(*) c FROM segments s
      JOIN meetings m ON m.id = s.meeting_id
      WHERE m.user_id = ?`).get(uid).c;
    const totalDuration   = db.prepare('SELECT SUM(duration_s) s FROM meetings WHERE user_id = ?').get(uid).s || 0;
    const totalSummaries  = db.prepare(`
      SELECT COUNT(*) c FROM summaries su
      JOIN meetings m ON m.id = su.meeting_id
      WHERE m.user_id = ?`).get(uid).c;

    // Last 7 days activity
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recentActivity = db.prepare(`
      SELECT DATE(started_at/1000, 'unixepoch') as day, COUNT(*) as count
      FROM meetings
      WHERE user_id = ? AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `).all(uid, sevenDaysAgo);

    res.json({ totalMeetings, totalSegments, totalDuration, totalSummaries, recentActivity });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   AI ROUTES  (keep original + save summary)
═══════════════════════════════════════════════════════════════ */

/** POST /api/summarize */
app.post('/api/summarize', authMiddleware, async (req, res) => {
  try {
    const { transcript, meeting_id } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Transcript is required' });

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are a professional AI meeting assistant specialized in Bangla-language meetings.
Analyze the transcript and provide:
1. **Meeting Overview** — 2-3 sentence summary
2. **Key Discussion Points** — bullet points of main topics
3. **Decisions Made** — list any decisions reached
4. **Action Items** — who needs to do what
5. **Next Steps** — follow-up items

Use a clear, professional tone. Write primarily in Bangla when the transcript is in Bangla.`,
        },
        { role: 'user', content: transcript },
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const summary = completion.choices[0].message.content;

    // Persist summary if we have a meeting_id
    if (meeting_id) {
      db.prepare(`
        INSERT INTO summaries (meeting_id, content)
        VALUES (?, ?)
        ON CONFLICT(meeting_id) DO UPDATE SET content = excluded.content, created_at = strftime('%s','now')
      `).run(meeting_id, summary);
    }

    res.json({ summary });
  } catch (err) {
    console.error('Groq Error:', err);
    res.status(500).json({ error: 'Failed to summarize' });
  }
});

/** GET /api/speechmatics-token */
app.get('/api/speechmatics-token', authMiddleware, async (req, res) => {
  try {
    const jwt_token = await createSpeechmaticsJWT({
      type: 'rt',
      apiKey: process.env.SPEECHMATICS_API_KEY,
      ttl: 7200, // 2 hours — enough margin for a 60-minute meeting
    });
    res.json({ token: jwt_token });
  } catch (err) {
    console.error('Token Error:', err.message);
    res.status(500).json({ error: 'Failed to get token' });
  }
});

/** POST /api/export-pdf */
app.post('/api/export-pdf', authMiddleware, async (req, res) => {
  try {
    const { summary, title, meeting_id } = req.body;
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=meeting-summary-${Date.now()}.pdf`);
    doc.pipe(res);

    const fontPath = path.join(__dirname, 'fonts', 'HindSiliguri-Regular.ttf');
    if (fs.existsSync(fontPath)) doc.font(fontPath);

    // Header
    doc.rect(0, 0, doc.page.width, 80).fill('#080b12');
    doc.fillColor('#ffffff').fontSize(22).text(title || 'Meeting Summary', 50, 28, { align: 'left' });
    doc.fillColor('#8892aa').fontSize(10)
      .text(`Generated by BanglaMeet AI · ${new Date().toLocaleString()}`, 50, 55);

    doc.moveDown(4);
    doc.fillColor('#111111').fontSize(13).text(summary, { lineGap: 6, align: 'left' });
    doc.end();
  } catch (err) {
    console.error('PDF Error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

/* ─── Start ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 BanglaMeet server running on port ${PORT}`);
});
