const app = document.getElementById('app');
const state = { me: null, refreshTimer: null };

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function fmtTime(v) { return v ? new Date(String(v).replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium', hour12: true }) : '—'; }
function fmtDate(v) { return v ? new Date(`${v}T00:00:00Z`).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' }) : '—'; }

function layout(title, content) {
  app.innerHTML = `
    <header class="topbar">
      <div><strong>Employee Attendance</strong><span class="muted">Private company system</span></div>
      <div class="top-actions"><span>${esc(state.me?.name || '')}</span><button class="ghost" onclick="logout()">Logout</button></div>
    </header>
    <main class="container"><div class="page-title"><h1>${esc(title)}</h1></div>${content}</main>`;
}

function loginView(message='') {
  app.innerHTML = `
    <main class="auth-wrap">
      <div class="auth-card">
        <div class="brand">EMPLOYEE ATTENDANCE</div>
        <h1>Sign in</h1>
        <p class="muted">Use the email and password created by the administrator.</p>
        ${message ? `<div class="alert error">${esc(message)}</div>` : ''}
        <form onsubmit="login(event)">
          <label>Email<input id="email" type="email" required autocomplete="username" /></label>
          <label>Password<input id="password" type="password" required autocomplete="current-password" /></label>
          <button class="primary full" type="submit">Login</button>
        </form>
      </div>
    </main>`;
}

async function login(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  try {
    state.me = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ email, password }) });
    render();
  } catch (err) { loginView(err.message); }
}

async function logout() {
  try { await api('/api/auth/logout', { method:'POST' }); } catch {}
  state.me = null;
  clearInterval(state.refreshTimer);
  loginView();
}

async function render() {
  if (!state.me) return loginView();
  if (state.me.role === 'ADMIN') return adminDashboard();
  return employeeDashboard();
}

