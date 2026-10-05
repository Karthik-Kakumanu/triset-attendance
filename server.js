const path = require('path');
const fs = require('fs');
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const morgan = require('morgan');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const COOKIE_NAME = process.env.COOKIE_NAME || 'attendance_session';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  dateStrings: true
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(morgan('tiny'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function issueSession(res, user) {
  const token = jwt.sign(
    { sub: String(user.id), role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    next();
  };
}

function cleanEmployee(row) {
  return {
    id: row.id,
    employee_code: row.employee_code,
    name: row.name,
    email: row.email,
    designation: row.designation,
    department: row.department,
    phone: row.phone,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toSeconds(dateString) {
  if (!dateString) return null;
  const d = new Date(dateString.replace(' ', 'T') + 'Z');
  return Math.floor(d.getTime() / 1000);
}

function diffSeconds(start, end) {
  const a = toSeconds(start);
  const b = toSeconds(end);
  return a != null && b != null ? Math.max(0, b - a) : null;
}

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

async function initDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
  const statements = schema.split(';').map(s => s.trim()).filter(Boolean);
  const conn = await pool.getConnection();
  try {
    await conn.query(`SET time_zone = '+05:30'`);
    for (const statement of statements) await conn.query(statement);
    const [rows] = await conn.query('SELECT COUNT(*) AS count FROM admins');
    if (Number(rows[0].count) === 0) {
      const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      const password = String(process.env.ADMIN_PASSWORD || '');
      const name = String(process.env.ADMIN_NAME || 'Company Administrator').trim();
      if (!email || !password) {
        throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD before first startup.');
      }
      const hash = await bcrypt.hash(password, 12);
      await conn.execute(
        'INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, hash]
      );
    }
  } finally {
    conn.release();
  }
}

async function withIST(conn) {
  await conn.query(`SET time_zone = '+05:30'`);
}

app.get('/health', asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
  res.json({ ok: true, timezone: APP_TIMEZONE });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const [admins] = await conn.execute('SELECT * FROM admins WHERE email = ? LIMIT 1', [email]);
    if (admins.length) {
      const admin = admins[0];
      if (!admin.is_active || !(await bcrypt.compare(password, admin.password_hash))) {
        return res.status(401).json({ error: 'Invalid login.' });
      }
      issueSession(res, { id: admin.id, role: 'ADMIN', name: admin.name, email: admin.email });
      await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['ADMIN', admin.id, 'LOGIN', JSON.stringify({ ip: req.ip })]);
      return res.json({ role: 'ADMIN', name: admin.name, email: admin.email });
    }

    const [employees] = await conn.execute('SELECT * FROM employees WHERE email = ? LIMIT 1', [email]);
    if (!employees.length) return res.status(401).json({ error: 'Invalid login.' });
    const emp = employees[0];
    if (!emp.is_active || !(await bcrypt.compare(password, emp.password_hash))) {
      return res.status(401).json({ error: 'Invalid login.' });
    }
    issueSession(res, { id: emp.id, role: 'EMPLOYEE', name: emp.name, email: emp.email });
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['EMPLOYEE', emp.id, 'LOGIN', JSON.stringify({ ip: req.ip })]);
    return res.json({ role: 'EMPLOYEE', name: emp.name, email: emp.email });
  } finally {
    conn.release();
  }
}));

app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  res.json(req.user);
}));

app.get('/api/employee/today', requireAuth, requireRole('EMPLOYEE'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const [sessions] = await conn.execute(
      `SELECT * FROM attendance_sessions WHERE employee_id = ? AND check_out_at IS NULL ORDER BY id DESC LIMIT 1`,
      [req.user.sub]
    );
    if (!sessions.length) return res.json({ session: null, breaks: [] });
    const session = sessions[0];
    const [breakRows] = await conn.execute('SELECT * FROM breaks WHERE attendance_id = ? ORDER BY id ASC', [session.id]);
    const breaks = breakRows.map(b => ({
      ...b,
      duration_seconds: b.break_end_at ? diffSeconds(b.break_start_at, b.break_end_at) : null,
      duration: b.break_end_at ? formatDuration(diffSeconds(b.break_start_at, b.break_end_at)) : 'Ongoing'
    }));
    res.json({ session, breaks });
  } finally {
    conn.release();
  }
}));

app.post('/api/employee/check-in', requireAuth, requireRole('EMPLOYEE'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    await conn.beginTransaction();
    const [open] = await conn.execute('SELECT id FROM attendance_sessions WHERE employee_id = ? AND check_out_at IS NULL LIMIT 1 FOR UPDATE', [req.user.sub]);
    if (open.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'You already have an active work session.' });
    }
    await conn.execute(
      `INSERT INTO attendance_sessions (employee_id, work_date, check_in_at) VALUES (?, DATE(NOW()), NOW())`,
      [req.user.sub]
    );
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action) VALUES (?,?,?)', ['EMPLOYEE', req.user.sub, 'CHECK_IN']);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback(); throw e;
  } finally { conn.release(); }
}));