async function employeeDashboard() {
  try {
    const data = await api('/api/employee/today');
    const s = data.session;
    const activeBreak = data.breaks.find(b => !b.break_end_at);
    const status = !s ? 'LOGGED OUT' : activeBreak ? 'ON BREAK' : 'WORKING';
    layout('My Attendance', `
      <section class="welcome"><div><h2>Hi, ${esc(state.me.name)}</h2><p class="muted">All attendance timestamps are recorded by the server/database.</p></div><span class="status ${statusClass(status)}">${status}</span></section>
      <section class="cards">
        <div class="card"><span>Check in</span><strong>${fmtTime(s?.check_in_at)}</strong></div>
        <div class="card"><span>Today's breaks</span><strong>${data.breaks.length}</strong></div>
        <div class="card"><span>Last action</span><strong>${activeBreak ? 'Break started' : s ? (s.check_out_at ? 'Checked out' : 'Working') : 'Not checked in'}</strong></div>
      </section>
      <section class="panel action-panel">
        ${!s ? `<button class="primary big" onclick="employeeAction('/api/employee/check-in')">CHECK IN</button>` : activeBreak ? `<button class="primary big" onclick="employeeAction('/api/employee/break/end')">RESUME WORK</button>` : `<button class="warning big" onclick="employeeAction('/api/employee/break/start')">START BREAK</button><button class="danger big" onclick="employeeAction('/api/employee/check-out')">CHECK OUT</button>`}
      </section>
      <section class="panel"><h2>Break history</h2>${data.breaks.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>${data.breaks.map((b,i)=>`<tr><td>${i+1}</td><td>${fmtTime(b.break_start_at)}</td><td>${fmtTime(b.break_end_at)}</td><td>${esc(b.duration)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No breaks recorded.</p>'}</section>`);
    refreshLater(employeeDashboard, 10000);
  } catch (err) {
    layout('My Attendance', `<div class="alert error">${esc(err.message)}</div>`);
  }
}

function statusClass(status) { return status === 'WORKING' ? 'green' : status === 'ON BREAK' ? 'yellow' : 'red'; }
function refreshLater(fn, ms) { clearInterval(state.refreshTimer); state.refreshTimer = setTimeout(fn, ms); }
async function employeeAction(url) {
  try { await api(url, { method:'POST', body: JSON.stringify({}) }); await employeeDashboard(); }
  catch (err) { alert(err.message); }
}

async function adminDashboard() {
  try {
    const [stats, live] = await Promise.all([api('/api/admin/stats'), api('/api/admin/live')]);
    layout('Admin Dashboard', `
      <section class="cards four"><div class="card"><span>Employees</span><strong>${stats.employees}</strong></div><div class="card"><span>Working</span><strong>${stats.working}</strong></div><div class="card"><span>On break</span><strong>${stats.on_break}</strong></div><div class="card"><span>Logged out</span><strong>${stats.logged_out}</strong></div></section>
      <section class="panel"><div class="toolbar"><h2>Live attendance</h2><div><button class="ghost" onclick="employeesPage()">Employees</button> <button class="ghost" onclick="attendancePage()">Attendance & Reports</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Check in</th></tr></thead><tbody>${live.map(r=>`<tr><td><strong>${esc(r.name)}</strong><br><span class="muted">${esc(r.employee_code)}</span></td><td>${esc(r.designation || '—')}</td><td><span class="status ${statusClass(r.status)}">${esc(r.status)}</span></td><td>${fmtTime(r.check_in_at)}</td></tr>`).join('')}</tbody></table></div></section>`);
    refreshLater(adminDashboard, 10000);
  } catch (err) { layout('Admin Dashboard', `<div class="alert error">${esc(err.message)}</div>`); }
}

async function employeesPage() {
  clearInterval(state.refreshTimer);
  try {
    const rows = await api('/api/admin/employees');
    layout('Employees', `<section class="panel"><div class="toolbar"><h2>Employee accounts</h2><button class="primary" onclick="showEmployeeForm()">+ Add employee</button></div>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Login email</th><th>Designation</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.employee_code)}</td><td><strong>${esc(r.name)}</strong><br><span class="muted">${esc(r.department || '')}</span></td><td>${esc(r.email)}</td><td>${esc(r.designation || '—')}</td><td><span class="status ${r.is_active?'green':'red'}">${r.is_active?'ACTIVE':'INACTIVE'}</span></td><td><button class="ghost" onclick='editEmployee(${JSON.stringify(r)})'>Edit</button></td></tr>`).join('')}</tbody></table></div></section>`);
  } catch (err) { layout('Employees', `<div class="alert error">${esc(err.message)}</div>`); }
}

function showEmployeeForm(employee=null) {
  layout(employee ? 'Edit Employee' : 'Create Employee', `<section class="panel form-panel"><form onsubmit="saveEmployee(event, ${employee?employee.id:'null'})"><div class="form-grid">
    <label>Employee code<input id="f_code" required value="${esc(employee?.employee_code || '')}" /></label>
    <label>Name<input id="f_name" required value="${esc(employee?.name || '')}" /></label>
    <label>Email<input id="f_email" type="email" required value="${esc(employee?.email || '')}" /></label>
    <label>New password ${employee?'(leave blank to keep current)':''}<input id="f_password" type="password" ${employee?'':'required minlength="8"'} /></label>
    <label>Designation<input id="f_designation" value="${esc(employee?.designation || '')}" /></label>
    <label>Department<input id="f_department" value="${esc(employee?.department || '')}" /></label>
    <label>Phone<input id="f_phone" value="${esc(employee?.phone || '')}" /></label>
    ${employee?`<label>Status<select id="f_active"><option value="1" ${employee.is_active?'selected':''}>Active</option><option value="0" ${!employee.is_active?'selected':''}>Inactive</option></select></label>`:''}
  </div><div class="actions"><button class="primary" type="submit">${employee?'Save changes':'Create employee'}</button><button class="ghost" type="button" onclick="employeesPage()">Cancel</button></div></form></section>`);
}

async function saveEmployee(e, id) {
  e.preventDefault();
  const body = { employee_code:f_code.value, name:f_name.value, email:f_email.value, password:f_password.value, designation:f_designation.value, department:f_department.value, phone:f_phone.value };
  if (id) body.is_active = f_active.value === '1'; else if (!body.password || body.password.length < 8) return alert('Password must be at least 8 characters.');
  if (!body.password) delete body.password;
  try { await api(id ? `/api/admin/employees/${id}` : '/api/admin/employees', { method:id?'PUT':'POST', body:JSON.stringify(body) }); alert(id?'Employee updated.':'Employee created.'); employeesPage(); }
  catch(err) { alert(err.message); }
}
function editEmployee(row) { showEmployeeForm(row); }

async function attendancePage() {
  clearInterval(state.refreshTimer);
  const today = new Date().toISOString().slice(0,10);
  layout('Attendance & Reports', `<section class="panel"><div class="filters"><label>From<input id="from" type="date" value="${today}" /></label><label>To<input id="to" type="date" value="${today}" /></label><button class="primary" onclick="loadAttendance()">Load</button><button class="ghost" onclick="downloadCsv()">Export CSV</button></div><div id="attendanceTable"></div></section>`);
  await loadAttendance();
}

async function loadAttendance() {
  try {
    const q = new URLSearchParams({ from:from.value, to:to.value });
    const rows = await api('/api/admin/attendance?' + q.toString());
    attendanceTable.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Check in</th><th>Break</th><th>Check out</th><th>Working</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${fmtDate(r.work_date)}</td><td><strong>${esc(r.name)}</strong><br><span class="muted">${esc(r.employee_code)}</span></td><td>${fmtTime(r.check_in_at)}</td><td>${esc(r.break_duration)}</td><td>${fmtTime(r.check_out_at)}</td><td><strong>${esc(r.working_duration)}</strong></td></tr>`).join('')}</tbody></table></div>`;
  } catch (err) { attendanceTable.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
}
function downloadCsv() { window.location.href = '/api/admin/export.csv?' + new URLSearchParams({ from:from.value, to:to.value }).toString(); }

(async function boot(){
  try { state.me = await api('/api/auth/me'); render(); } catch { loginView(); }
})();