async function getOpenSessionForEmployee(conn, employeeId) {
  const [rows] = await conn.execute('SELECT * FROM attendance_sessions WHERE employee_id = ? AND check_out_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [employeeId]);
  return rows[0] || null;
}

app.post('/api/employee/break/start', requireAuth, requireRole('EMPLOYEE'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn); await conn.beginTransaction();
    const session = await getOpenSessionForEmployee(conn, req.user.sub);
    if (!session) { await conn.rollback(); return res.status(409).json({ error: 'Check in before starting a break.' }); }
    const [active] = await conn.execute('SELECT id FROM breaks WHERE attendance_id = ? AND break_end_at IS NULL LIMIT 1 FOR UPDATE', [session.id]);
    if (active.length) { await conn.rollback(); return res.status(409).json({ error: 'You are already on a break.' }); }
    await conn.execute('INSERT INTO breaks (attendance_id, break_start_at) VALUES (?, NOW())', [session.id]);
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['EMPLOYEE', req.user.sub, 'BREAK_START', JSON.stringify({ attendance_id: session.id })]);
    await conn.commit(); res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.post('/api/employee/break/end', requireAuth, requireRole('EMPLOYEE'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn); await conn.beginTransaction();
    const session = await getOpenSessionForEmployee(conn, req.user.sub);
    if (!session) { await conn.rollback(); return res.status(409).json({ error: 'No active work session.' }); }
    const [active] = await conn.execute('SELECT id FROM breaks WHERE attendance_id = ? AND break_end_at IS NULL LIMIT 1 FOR UPDATE', [session.id]);
    if (!active.length) { await conn.rollback(); return res.status(409).json({ error: 'You are not currently on a break.' }); }
    await conn.execute('UPDATE breaks SET break_end_at = NOW() WHERE id = ?', [active[0].id]);
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['EMPLOYEE', req.user.sub, 'BREAK_END', JSON.stringify({ attendance_id: session.id, break_id: active[0].id })]);
    await conn.commit(); res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.post('/api/employee/check-out', requireAuth, requireRole('EMPLOYEE'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn); await conn.beginTransaction();
    const session = await getOpenSessionForEmployee(conn, req.user.sub);
    if (!session) { await conn.rollback(); return res.status(409).json({ error: 'No active work session.' }); }
    const [active] = await conn.execute('SELECT id FROM breaks WHERE attendance_id = ? AND break_end_at IS NULL LIMIT 1 FOR UPDATE', [session.id]);
    if (active.length) { await conn.rollback(); return res.status(409).json({ error: 'End your active break before checking out.' }); }
    await conn.execute('UPDATE attendance_sessions SET check_out_at = NOW() WHERE id = ?', [session.id]);
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['EMPLOYEE', req.user.sub, 'CHECK_OUT', JSON.stringify({ attendance_id: session.id })]);
    await conn.commit(); res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.get('/api/admin/stats', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const [[employees]] = await conn.query('SELECT COUNT(*) AS count FROM employees WHERE is_active = 1');
    const [[working]] = await conn.query('SELECT COUNT(*) AS count FROM attendance_sessions WHERE check_out_at IS NULL');
    const [[onBreak]] = await conn.query(`SELECT COUNT(*) AS count FROM breaks b JOIN attendance_sessions a ON a.id=b.attendance_id WHERE a.check_out_at IS NULL AND b.break_end_at IS NULL`);
    const [[loggedOut]] = await conn.query(`SELECT COUNT(*) AS count FROM employees e WHERE e.is_active = 1 AND NOT EXISTS (SELECT 1 FROM attendance_sessions a WHERE a.employee_id=e.id AND a.check_out_at IS NULL)`);
    res.json({ employees: Number(employees.count), working: Number(working.count), on_break: Number(onBreak.count), logged_out: Number(loggedOut.count) });
  } finally { conn.release(); }
}));

app.get('/api/admin/employees', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT id, employee_code, name, email, designation, department, phone, is_active, created_at, updated_at FROM employees ORDER BY name ASC');
    res.json(rows.map(cleanEmployee));
  } finally { conn.release(); }
}));

app.post('/api/admin/employees', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const employeeCode = String(body.employee_code || '').trim();
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const designation = String(body.designation || '').trim() || null;
  const department = String(body.department || '').trim() || null;
  const phone = String(body.phone || '').trim() || null;
  if (!employeeCode || !name || !email || password.length < 8) return res.status(400).json({ error: 'Employee code, name, email and a password of at least 8 characters are required.' });
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const hash = await bcrypt.hash(password, 12);
    const [result] = await conn.execute(
      'INSERT INTO employees (employee_code, name, email, password_hash, designation, department, phone) VALUES (?,?,?,?,?,?,?)',
      [employeeCode, name, email, hash, designation, department, phone]
    );
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['ADMIN', req.user.sub, 'EMPLOYEE_CREATE', JSON.stringify({ employee_id: result.insertId, employee_code: employeeCode })]);
    res.status(201).json({ ok: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Employee code or email already exists.' });
    throw e;
  } finally { conn.release(); }
}));

app.put('/api/admin/employees/:id', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id.' });
  const body = req.body || {};
  const fields = [];
  const values = [];
  const add = (field, value) => { fields.push(`${field} = ?`); values.push(value); };
  if (body.employee_code !== undefined) add('employee_code', String(body.employee_code).trim());
  if (body.name !== undefined) add('name', String(body.name).trim());
  if (body.email !== undefined) add('email', String(body.email).trim().toLowerCase());
  if (body.designation !== undefined) add('designation', String(body.designation).trim() || null);
  if (body.department !== undefined) add('department', String(body.department).trim() || null);
  if (body.phone !== undefined) add('phone', String(body.phone).trim() || null);
  if (body.is_active !== undefined) add('is_active', body.is_active ? 1 : 0);
  if (body.password) {
    if (String(body.password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    add('password_hash', await bcrypt.hash(String(body.password), 12));
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  const conn = await pool.getConnection();
  try {
    await conn.execute(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
    await conn.execute('INSERT INTO audit_logs (actor_type, actor_id, action, details) VALUES (?,?,?,?)', ['ADMIN', req.user.sub, 'EMPLOYEE_UPDATE', JSON.stringify({ employee_id: id })]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Employee code or email already exists.' });
    throw e;
  } finally { conn.release(); }
}));

app.get('/api/admin/attendance', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const params = [];
    let where = '1=1';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where += ' AND a.work_date >= ?'; params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where += ' AND a.work_date <= ?'; params.push(to); }
    const [rows] = await conn.execute(
      `SELECT a.id, a.work_date, a.check_in_at, a.check_out_at, e.employee_code, e.name, e.email,
        COALESCE((SELECT SUM(TIMESTAMPDIFF(SECOND,b.break_start_at,b.break_end_at)) FROM breaks b WHERE b.attendance_id=a.id AND b.break_end_at IS NOT NULL),0) AS break_seconds
       FROM attendance_sessions a JOIN employees e ON e.id=a.employee_id
       WHERE ${where} ORDER BY a.work_date DESC, a.check_in_at DESC`, params
    );
    const out = rows.map(r => {
      const total = r.check_out_at ? diffSeconds(r.check_in_at, r.check_out_at) : null;
      const breakSec = Number(r.break_seconds || 0);
      const working = total == null ? null : Math.max(0, total - breakSec);
      return { ...r, total_seconds: total, break_seconds: breakSec, working_seconds: working, break_duration: formatDuration(breakSec), working_duration: formatDuration(working), total_duration: formatDuration(total) };
    });
    res.json(out);
  } finally { conn.release(); }
}));

app.get('/api/admin/live', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const [rows] = await conn.query(
      `SELECT e.id, e.employee_code, e.name, e.email, e.designation, a.id AS attendance_id, a.check_in_at,
        CASE WHEN EXISTS (SELECT 1 FROM breaks b WHERE b.attendance_id=a.id AND b.break_end_at IS NULL) THEN 'ON BREAK' ELSE 'WORKING' END AS status
       FROM employees e LEFT JOIN attendance_sessions a ON a.employee_id=e.id AND a.check_out_at IS NULL
       WHERE e.is_active=1 ORDER BY e.name ASC`
    );
    res.json(rows.map(r => ({
      ...r,
      status: r.attendance_id ? r.status : 'LOGGED OUT'
    })));
  } finally { conn.release(); }
}));

app.get('/api/admin/export.csv', requireAuth, requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const conn = await pool.getConnection();
  try {
    await withIST(conn);
    const params = [];
    let where = '1=1';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where += ' AND a.work_date >= ?'; params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where += ' AND a.work_date <= ?'; params.push(to); }
    const [rows] = await conn.execute(
      `SELECT a.work_date, e.employee_code, e.name, e.email, a.check_in_at, a.check_out_at,
        COALESCE((SELECT SUM(TIMESTAMPDIFF(SECOND,b.break_start_at,b.break_end_at)) FROM breaks b WHERE b.attendance_id=a.id AND b.break_end_at IS NOT NULL),0) AS break_seconds
       FROM attendance_sessions a JOIN employees e ON e.id=a.employee_id
       WHERE ${where} ORDER BY a.work_date DESC, e.name ASC`, params
    );
    const csvEscape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Date,Employee ID,Employee Name,Email,Check In,Check Out,Break Seconds,Working Seconds'];
    for (const r of rows) {
      const total = r.check_out_at ? diffSeconds(r.check_in_at, r.check_out_at) : null;
      const breakSec = Number(r.break_seconds || 0);
      const working = total == null ? '' : Math.max(0, total - breakSec);
      lines.push([
        r.work_date, r.employee_code, r.name, r.email, r.check_in_at || '', r.check_out_at || '', breakSec, working
      ].map(csvEscape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
    res.send(lines.join('\n'));
  } finally { conn.release(); }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Check the Render logs for details.' });
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Attendance app listening on ${PORT}`));
  })
  .catch(err => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });
