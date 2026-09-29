/* Fuel Station Manager — frontend logic (v3.0: pump/owner/manager auth, staff, attendance, daily ops) */
(function () {
"use strict";

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------
const FUEL_COLORS = { diesel: "#1a7a4a", petrol: "#22a05a", cng: "#f5a623" };
const STATUS_BADGE = { pending: "badge-red", partial: "badge-partial", paid: "badge-green" };
const RESULT_BADGE = { pass: "badge-green", fail: "badge-fail", hold: "badge-hold" };

let CURRENT_USER = null;
let CUSTOMERS_CACHE = [];
let CSRF_TOKEN = "";
let TANKS_CACHE = {};

// Regional formatting — deployment-configurable from Settings → Business Info
// (currency symbol + a BCP-47 locale tag), so the same app works for any
// market instead of being hardcoded to one currency/number format. Falls
// back to the browser's own language until settings are loaded post-login.
let CURRENCY_SYMBOL = "$";
let APP_LOCALE = (navigator.language || "en-US");

function applyRegionalSettings(s) {
  s = s || {};
  CURRENCY_SYMBOL = s.currency_symbol || "$";
  APP_LOCALE = s.locale || APP_LOCALE || "en-US";
  document.querySelectorAll(".cur-sym").forEach(el => { el.textContent = CURRENCY_SYMBOL; });
}

function fmtMoney(n) {
  n = Number(n) || 0;
  let num;
  try { num = n.toLocaleString(APP_LOCALE, { maximumFractionDigits: 0 }); }
  catch (e) { num = n.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  return CURRENCY_SYMBOL + num;
}
function fmtNum(n) {
  n = Number(n) || 0;
  try { return n.toLocaleString(APP_LOCALE, { maximumFractionDigits: 2 }); }
  catch (e) { return n.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
}
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return d;
  try { return dt.toLocaleDateString(APP_LOCALE, { day: "2-digit", month: "short", year: "numeric" }); }
  catch (e) { return dt.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }); }
}
function fmtDateTime(s) {
  if (!s) return "";
  const dt = new Date(s.replace(" ", "T"));
  if (isNaN(dt)) return s;
  try { return dt.toLocaleString(APP_LOCALE, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return dt.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function thisMonthISO() { return new Date().toISOString().slice(0, 7); }
function cap(s) { return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, " ") : s; }
function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (method !== "GET" && CSRF_TOKEN) {
    opts.headers["X-CSRF-Token"] = CSRF_TOKEN;
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function toast(msg, type) {
  const wrap = document.getElementById("toast-wrap");
  const el = document.createElement("div");
  el.className = "toast" + (type ? " " + type : "");
  el.innerHTML = `<i class="ti ${type === "error" ? "ti-alert-circle" : "ti-check"}"></i><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function openModal(id) { document.getElementById(id).classList.add("active"); }
function closeModal(id) { document.getElementById(id).classList.remove("active"); }

function confirmDialog(title, msg, onYes) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-msg").textContent = msg;
  openModal("modal-confirm");
  const btn = document.getElementById("confirm-yes-btn");
  const handler = () => { closeModal("modal-confirm"); btn.removeEventListener("click", handler); onYes(); };
  btn.replaceWith(btn.cloneNode(true));
  document.getElementById("confirm-yes-btn").addEventListener("click", handler);
}

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => btn.closest(".modal-overlay").classList.remove("active"));
});
document.querySelectorAll(".modal-overlay").forEach(ov => {
  ov.addEventListener("click", e => { if (e.target === ov) ov.classList.remove("active"); });
});

function buildLineChart(container, labels, seriesA, seriesB) {
  const w = 700, h = 140, pad = 20;
  const all = seriesA.concat(seriesB);
  const max = Math.max(...all, 1);
  const step = labels.length > 1 ? (w - pad * 2) / (labels.length - 1) : 0;
  const toPoints = (series) => series.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const idxs = [0, Math.floor((labels.length - 1) / 3), Math.floor((labels.length - 1) * 2 / 3), labels.length - 1];
  const labelEls = [...new Set(idxs)].map(i => {
    const x = pad + i * step;
    return `<text x="${x}" y="${h - 3}" font-size="9" fill="#718096" text-anchor="middle">${esc(fmtDate(labels[i]).replace(/, \d{4}/, ""))}</text>`;
  }).join("");
  container.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <polyline points="${toPoints(seriesA)}" fill="none" stroke="#1a7a4a" stroke-width="2"/>
    <polyline points="${toPoints(seriesB)}" fill="none" stroke="#4ade80" stroke-width="2" stroke-dasharray="4,3"/>
    ${labelEls}
  </svg>`;
}

function buildPie(container, legendContainer, slices) {
  let acc = 0;
  const parts = slices.map(s => {
    const start = acc, end = acc + (s.pct / 100) * 360;
    acc = end;
    const color = FUEL_COLORS[s.fuel_type] || "#999";
    return `${color} ${start}deg ${end}deg`;
  });
  container.style.background = slices.length ? `conic-gradient(${parts.join(",")})` : "#eee";
  legendContainer.innerHTML = slices.map(s => `
    <div class="legend-item"><div class="legend-dot" style="background:${FUEL_COLORS[s.fuel_type] || '#999'}"></div>
    ${cap(s.fuel_type)} ${s.pct}% (${fmtMoney(s.amount)})</div>`).join("") ||
    `<div style="font-size:12px;color:var(--text3)">No pending amounts yet.</div>`;
}

// Client-side replica of the server's horizontal-cylinder dip formula, for
// an instant live preview before saving.
function dipVolumeLtr(dipMm, diameterM, lengthM) {
  const r = diameterM / 2;
  const h = Math.max(0, Math.min(dipMm / 1000, diameterM));
  if (h <= 0) return 0;
  if (h >= diameterM) return Math.round(Math.PI * r * r * lengthM * 1000 * 100) / 100;
  const segArea = r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(Math.max(2 * r * h - h * h, 0));
  return Math.round(segArea * lengthM * 1000 * 100) / 100;
}

function tabWire(scopeSelector) {
  document.querySelectorAll(`${scopeSelector} .tab-btn`).forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(`${scopeSelector} .tab-btn`).forEach(b => b.classList.remove("active"));
      document.querySelectorAll(`${scopeSelector} .tab-panel`).forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.getElementById("tab-" + btn.dataset.tab);
      if (panel) panel.classList.add("active");
      if (btn.dataset.onActivate) window[btn.dataset.onActivate]();
    });
  });
}

// ---------------------------------------------------------------------
// Auth / pump registration
// ---------------------------------------------------------------------
function showLoginBox(name) {
  ["login", "register-owner", "register-manager"].forEach(n => {
    document.getElementById("login-box-" + n).style.display = (n === name) ? "block" : "none";
  });
}

async function boot() {
  let pump;
  try { pump = await api("GET", "/api/pump/status"); } catch (e) { pump = { registered: false }; }
  if (pump.business_name) {
    document.getElementById("pump-name-sub").textContent = pump.business_name;
    document.getElementById("rm-pump-name").textContent = "Register as Manager — " + pump.business_name;
  }
  if (!pump.registered) {
    showLoginBox("register-owner");
    return;
  }
  showLoginBox("login");
  await checkSession();
}

document.getElementById("switch-to-register-manager").addEventListener("click", (e) => {
  e.preventDefault(); showLoginBox("register-manager");
});
document.getElementById("switch-to-login-from-rm").addEventListener("click", (e) => {
  e.preventDefault(); showLoginBox("login");
});

document.getElementById("register-owner-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("register-owner-err");
  const btn = document.getElementById("register-owner-btn");
  err.textContent = ""; btn.disabled = true; btn.textContent = "Registering…";
  try {
    const user = await api("POST", "/api/auth/register-owner", {
      business_name: document.getElementById("ro-business-name").value.trim(),
      pump_code: document.getElementById("ro-pump-code").value.trim(),
      pump_code_confirm: document.getElementById("ro-pump-code-confirm").value.trim(),
      name: document.getElementById("ro-name").value.trim(),
      email: document.getElementById("ro-email").value.trim(),
      password: document.getElementById("ro-password").value,
    });
    CSRF_TOKEN = user.csrf_token;
    onLoggedIn(user);
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = "Register Pump & Owner"; }
});

document.getElementById("register-manager-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("register-manager-err");
  const btn = document.getElementById("register-manager-btn");
  err.textContent = ""; btn.disabled = true; btn.textContent = "Registering…";
  try {
    const user = await api("POST", "/api/auth/register-manager", {
      pump_code: document.getElementById("rm-pump-code").value.trim(),
      name: document.getElementById("rm-name").value.trim(),
      email: document.getElementById("rm-email").value.trim(),
      password: document.getElementById("rm-password").value,
    });
    CSRF_TOKEN = user.csrf_token;
    onLoggedIn(user);
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = "Register as Manager"; }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const identifier = document.getElementById("email").value.trim();
  const password = document.getElementById("pass").value;
  const err = document.getElementById("login-err");
  const btn = document.getElementById("login-btn");
  err.textContent = "";
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const user = await api("POST", "/api/auth/login", { identifier, password });
    CSRF_TOKEN = user.csrf_token;
    onLoggedIn(user);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false; btn.textContent = "Sign in to Dashboard";
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await api("POST", "/api/auth/logout"); } catch (e) { /* ignore */ }
  CURRENT_USER = null; CSRF_TOKEN = "";
  document.getElementById("main").classList.remove("active");
  boot();
});

function onLoggedIn(user) {
  CURRENT_USER = user;
  document.getElementById("role-badge").textContent = (user.role_label || user.role).toUpperCase();
  document.getElementById("user-name").textContent = user.name;
  document.getElementById("user-av").textContent = user.avatar || user.name.slice(0, 2).toUpperCase();
  document.getElementById("user-pid").textContent = user.personal_id || "";
  document.querySelectorAll("[data-roles]").forEach(el => {
    const allowed = el.dataset.roles.split(",");
    el.classList.toggle("hidden", !allowed.includes(user.role));
    if (el.tagName !== "DIV" || !el.classList.contains("nav-item")) {
      el.style.display = allowed.includes(user.role) ? "" : "none";
    }
  });
  document.getElementById("login").classList.remove("active");
  document.getElementById("main").classList.add("active");
  api("GET", "/api/pump/status").then(p => {
    if (p.business_name) document.getElementById("brand-business-name").textContent = p.business_name;
  }).catch(() => {});
  api("GET", "/api/settings").then(data => {
    applyRegionalSettings(data.settings);
    document.getElementById("today-date").textContent = fmtDate(todayISO());
    showPage("dashboard");
  }).catch(() => {
    document.getElementById("today-date").textContent = fmtDate(todayISO());
    showPage("dashboard");
  });
}

async function checkSession() {
  try {
    const data = await api("GET", "/api/auth/me");
    if (data.user) { CSRF_TOKEN = data.csrf_token; onLoggedIn(data.user); }
  } catch (e) { /* not logged in */ }
}

// ---------------------------------------------------------------------
// Navigation / routing
// ---------------------------------------------------------------------
const TITLES = {
  dashboard: ["Dashboard", "Overview of dealer udhari data"],
  udhari: ["Udhari Records", "All credit entries"],
  customers: ["Dealers / Customers", "Manage customer profiles"],
  payments: ["Payments Received", "Incoming payment records"],
  reports: ["Reports", "Analytics and export"],
  "add-entry": ["Add Udhari Entry", "Enter new udhari (credit) record"],
  upload: ["Upload Data", "Bulk upload via Excel"],
  "daily-ops": ["Daily Sales & Testing", "Sales, receipts, testing, and tank dip logging"],
  staff: ["Staff Management", "Fuel station staff profiles"],
  attendance: ["Attendance", "Date-wise staff attendance"],
  users: ["Owner/Manager Accounts", "Access control"],
  audit: ["Audit Log", "Registration, login, and change history"],
  settings: ["Settings", "System configuration"],
};

const PAGE_LOADERS = {
  dashboard: loadDashboard,
  udhari: () => loadUdhari(1),
  customers: loadCustomers,
  payments: loadPayments,
  reports: loadReportsInit,
  "add-entry": loadAddEntryPage,
  "daily-ops": loadDailyOpsPage,
  staff: loadStaffPage,
  attendance: loadAttendancePage,
  users: loadUsers,
  audit: () => loadAuditPage(1),
  settings: loadSettings,
};

function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById("page-" + id);
  if (!target) return;
  target.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === id));
  document.getElementById("page-title").textContent = TITLES[id][0];
  document.getElementById("page-sub").textContent = TITLES[id][1];
  if (PAGE_LOADERS[id]) PAGE_LOADERS[id]();
}

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => showPage(item.dataset.page));
});
document.querySelectorAll("[data-goto]").forEach(el => {
  el.addEventListener("click", () => showPage(el.dataset.goto));
});

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
async function loadDashboard() {
  let data;
  try { data = await api("GET", "/api/dashboard"); } catch (e) { toast(e.message, "error"); return; }

  document.getElementById("stat-total-udhari").textContent = fmtMoney(data.stats.total_udhari);
  document.getElementById("stat-customers").textContent = data.stats.total_customers;
  document.getElementById("stat-transactions").textContent = data.stats.total_transactions_month;
  document.getElementById("stat-received").textContent = fmtMoney(data.stats.received_month);
  document.getElementById("stat-pending").textContent = fmtMoney(data.stats.total_pending);
  document.getElementById("dash-overdue").textContent = fmtMoney(data.overdue_amount);

  buildLineChart(document.getElementById("dash-chart"), data.chart.labels, data.chart.udhari, data.chart.received);

  const tbody = document.getElementById("dash-recent-entries");
  tbody.innerHTML = data.recent_entries.length ? data.recent_entries.map(r => `
    <tr><td>${fmtDate(r.date)}</td><td>${esc(r.customer)}</td><td>${cap(r.fuel_type)}</td><td>${r.qty}</td>
    <td>${fmtMoney(r.amount)}</td><td>${fmtMoney(r.paid_amount)}</td><td>${fmtMoney(r.pending)}</td>
    <td><span class="badge ${STATUS_BADGE[r.status]}">${cap(r.status)}</span></td></tr>`).join("")
    : `<tr><td colspan="8" class="empty-state"><i class="ti ti-file-off"></i>No entries yet.</td></tr>`;

  buildPie(document.getElementById("dash-pie"), document.getElementById("dash-pie-legend"), data.pending_by_fuel);

  document.getElementById("dash-top5").innerHTML = data.top_customers.length ? data.top_customers.map(c => `
    <tr><td>${esc(c.name)}</td><td style="text-align:right;font-weight:600">${fmtMoney(c.pending)}</td></tr>`).join("")
    : `<tr><td colspan="2" style="color:var(--text3);font-size:12px;padding:10px 0">No pending customers.</td></tr>`;

  document.getElementById("dash-stock").innerHTML = data.stock.map(s => {
    const low = s.quantity <= s.low_threshold;
    return `<div class="stock-row"><div class="stock-dot" style="background:${low ? '#d93025' : (FUEL_COLORS[s.fuel_type] || '#999')}"></div>
      ${cap(s.fuel_type)}: ${fmtNum(s.quantity)} ${s.unit} ${low ? "<b style='color:#d93025'>(Low)</b>" : ""}</div>`;
  }).join("");

  const attEl = document.getElementById("dash-attendance-today");
  if (attEl) {
    const counts = {};
    (data.attendance_today || []).forEach(a => counts[a.status] = a.c);
    const marked = Object.values(counts).reduce((a, b) => a + b, 0);
    attEl.innerHTML = `${data.staff_total} active staff &bull; ${marked} marked today<br>` +
      Object.entries(counts).map(([k, v]) => `${cap(k)}: ${v}`).join(" &bull; ");
  }
}

document.getElementById("dash-record-payment-btn").addEventListener("click", () => openPaymentModal());

// ---------------------------------------------------------------------
// Udhari Records
// ---------------------------------------------------------------------
const udhariState = { page: 1, per_page: 15 };

function udhariFilters() {
  return {
    search: document.getElementById("udhari-search").value.trim(),
    fuel: document.getElementById("udhari-fuel").value,
    status: document.getElementById("udhari-status").value,
    date_from: document.getElementById("udhari-from").value,
    date_to: document.getElementById("udhari-to").value,
  };
}

async function loadUdhari(page) {
  udhariState.page = page || udhariState.page;
  const f = udhariFilters();
  const params = new URLSearchParams({ ...f, page: udhariState.page, per_page: udhariState.per_page });
  let data;
  try { data = await api("GET", "/api/entries?" + params.toString()); }
  catch (e) { toast(e.message, "error"); return; }

  const tbody = document.getElementById("udhari-tbody");
  const canEdit = CURRENT_USER && CURRENT_USER.role !== "staff";
  tbody.innerHTML = data.rows.length ? data.rows.map(r => `
    <tr>
      <td>${fmtDate(r.date)}</td><td>${esc(r.customer_name)}</td><td>${cap(r.fuel_type)}</td>
      <td>${r.qty}</td><td>${r.rate}</td><td>${fmtMoney(r.amount)}</td><td>${fmtMoney(r.paid_amount)}</td>
      <td>${fmtMoney(r.pending)}</td><td><span class="badge ${STATUS_BADGE[r.status]}">${cap(r.status)}</span></td>
      <td><div class="row-actions">
        ${r.pending > 0 ? `<button class="icon-btn" title="Record Payment" data-pay="${r.id}" data-cust="${r.customer_id}"><i class="ti ti-credit-card"></i></button>` : ""}
        ${canEdit ? `<button class="icon-btn" title="Edit" data-edit="${r.id}"><i class="ti ti-edit"></i></button>
        <button class="icon-btn danger" title="Delete" data-del="${r.id}"><i class="ti ti-trash"></i></button>` : ""}
      </div></td>
    </tr>`).join("") : `<tr><td colspan="10" class="empty-state"><i class="ti ti-file-off"></i>No udhari records found.</td></tr>`;

  const totalPages = Math.max(Math.ceil(data.total / data.per_page), 1);
  document.getElementById("udhari-count").textContent = `${data.total} record${data.total === 1 ? "" : "s"} found`;
  document.getElementById("udhari-page-label").textContent = `Page ${data.page} of ${totalPages}`;
  document.getElementById("udhari-prev").disabled = data.page <= 1;
  document.getElementById("udhari-next").disabled = data.page >= totalPages;

  tbody.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditEntry(b.dataset.edit)));
  tbody.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    confirmDialog("Delete entry?", "This will permanently remove this udhari record.", async () => {
      try { await api("DELETE", "/api/entries/" + b.dataset.del); toast("Entry deleted", "success"); loadUdhari(); loadDashboard(); }
      catch (e) { toast(e.message, "error"); }
    });
  }));
  tbody.querySelectorAll("[data-pay]").forEach(b => b.addEventListener("click", () => openPaymentModal(b.dataset.cust, b.dataset.pay)));
}

["udhari-fuel", "udhari-status", "udhari-from", "udhari-to"].forEach(id =>
  document.getElementById(id).addEventListener("change", () => loadUdhari(1)));
let udhariSearchTimer;
document.getElementById("udhari-search").addEventListener("input", () => {
  clearTimeout(udhariSearchTimer);
  udhariSearchTimer = setTimeout(() => loadUdhari(1), 350);
});
document.getElementById("udhari-prev").addEventListener("click", () => loadUdhari(udhariState.page - 1));
document.getElementById("udhari-next").addEventListener("click", () => loadUdhari(udhariState.page + 1));
document.getElementById("udhari-export").addEventListener("click", () => {
  const params = new URLSearchParams(udhariFilters());
  window.open("/api/entries/export?" + params.toString(), "_blank");
});

async function openEditEntry(id) {
  let entry;
  try { entry = await api("GET", "/api/entries/" + id); } catch (e) { toast(e.message, "error"); return; }
  document.getElementById("edit-entry-id").value = entry.id;
  document.getElementById("edit-entry-date").value = entry.date;
  document.getElementById("edit-entry-fuel").value = entry.fuel_type;
  document.getElementById("edit-entry-qty").value = entry.qty;
  document.getElementById("edit-entry-rate").value = entry.rate;
  document.getElementById("edit-entry-vehicle").value = entry.vehicle_no || "";
  document.getElementById("edit-entry-driver").value = entry.driver_name || "";
  document.getElementById("edit-entry-remarks").value = entry.remarks || "";
  document.getElementById("edit-entry-err").classList.remove("active");
  openModal("modal-edit-entry");
}
document.getElementById("edit-entry-save-btn").addEventListener("click", async () => {
  const id = document.getElementById("edit-entry-id").value;
  const payload = {
    date: document.getElementById("edit-entry-date").value,
    fuel_type: document.getElementById("edit-entry-fuel").value,
    qty: parseFloat(document.getElementById("edit-entry-qty").value) || 0,
    rate: parseFloat(document.getElementById("edit-entry-rate").value) || 0,
    vehicle_no: document.getElementById("edit-entry-vehicle").value,
    driver_name: document.getElementById("edit-entry-driver").value,
    remarks: document.getElementById("edit-entry-remarks").value,
  };
  const errEl = document.getElementById("edit-entry-err");
  try {
    await api("PUT", "/api/entries/" + id, payload);
    closeModal("modal-edit-entry");
    toast("Entry updated", "success");
    loadUdhari(); loadDashboard();
  } catch (e) { errEl.textContent = e.message; errEl.classList.add("active"); }
});

// ---------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------
async function loadCustomers() {
  const search = document.getElementById("customers-search").value.trim();
  let rows;
  try { rows = await api("GET", "/api/customers?" + new URLSearchParams({ search })); }
  catch (e) { toast(e.message, "error"); return; }
  CUSTOMERS_CACHE = rows;
  const canEdit = CURRENT_USER && CURRENT_USER.role !== "staff";
  const canDelete = CURRENT_USER && CURRENT_USER.role === "admin";
  document.getElementById("customers-tbody").innerHTML = rows.length ? rows.map(c => `
    <tr>
      <td>${esc(c.name)}</td><td>${esc(c.phone || "—")}</td><td>${esc(c.vehicle_no || "—")}</td>
      <td>${fmtMoney(c.total_udhari)}</td><td>${fmtMoney(c.pending)}</td><td>${c.txn_count}</td>
      <td><div class="row-actions">
        <button class="icon-btn" title="View Ledger" data-ledger="${c.id}"><i class="ti ti-notebook"></i></button>
        ${canEdit ? `<button class="icon-btn" title="Edit" data-edit="${c.id}"><i class="ti ti-edit"></i></button>` : ""}
        ${canDelete ? `<button class="icon-btn danger" title="Delete" data-del="${c.id}"><i class="ti ti-trash"></i></button>` : ""}
      </div></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-state"><i class="ti ti-users"></i>No customers found.</td></tr>`;

  document.querySelectorAll("#customers-tbody [data-ledger]").forEach(b => b.addEventListener("click", () => openLedger(b.dataset.ledger)));
  document.querySelectorAll("#customers-tbody [data-edit]").forEach(b => b.addEventListener("click", () => openCustomerModal(b.dataset.edit)));
  document.querySelectorAll("#customers-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
    confirmDialog("Delete customer?", "Customers with existing udhari records can't be deleted.", async () => {
      try { await api("DELETE", "/api/customers/" + b.dataset.del); toast("Customer deleted", "success"); loadCustomers(); }
      catch (e) { toast(e.message, "error"); }
    });
  }));
}
let customersSearchTimer;
document.getElementById("customers-search").addEventListener("input", () => {
  clearTimeout(customersSearchTimer);
  customersSearchTimer = setTimeout(loadCustomers, 350);
});
document.getElementById("add-customer-btn").addEventListener("click", () => openCustomerModal());

function openCustomerModal(id) {
  const form = document.getElementById("customer-form");
  form.reset();
  document.getElementById("customer-modal-err").classList.remove("active");
  document.getElementById("cust-id").value = "";
  document.getElementById("customer-modal-title").textContent = id ? "Edit Customer" : "Add Customer";
  if (id) {
    const c = CUSTOMERS_CACHE.find(x => String(x.id) === String(id));
    if (c) {
      document.getElementById("cust-id").value = c.id;
      document.getElementById("cust-name").value = c.name;
      document.getElementById("cust-phone").value = c.phone || "";
      document.getElementById("cust-vehicle").value = c.vehicle_no || "";
      document.getElementById("cust-address").value = c.address || "";
      document.getElementById("cust-gst").value = c.gst_no || "";
    }
  }
  openModal("modal-customer");
}
document.getElementById("customer-save-btn").addEventListener("click", async () => {
  const id = document.getElementById("cust-id").value;
  const payload = {
    name: document.getElementById("cust-name").value.trim(),
    phone: document.getElementById("cust-phone").value.trim(),
    vehicle_no: document.getElementById("cust-vehicle").value.trim(),
    address: document.getElementById("cust-address").value.trim(),
    gst_no: document.getElementById("cust-gst").value.trim(),
  };
  const errEl = document.getElementById("customer-modal-err");
  if (!payload.name) { errEl.textContent = "Customer name is required."; errEl.classList.add("active"); return; }
  try {
    if (id) await api("PUT", "/api/customers/" + id, payload);
    else await api("POST", "/api/customers", payload);
    closeModal("modal-customer");
    toast(id ? "Customer updated" : "Customer added", "success");
    loadCustomers();
  } catch (e) { errEl.textContent = e.message; errEl.classList.add("active"); }
});

async function openLedger(id) {
  let data;
  try { data = await api("GET", "/api/customers/" + id); } catch (e) { toast(e.message, "error"); return; }
  document.getElementById("ledger-title").textContent = data.customer.name + " — Ledger";
  document.getElementById("ledger-summary").innerHTML =
    `${esc(data.customer.phone || "No phone on file")} &bull; Vehicle: ${esc(data.customer.vehicle_no || "—")}
     &bull; <b style="color:var(--red)">Pending: ${fmtMoney(data.pending)}</b>`;
  document.getElementById("ledger-entries-tbody").innerHTML = data.entries.length ? data.entries.map(e => `
    <tr><td>${fmtDate(e.date)}</td><td>${cap(e.fuel_type)}</td><td>${e.qty}</td><td>${fmtMoney(e.amount)}</td>
    <td>${fmtMoney(e.paid_amount)}</td><td>${fmtMoney(e.amount - e.paid_amount)}</td>
    <td><span class="badge ${STATUS_BADGE[e.status]}">${cap(e.status)}</span></td></tr>`).join("")
    : `<tr><td colspan="7" class="empty-state">No entries.</td></tr>`;
  document.getElementById("ledger-payments-tbody").innerHTML = data.payments.length ? data.payments.map(p => `
    <tr><td>${fmtDate(p.date)}</td><td>${fmtMoney(p.amount)}</td><td>${cap(p.mode)}</td><td>${esc(p.remarks || "—")}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty-state">No payments recorded.</td></tr>`;
  openModal("modal-ledger");
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------
async function loadPayments() {
  const search = document.getElementById("payments-search").value.trim();
  let rows;
  try { rows = await api("GET", "/api/payments?" + new URLSearchParams({ search })); }
  catch (e) { toast(e.message, "error"); return; }
  const canDelete = CURRENT_USER && CURRENT_USER.role !== "staff";
  document.getElementById("payments-tbody").innerHTML = rows.length ? rows.map(p => `
    <tr><td>${fmtDate(p.date)}</td><td>${esc(p.customer_name)}</td><td>${fmtMoney(p.amount)}</td>
    <td>${cap(p.mode)}</td><td>${esc(p.remarks || "—")}</td>
    <td>${canDelete ? `<button class="icon-btn danger" title="Delete" data-del="${p.id}"><i class="ti ti-trash"></i></button>` : "—"}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty-state"><i class="ti ti-credit-card-off"></i>No payments recorded.</td></tr>`;

  document.querySelectorAll("#payments-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
    confirmDialog("Delete payment?", "This will restore the pending amount on the related entry.", async () => {
      try { await api("DELETE", "/api/payments/" + b.dataset.del); toast("Payment deleted", "success"); loadPayments(); loadDashboard(); }
      catch (e) { toast(e.message, "error"); }
    });
  }));
}
let paymentsSearchTimer;
document.getElementById("payments-search").addEventListener("input", () => {
  clearTimeout(paymentsSearchTimer);
  paymentsSearchTimer = setTimeout(loadPayments, 350);
});
document.getElementById("add-payment-btn").addEventListener("click", () => openPaymentModal());

async function openPaymentModal(customerId, entryId) {
  const custSelect = document.getElementById("pay-customer");
  if (!CUSTOMERS_CACHE.length) {
    try { CUSTOMERS_CACHE = await api("GET", "/api/customers"); } catch (e) { /* ignore */ }
  }
  custSelect.innerHTML = `<option value="">Select Customer</option>` +
    CUSTOMERS_CACHE.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  document.getElementById("pay-date").value = todayISO();
  document.getElementById("pay-amount").value = "";
  document.getElementById("pay-remarks").value = "";
  document.getElementById("payment-modal-err").classList.remove("active");
  document.getElementById("pay-entry").innerHTML = `<option value="">Auto-apply to oldest pending entries</option>`;

  if (customerId) {
    custSelect.value = customerId;
    await populatePendingEntries(customerId);
    if (entryId) document.getElementById("pay-entry").value = entryId;
  }
  openModal("modal-payment");
}

document.getElementById("pay-customer").addEventListener("change", (e) => populatePendingEntries(e.target.value));
async function populatePendingEntries(customerId) {
  const sel = document.getElementById("pay-entry");
  sel.innerHTML = `<option value="">Auto-apply to oldest pending entries</option>`;
  if (!customerId) return;
  try {
    const data = await api("GET", "/api/customers/" + customerId);
    data.entries.filter(e => e.amount > e.paid_amount).forEach(e => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = `${fmtDate(e.date)} • ${cap(e.fuel_type)} • Pending ${fmtMoney(e.amount - e.paid_amount)}`;
      sel.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}
document.getElementById("payment-save-btn").addEventListener("click", async () => {
  const payload = {
    customer_id: document.getElementById("pay-customer").value,
    entry_id: document.getElementById("pay-entry").value || null,
    amount: parseFloat(document.getElementById("pay-amount").value),
    date: document.getElementById("pay-date").value,
    mode: document.getElementById("pay-mode").value,
    remarks: document.getElementById("pay-remarks").value,
  };
  const errEl = document.getElementById("payment-modal-err");
  if (!payload.customer_id) { errEl.textContent = "Please select a customer."; errEl.classList.add("active"); return; }
  try {
    await api("POST", "/api/payments", payload);
    closeModal("modal-payment");
    toast("Payment recorded", "success");
    loadPayments(); loadDashboard();
    if (document.getElementById("page-udhari").classList.contains("active")) loadUdhari();
  } catch (e) { errEl.textContent = e.message; errEl.classList.add("active"); }
});

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------
let reportsCustomersLoaded = false;
async function loadReportsInit() {
  if (!reportsCustomersLoaded) {
    try {
      const customers = await api("GET", "/api/customers");
      const sel = document.getElementById("report-customer");
      sel.innerHTML = `<option value="">All Customers</option>` + customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      reportsCustomersLoaded = true;
    } catch (e) { /* ignore */ }
  }
  if (!document.getElementById("report-from").value) {
    const start = new Date(); start.setDate(1);
    document.getElementById("report-from").value = start.toISOString().slice(0, 10);
    document.getElementById("report-to").value = todayISO();
  }
  if (!document.getElementById("daily-export-date").value) {
    document.getElementById("daily-export-date").value = todayISO();
  }
  applyReport();
}
function reportFilters() {
  return {
    fuel: document.getElementById("report-fuel").value,
    customer_id: document.getElementById("report-customer").value,
    date_from: document.getElementById("report-from").value,
    date_to: document.getElementById("report-to").value,
  };
}
async function applyReport() {
  const params = new URLSearchParams(reportFilters());
  let data;
  try { data = await api("GET", "/api/reports/summary?" + params.toString()); }
  catch (e) { toast(e.message, "error"); return; }

  document.getElementById("report-total-udhari").textContent = fmtMoney(data.totals.udhari);
  document.getElementById("report-total-received").textContent = fmtMoney(data.totals.received);
  document.getElementById("report-total-pending").textContent = fmtMoney(data.totals.pending);
  document.getElementById("report-total-txns").textContent = data.totals.txns;

  buildLineChart(document.getElementById("report-chart"), data.by_date.map(r => r.date),
    data.by_date.map(r => r.udhari), data.by_date.map(r => r.received));

  document.getElementById("report-by-fuel").innerHTML = data.by_fuel.length ? data.by_fuel.map(r => `
    <tr><td>${cap(r.fuel_type)}</td><td>${r.txns}</td><td>${fmtMoney(r.udhari)}</td><td>${fmtMoney(r.received)}</td><td>${fmtMoney(r.pending)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty-state">No data for this filter.</td></tr>`;

  document.getElementById("report-by-customer").innerHTML = data.by_customer.length ? data.by_customer.map(r => `
    <tr><td>${esc(r.customer_name)}</td><td>${r.txns}</td><td>${fmtMoney(r.udhari)}</td><td>${fmtMoney(r.received)}</td><td>${fmtMoney(r.pending)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty-state">No data for this filter.</td></tr>`;
}
document.getElementById("report-apply").addEventListener("click", applyReport);
document.getElementById("report-export-csv").addEventListener("click", () => {
  const params = new URLSearchParams({ ...reportFilters(), format: "csv" });
  window.open("/api/reports/export?" + params.toString(), "_blank");
});
document.getElementById("report-export-xlsx").addEventListener("click", () => {
  const params = new URLSearchParams({ ...reportFilters(), format: "xlsx" });
  window.open("/api/reports/export?" + params.toString(), "_blank");
});
document.getElementById("daily-export-btn").addEventListener("click", () => {
  const date = document.getElementById("daily-export-date").value || todayISO();
  window.open("/api/reports/daily-export?date=" + date, "_blank");
});
document.getElementById("full-export-btn").addEventListener("click", () => {
  window.open("/api/reports/full-export", "_blank");
});
tabWire("#page-reports");

// ---------------------------------------------------------------------
// Add Udhari Entry page
// ---------------------------------------------------------------------
let entryRatesCache = {};
async function loadAddEntryPage() {
  document.getElementById("entry-date").value = todayISO();
  try {
    const customers = await api("GET", "/api/customers");
    CUSTOMERS_CACHE = customers;
    document.getElementById("entry-customer").innerHTML = `<option value="">Select Customer</option>` +
      customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  } catch (e) { /* ignore */ }
  try {
    const settingsData = await api("GET", "/api/settings");
    entryRatesCache = {
      diesel: parseFloat(settingsData.settings.rate_diesel) || 0,
      petrol: parseFloat(settingsData.settings.rate_petrol) || 0,
      cng: parseFloat(settingsData.settings.rate_cng) || 0,
    };
  } catch (e) { /* ignore */ }
  refreshRecentEntries();
}
async function refreshRecentEntries() {
  try {
    const data = await api("GET", "/api/entries?per_page=5&page=1");
    document.getElementById("entry-recent-list").innerHTML = data.rows.length ? data.rows.map(r => `
      <div class="recent-entry-row">
        <div><div class="re-name">${esc(r.customer_name)}</div><div class="re-detail">${r.qty} ${r.fuel_type === 'cng' ? 'Kg' : 'Ltr.'} ${cap(r.fuel_type)} • ${fmtDate(r.date)}</div></div>
        <div style="text-align:right"><div class="re-amt">${fmtMoney(r.amount)}</div><div><span class="pending-tag" style="${r.status === 'paid' ? 'background:#f0fdf4;color:#15803d' : ''}">${cap(r.status)}</span></div></div>
      </div>`).join("") : `<div class="empty-state" style="padding:16px 0">No entries yet.</div>`;
  } catch (e) { /* ignore */ }
}

function calcAmount() {
  const q = parseFloat(document.getElementById("entry-qty").value) || 0;
  const r = parseFloat(document.getElementById("entry-rate").value) || 0;
  document.getElementById("entry-amount-out").value = (q * r).toFixed(2);
}
document.getElementById("entry-qty").addEventListener("input", calcAmount);
document.getElementById("entry-rate").addEventListener("input", calcAmount);
document.getElementById("entry-fuel").addEventListener("change", () => {
  const f = document.getElementById("entry-fuel").value;
  if (f && entryRatesCache[f]) { document.getElementById("entry-rate").value = entryRatesCache[f]; calcAmount(); }
});
document.querySelectorAll(".fuel-btn[data-fuel]").forEach(btn => {
  btn.addEventListener("click", () => {
    const f = btn.dataset.fuel;
    document.getElementById("entry-fuel").value = f;
    if (entryRatesCache[f]) document.getElementById("entry-rate").value = entryRatesCache[f];
    calcAmount();
  });
});

document.getElementById("entry-new-customer-btn").addEventListener("click", () => {
  const input = document.getElementById("entry-new-customer-name");
  const sel = document.getElementById("entry-customer");
  const showing = input.style.display !== "none";
  input.style.display = showing ? "none" : "block";
  sel.disabled = !showing;
  if (showing) input.value = "";
});

document.getElementById("entry-reset-btn").addEventListener("click", () => {
  document.getElementById("entry-form").reset();
  document.getElementById("entry-date").value = todayISO();
  document.getElementById("entry-amount-out").value = "0.00";
  document.getElementById("entry-new-customer-name").style.display = "none";
  document.getElementById("entry-customer").disabled = false;
  document.getElementById("entry-save-msg").textContent = "";
});

document.getElementById("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("entry-save-msg");
  const btn = document.getElementById("entry-save-btn");
  const newName = document.getElementById("entry-new-customer-name").value.trim();
  const payload = {
    customer_id: document.getElementById("entry-customer").value || null,
    new_customer_name: newName || null,
    date: document.getElementById("entry-date").value,
    fuel_type: document.getElementById("entry-fuel").value,
    qty: parseFloat(document.getElementById("entry-qty").value),
    rate: parseFloat(document.getElementById("entry-rate").value),
    vehicle_no: document.getElementById("entry-vehicle").value,
    driver_name: document.getElementById("entry-driver").value,
    remarks: document.getElementById("entry-remarks").value,
  };
  if (!payload.customer_id && !payload.new_customer_name) {
    msg.style.color = "var(--red)"; msg.textContent = "Please select or add a customer.";
    return;
  }
  btn.disabled = true;
  try {
    await api("POST", "/api/entries", payload);
    msg.style.color = "var(--green)";
    msg.textContent = "Entry saved successfully!";
    document.getElementById("entry-form").reset();
    document.getElementById("entry-date").value = todayISO();
    document.getElementById("entry-amount-out").value = "0.00";
    document.getElementById("entry-new-customer-name").style.display = "none";
    document.getElementById("entry-customer").disabled = false;
    refreshRecentEntries();
    loadAddEntryPage();
    setTimeout(() => { msg.textContent = ""; }, 3000);
  } catch (ex) {
    msg.style.color = "var(--red)"; msg.textContent = ex.message;
  } finally { btn.disabled = false; }
});

// ---------------------------------------------------------------------
// Upload (shared between Add-Entry quick zone and dedicated Upload page)
// ---------------------------------------------------------------------
async function uploadFile(file, resultEl) {
  if (!file) return;
  resultEl.innerHTML = `<div style="color:var(--text3)"><i class="ti ti-loader-2"></i> Uploading and processing…</div>`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const headers = {};
    if (CSRF_TOKEN) headers["X-CSRF-Token"] = CSRF_TOKEN;
    const res = await fetch("/api/upload", { method: "POST", body: fd, credentials: "same-origin", headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    let html = `<div style="color:var(--green);font-weight:600">${data.imported} of ${data.total_rows} rows imported.</div>`;
    if (data.errors.length) {
      html += `<div style="color:var(--red);margin-top:6px;text-align:left">${data.errors.slice(0, 8).map(e => `• ${esc(e)}`).join("<br>")}</div>`;
      if (data.errors.length > 8) html += `<div style="color:var(--text3)">…and ${data.errors.length - 8} more.</div>`;
    }
    resultEl.innerHTML = html;
    toast(`Imported ${data.imported} record(s)`, data.imported ? "success" : "error");
    loadDashboard();
    if (document.getElementById("page-udhari").classList.contains("active")) loadUdhari();
    if (document.getElementById("page-add-entry").classList.contains("active")) refreshRecentEntries();
  } catch (e) {
    resultEl.innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`;
    toast(e.message, "error");
  }
}

function wireDropzone(zoneId, inputId, chooseBtnId, resultElId) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const chooseBtn = document.getElementById(chooseBtnId);
  const resultEl = document.getElementById(resultElId);
  chooseBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => { if (input.files[0]) uploadFile(input.files[0], resultEl); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("drag");
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0], resultEl);
  });
}
wireDropzone("entry-upload-zone", "entry-file-input", "entry-choose-file-btn", "entry-upload-result");
wireDropzone("upload-zone", "upload-file-input", "upload-choose-file-btn", "upload-result");
document.getElementById("entry-sample-link").addEventListener("click", () => window.open("/api/upload/sample", "_blank"));
document.getElementById("upload-sample-link").addEventListener("click", () => window.open("/api/upload/sample", "_blank"));

// ---------------------------------------------------------------------
// Daily Sales & Testing
// ---------------------------------------------------------------------
async function loadTanksCache() {
  if (Object.keys(TANKS_CACHE).length) return;
  try {
    const tanks = await api("GET", "/api/tanks");
    tanks.forEach(t => TANKS_CACHE[t.fuel_type] = t);
  } catch (e) { /* ignore */ }
}

function opsFilters() {
  return {
    date: document.getElementById("ops-date").value || todayISO(),
    shift: document.getElementById("ops-shift").value,
    fuel: document.getElementById("ops-fuel").value,
  };
}

async function loadDailyOpsPage() {
  if (!document.getElementById("ops-date").value) document.getElementById("ops-date").value = todayISO();
  await loadTanksCache();
  tabWire("#page-daily-ops");
  ["ops-date", "ops-shift", "ops-fuel"].forEach(id => {
    document.getElementById(id).onchange = refreshActiveOpsTab;
  });
  refreshActiveOpsTab();
}
function refreshActiveOpsTab() {
  const active = document.querySelector("#page-daily-ops .tab-btn.active");
  const tab = active ? active.dataset.tab : "ops-sales";
  if (tab === "ops-sales") loadSalesTab();
  else if (tab === "ops-receipts") loadReceiptsTab();
  else if (tab === "ops-testing") loadTestingTab();
  else if (tab === "ops-dip") loadDipTab();
}
document.querySelectorAll("#page-daily-ops .tab-btn").forEach(btn => btn.addEventListener("click", refreshActiveOpsTab));

function calcSalesLive() {
  const opening = parseFloat(document.getElementById("sales-opening").value) || 0;
  const receipt = parseFloat(document.getElementById("sales-receipt").value) || 0;
  const salesL = parseFloat(document.getElementById("sales-litres").value) || 0;
  const rate = parseFloat(document.getElementById("sales-rate").value) || 0;
  const testing = parseFloat(document.getElementById("sales-testing").value) || 0;
  const dipVal = document.getElementById("sales-dip").value;
  const closing = opening + receipt - salesL - testing;
  document.getElementById("sales-calc-amount").textContent = fmtMoney(salesL * rate);
  document.getElementById("sales-calc-closing").textContent = fmtNum(closing) + " L";
  if (dipVal !== "") {
    const variance = parseFloat(dipVal) - closing;
    document.getElementById("sales-calc-variance").textContent = fmtNum(variance) + " L";
  } else {
    document.getElementById("sales-calc-variance").textContent = "—";
  }
}
["sales-opening", "sales-receipt", "sales-litres", "sales-rate", "sales-testing", "sales-dip"].forEach(id =>
  document.getElementById(id).addEventListener("input", calcSalesLive));

async function loadSalesTab() {
  const f = opsFilters();
  let existing = null;
  try {
    const rows = await api("GET", `/api/daily-sales?date=${f.date}`);
    document.getElementById("sales-today-tbody").innerHTML = rows.length ? rows.map(r => `
      <tr><td>${cap(r.shift)}</td><td>${cap(r.fuel_type)}</td><td>${fmtNum(r.book_closing)}</td>
      <td>${r.variance !== null ? fmtNum(r.variance) : "—"}</td></tr>`).join("")
      : `<tr><td colspan="4" class="empty-state">No sales logged for this date yet.</td></tr>`;
    existing = rows.find(r => r.shift === f.shift && r.fuel_type === f.fuel);
  } catch (e) { toast(e.message, "error"); }

  if (existing) {
    document.getElementById("sales-opening").value = existing.opening_stock;
    document.getElementById("sales-receipt").value = existing.receipt_ltr;
    document.getElementById("sales-litres").value = existing.sales_ltr;
    document.getElementById("sales-rate").value = existing.rate;
    document.getElementById("sales-testing").value = existing.testing_ltr;
    document.getElementById("sales-dip").value = existing.physical_dip_ltr ?? "";
    document.getElementById("sales-remarks").value = existing.remarks || "";
    calcSalesLive();
  } else {
    await prefillSales();
  }
}
async function prefillSales() {
  const f = opsFilters();
  try {
    const p = await api("GET", `/api/daily-sales/prefill?date=${f.date}&shift=${f.shift}&fuel=${f.fuel}`);
    document.getElementById("sales-opening").value = p.opening_stock;
    document.getElementById("sales-receipt").value = p.receipt_ltr;
    document.getElementById("sales-testing").value = p.testing_ltr;
    document.getElementById("sales-dip").value = p.physical_dip_ltr ?? "";
    document.getElementById("sales-rate").value = p.rate;
    document.getElementById("sales-litres").value = "";
    document.getElementById("sales-remarks").value = "";
    calcSalesLive();
  } catch (e) { toast(e.message, "error"); }
}
document.getElementById("sales-prefill-btn").addEventListener("click", prefillSales);
document.getElementById("sales-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = opsFilters();
  const dipVal = document.getElementById("sales-dip").value;
  try {
    await api("POST", "/api/daily-sales", {
      date: f.date, shift: f.shift, fuel_type: f.fuel,
      opening_stock: parseFloat(document.getElementById("sales-opening").value) || 0,
      receipt_ltr: parseFloat(document.getElementById("sales-receipt").value) || 0,
      sales_ltr: parseFloat(document.getElementById("sales-litres").value) || 0,
      rate: parseFloat(document.getElementById("sales-rate").value) || 0,
      testing_ltr: parseFloat(document.getElementById("sales-testing").value) || 0,
      physical_dip_ltr: dipVal !== "" ? parseFloat(dipVal) : null,
      remarks: document.getElementById("sales-remarks").value,
    });
    toast("Daily sales saved", "success");
    loadSalesTab();
    loadDashboard();
  } catch (ex) { toast(ex.message, "error"); }
});

async function loadReceiptsTab() {
  const f = opsFilters();
  try {
    const rows = await api("GET", `/api/fuel-receipts?fuel=${f.fuel}`);
    const canDel = CURRENT_USER && CURRENT_USER.role !== "staff";
    document.getElementById("receipts-tbody").innerHTML = rows.length ? rows.slice(0, 30).map(r => `
      <tr><td>${fmtDate(r.date)}</td><td>${cap(r.fuel_type)}</td><td>${fmtNum(r.qty_ltr)}</td><td>${esc(r.invoice_no || "—")}</td>
      <td>${canDel ? `<button class="icon-btn danger" data-del="${r.id}"><i class="ti ti-trash"></i></button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="5" class="empty-state">No receipts logged yet.</td></tr>`;
    document.querySelectorAll("#receipts-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
      confirmDialog("Delete receipt?", "This will reverse the stock addition.", async () => {
        try { await api("DELETE", "/api/fuel-receipts/" + b.dataset.del); toast("Deleted", "success"); loadReceiptsTab(); loadDashboard(); }
        catch (e) { toast(e.message, "error"); }
      });
    }));
  } catch (e) { toast(e.message, "error"); }
}
document.getElementById("receipt-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = opsFilters();
  try {
    await api("POST", "/api/fuel-receipts", {
      date: f.date, shift: f.shift, fuel_type: f.fuel,
      qty_ltr: parseFloat(document.getElementById("receipt-qty").value),
      invoice_no: document.getElementById("receipt-invoice").value,
      supplier: document.getElementById("receipt-supplier").value,
      remarks: document.getElementById("receipt-remarks").value,
    });
    document.getElementById("receipt-form").reset();
    toast("Receipt saved", "success");
    loadReceiptsTab(); loadDashboard();
  } catch (ex) { toast(ex.message, "error"); }
});

async function loadTestingTab() {
  const f = opsFilters();
  try {
    const rows = await api("GET", `/api/density-entries?fuel=${f.fuel}`);
    const canDel = CURRENT_USER && CURRENT_USER.role !== "staff";
    document.getElementById("density-tbody").innerHTML = rows.length ? rows.slice(0, 30).map(r => `
      <tr><td>${fmtDate(r.date)}</td><td>${cap(r.fuel_type)}</td><td>${r.density}</td>
      <td><span class="badge ${RESULT_BADGE[r.result] || ''}">${cap(r.result)}</span></td>
      <td>${canDel ? `<button class="icon-btn danger" data-del="${r.id}"><i class="ti ti-trash"></i></button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="5" class="empty-state">No test results logged yet.</td></tr>`;
    document.querySelectorAll("#density-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
      confirmDialog("Delete test result?", "", async () => {
        try { await api("DELETE", "/api/density-entries/" + b.dataset.del); toast("Deleted", "success"); loadTestingTab(); }
        catch (e) { toast(e.message, "error"); }
      });
    }));
  } catch (e) { toast(e.message, "error"); }
}
document.getElementById("density-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = opsFilters();
  try {
    await api("POST", "/api/density-entries", {
      date: f.date, shift: f.shift, fuel_type: f.fuel,
      testing_qty_ltr: parseFloat(document.getElementById("density-qty").value) || 0,
      density: parseFloat(document.getElementById("density-value").value),
      temperature: document.getElementById("density-temp").value ? parseFloat(document.getElementById("density-temp").value) : null,
      water_check: document.getElementById("density-water").value,
      appearance: document.getElementById("density-appearance").value,
      result: document.getElementById("density-result").value,
      sample_no: document.getElementById("density-sample").value,
      tested_by: document.getElementById("density-tester").value,
      remarks: document.getElementById("density-remarks").value,
    });
    document.getElementById("density-form").reset();
    document.getElementById("density-qty").value = 5;
    toast("Test result saved", "success");
    loadTestingTab();
  } catch (ex) { toast(ex.message, "error"); }
});

function calcDipLive() {
  const f = opsFilters();
  const tank = TANKS_CACHE[f.fuel];
  const mm = parseFloat(document.getElementById("dip-mm").value) || 0;
  if (tank) {
    const vol = dipVolumeLtr(mm, tank.diameter_m, tank.length_m);
    document.getElementById("dip-calc-volume").textContent = fmtNum(Math.min(vol, tank.capacity_ltr)) + " L";
  }
}
document.getElementById("dip-mm").addEventListener("input", calcDipLive);
document.getElementById("ops-fuel").addEventListener("change", calcDipLive);

async function loadDipTab() {
  calcDipLive();
  const f = opsFilters();
  try {
    const rows = await api("GET", `/api/dip-entries?fuel=${f.fuel}`);
    const canDel = CURRENT_USER && CURRENT_USER.role !== "staff";
    document.getElementById("dip-tbody").innerHTML = rows.length ? rows.slice(0, 30).map(r => `
      <tr><td>${fmtDate(r.date)}</td><td>${cap(r.fuel_type)}</td><td>${r.dip_mm}</td><td>${fmtNum(r.dip_volume_ltr)}</td>
      <td>${r.variation_ltr !== null ? fmtNum(r.variation_ltr) : "—"}</td>
      <td>${canDel ? `<button class="icon-btn danger" data-del="${r.id}"><i class="ti ti-trash"></i></button>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty-state">No dip readings logged yet.</td></tr>`;
    document.querySelectorAll("#dip-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
      confirmDialog("Delete dip reading?", "", async () => {
        try { await api("DELETE", "/api/dip-entries/" + b.dataset.del); toast("Deleted", "success"); loadDipTab(); }
        catch (e) { toast(e.message, "error"); }
      });
    }));
  } catch (e) { toast(e.message, "error"); }
}
document.getElementById("dip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = opsFilters();
  try {
    await api("POST", "/api/dip-entries", {
      date: f.date, shift: f.shift, fuel_type: f.fuel,
      dip_mm: parseFloat(document.getElementById("dip-mm").value),
      density: document.getElementById("dip-density").value ? parseFloat(document.getElementById("dip-density").value) : null,
      temperature: document.getElementById("dip-temp").value ? parseFloat(document.getElementById("dip-temp").value) : null,
      remarks: document.getElementById("dip-remarks").value,
    });
    document.getElementById("dip-form").reset();
    document.getElementById("dip-calc-volume").textContent = "0 L";
    toast("Dip reading saved", "success");
    loadDipTab();
    loadDashboard();
  } catch (ex) { toast(ex.message, "error"); }
});

// ---------------------------------------------------------------------
// Staff Management
// ---------------------------------------------------------------------
let STAFF_CACHE = [];
async function loadStaffPage() {
  let rows;
  try { rows = await api("GET", "/api/staff"); } catch (e) { toast(e.message, "error"); return; }
  STAFF_CACHE = rows;
  const canDelete = CURRENT_USER && CURRENT_USER.role === "admin";
  document.getElementById("staff-tbody").innerHTML = rows.length ? rows.map(s => `
    <tr><td>${esc(s.personal_id)}</td><td>${esc(s.name)}</td><td>${esc(s.employee_code || "—")}</td>
    <td>${esc(s.phone || "—")}</td><td>${esc(s.designation || "—")}</td><td>${cap(s.shift || "—")}</td>
    <td>${s.joining_date ? fmtDate(s.joining_date) : "—"}</td>
    <td><span class="badge ${s.active ? 'badge-green' : 'badge-red'}">${s.active ? "Active" : "Inactive"}</span></td>
    <td><div class="row-actions">
      <button class="icon-btn" title="Edit" data-edit="${s.id}"><i class="ti ti-edit"></i></button>
      ${canDelete ? `<button class="icon-btn danger" title="Delete" data-del="${s.id}"><i class="ti ti-trash"></i></button>` : ""}
    </div></td></tr>`).join("") : `<tr><td colspan="9" class="empty-state"><i class="ti ti-id-badge-off"></i>No staff added yet.</td></tr>`;

  document.querySelectorAll("#staff-tbody [data-edit]").forEach(b => b.addEventListener("click", () => openStaffModal(b.dataset.edit)));
  document.querySelectorAll("#staff-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
    confirmDialog("Delete staff member?", "Staff with attendance history can't be deleted — deactivate instead.", async () => {
      try { await api("DELETE", "/api/staff/" + b.dataset.del); toast("Staff deleted", "success"); loadStaffPage(); }
      catch (e) { toast(e.message, "error"); }
    });
  }));
}
document.getElementById("add-staff-btn").addEventListener("click", () => openStaffModal());

function openStaffModal(id) {
  document.getElementById("staff-form").reset();
  document.getElementById("staff-modal-err").classList.remove("active");
  document.getElementById("staff-temp-password-note").style.display = "none";
  document.getElementById("staff-id").value = "";
  document.getElementById("staff-reset-password-wrap").style.display = id ? "block" : "none";
  document.getElementById("staff-password-label").textContent = id ? "New Password (optional)" : "Password (leave blank to auto-generate)";
  document.getElementById("staff-modal-title").textContent = id ? "Edit Staff" : "Add Staff";
  if (id) {
    const s = STAFF_CACHE.find(x => String(x.id) === String(id));
    if (s) {
      document.getElementById("staff-id").value = s.id;
      document.getElementById("staff-name").value = s.name;
      document.getElementById("staff-employee-code").value = s.employee_code || "";
      document.getElementById("staff-phone").value = s.phone || "";
      document.getElementById("staff-email").value = (s.email || "").endsWith("@staff.local") ? "" : (s.email || "");
      document.getElementById("staff-designation").value = s.designation || "";
      document.getElementById("staff-shift").value = s.shift || "";
      document.getElementById("staff-joining-date").value = s.joining_date || "";
      document.getElementById("staff-emergency").value = s.emergency_contact || "";
      document.getElementById("staff-address").value = s.address || "";
      document.getElementById("staff-notes").value = s.notes || "";
      document.getElementById("staff-active").value = s.active ? "1" : "0";
    }
  } else {
    document.getElementById("staff-joining-date").value = todayISO();
    document.getElementById("staff-active").value = "1";
  }
  openModal("modal-staff");
}
document.getElementById("staff-save-btn").addEventListener("click", async () => {
  const id = document.getElementById("staff-id").value;
  const errEl = document.getElementById("staff-modal-err");
  errEl.classList.remove("active");
  const payload = {
    name: document.getElementById("staff-name").value.trim(),
    employee_code: document.getElementById("staff-employee-code").value.trim(),
    phone: document.getElementById("staff-phone").value.trim(),
    email: document.getElementById("staff-email").value.trim(),
    designation: document.getElementById("staff-designation").value.trim(),
    shift: document.getElementById("staff-shift").value,
    joining_date: document.getElementById("staff-joining-date").value,
    emergency_contact: document.getElementById("staff-emergency").value.trim(),
    address: document.getElementById("staff-address").value.trim(),
    notes: document.getElementById("staff-notes").value.trim(),
    active: parseInt(document.getElementById("staff-active").value, 10),
  };
  if (!payload.name) { errEl.textContent = "Staff name is required."; errEl.classList.add("active"); return; }
  const password = document.getElementById("staff-password").value;
  if (password) payload.password = password;
  if (id && document.getElementById("staff-reset-password").checked) payload.reset_password = true;

  try {
    let result;
    if (id) result = await api("PUT", "/api/staff/" + id, payload);
    else result = await api("POST", "/api/staff", payload);
    toast(id ? "Staff updated" : "Staff added", "success");
    loadStaffPage();
    if (result.temp_password) {
      const note = document.getElementById("staff-temp-password-note");
      note.style.display = "block";
      note.innerHTML = `<b>Temporary password:</b> ${esc(result.temp_password)}<br>Personal ID: <b>${esc(result.personal_id || '')}</b><br>Share these with the staff member now — the password won't be shown again.`;
    } else {
      closeModal("modal-staff");
    }
  } catch (e) { errEl.textContent = e.message; errEl.classList.add("active"); }
});

// ---------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------
async function loadAttendancePage() {
  if (!document.getElementById("att-date").value) document.getElementById("att-date").value = todayISO();
  if (!document.getElementById("att-month").value) document.getElementById("att-month").value = thisMonthISO();
  tabWire("#page-attendance");
  document.getElementById("att-date").onchange = loadAttendanceDay;
  document.getElementById("att-month").onchange = loadAttendanceSummary;
  document.querySelectorAll("#page-attendance .tab-btn").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.tab === "att-summary") loadAttendanceSummary();
  }));
  loadAttendanceDay();
}
async function loadAttendanceDay() {
  const date = document.getElementById("att-date").value || todayISO();
  let data;
  try { data = await api("GET", "/api/attendance?date=" + date); } catch (e) { toast(e.message, "error"); return; }
  document.getElementById("attendance-tbody").innerHTML = data.rows.length ? data.rows.map(r => `
    <tr data-staff="${r.staff_id}">
      <td>${esc(r.name)}<div style="font-size:10px;color:var(--text3)">${esc(r.personal_id)}</div></td>
      <td><select class="form-input form-select att-status">
        ${["present", "absent", "half_day", "leave", "off"].map(s => `<option value="${s}" ${r.status === s ? "selected" : ""}>${cap(s)}</option>`).join("")}
      </select></td>
      <td><input class="form-input att-checkin" type="time" value="${r.check_in || ""}"></td>
      <td><input class="form-input att-checkout" type="time" value="${r.check_out || ""}"></td>
      <td><select class="form-input form-select att-shift">
        <option value="">—</option>
        ${["morning", "evening", "night"].map(s => `<option value="${s}" ${r.shift === s ? "selected" : ""}>${cap(s)}</option>`).join("")}
      </select></td>
      <td><input class="form-input att-remarks" value="${esc(r.remarks || "")}"></td>
      <td><button class="btn btn-primary att-save">Save</button></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-state">No active staff to mark attendance for.</td></tr>`;

  document.querySelectorAll("#attendance-tbody .att-save").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      try {
        await api("POST", "/api/attendance", {
          staff_id: row.dataset.staff, date,
          status: row.querySelector(".att-status").value,
          check_in: row.querySelector(".att-checkin").value,
          check_out: row.querySelector(".att-checkout").value,
          shift: row.querySelector(".att-shift").value,
          remarks: row.querySelector(".att-remarks").value,
        });
        toast("Attendance saved", "success");
      } catch (e) { toast(e.message, "error"); }
    });
  });
}
async function loadAttendanceSummary() {
  const month = document.getElementById("att-month").value || thisMonthISO();
  let data;
  try { data = await api("GET", "/api/attendance/summary?month=" + month); } catch (e) { toast(e.message, "error"); return; }
  document.getElementById("attendance-summary-tbody").innerHTML = data.rows.length ? data.rows.map(r => `
    <tr><td>${esc(r.name)}</td><td>${r.present}</td><td>${r.absent}</td><td>${r.half_day}</td><td>${r.leave_days}</td><td>${r.off_days}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty-state">No staff found.</td></tr>`;
}

// ---------------------------------------------------------------------
// Users & Roles (Owner/Manager accounts)
// ---------------------------------------------------------------------
let USERS_CACHE = [];
async function loadUsers() {
  let rows;
  try { rows = await api("GET", "/api/users"); } catch (e) { toast(e.message, "error"); return; }
  USERS_CACHE = rows;
  document.getElementById("users-tbody").innerHTML = rows.map(u => `
    <tr><td>${esc(u.personal_id || "—")}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><span class="badge badge-role ${u.role}">${esc(u.role_label || cap(u.role))}</span></td>
    <td><span class="badge ${u.active ? 'badge-green' : 'badge-red'}">${u.active ? "Active" : "Inactive"}</span></td>
    <td><div class="row-actions">
      <button class="icon-btn" title="Edit" data-edit="${u.id}"><i class="ti ti-edit"></i></button>
      ${CURRENT_USER && u.id !== CURRENT_USER.id ? `<button class="icon-btn danger" title="Delete" data-del="${u.id}"><i class="ti ti-trash"></i></button>` : ""}
    </div></td></tr>`).join("");

  document.querySelectorAll("#users-tbody [data-edit]").forEach(b => b.addEventListener("click", () => openUserModal(b.dataset.edit)));
  document.querySelectorAll("#users-tbody [data-del]").forEach(b => b.addEventListener("click", () => {
    confirmDialog("Delete account?", "This will permanently remove their access.", async () => {
      try { await api("DELETE", "/api/users/" + b.dataset.del); toast("Account deleted", "success"); loadUsers(); }
      catch (e) { toast(e.message, "error"); }
    });
  }));
}
document.getElementById("add-user-btn").addEventListener("click", () => openUserModal());

function openUserModal(id) {
  document.getElementById("user-form").reset();
  document.getElementById("user-modal-err").classList.remove("active");
  document.getElementById("user-id").value = "";
  document.getElementById("user-modal-title").textContent = id ? "Edit Account" : "Add Account";
  document.getElementById("user-password-label").innerHTML = id ? "New Password" : 'Password <span>*</span>';
  document.getElementById("user-password").placeholder = id ? "Leave blank to keep unchanged" : "Set a password";
  if (id) {
    const u = USERS_CACHE.find(x => String(x.id) === String(id));
    if (u) {
      document.getElementById("user-id").value = u.id;
      document.getElementById("user-name-field").value = u.name;
      document.getElementById("user-email").value = u.email;
      document.getElementById("user-email").disabled = true;
      document.getElementById("user-role").value = u.role;
      document.getElementById("user-active").value = u.active ? "1" : "0";
    }
  } else {
    document.getElementById("user-email").disabled = false;
  }
  openModal("modal-user");
}
document.getElementById("user-save-btn").addEventListener("click", async () => {
  const id = document.getElementById("user-id").value;
  const errEl = document.getElementById("user-modal-err");
  const password = document.getElementById("user-password").value;
  try {
    if (id) {
      const payload = {
        name: document.getElementById("user-name-field").value.trim(),
        role: document.getElementById("user-role").value,
        active: parseInt(document.getElementById("user-active").value, 10),
      };
      if (password) payload.password = password;
      await api("PUT", "/api/users/" + id, payload);
      toast("Account updated", "success");
    } else {
      const payload = {
        name: document.getElementById("user-name-field").value.trim(),
        email: document.getElementById("user-email").value.trim(),
        role: document.getElementById("user-role").value,
        password,
      };
      await api("POST", "/api/users", payload);
      toast("Account created", "success");
    }
    closeModal("modal-user");
    loadUsers();
  } catch (e) { errEl.textContent = e.message; errEl.classList.add("active"); }
});

// ---------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------
const auditState = { page: 1, per_page: 20 };
async function loadAuditPage(page) {
  auditState.page = page || auditState.page;
  const action = document.getElementById("audit-action-filter").value;
  let data;
  try {
    data = await api("GET", `/api/audit-log?page=${auditState.page}&per_page=${auditState.per_page}&action=${action}`);
  } catch (e) { toast(e.message, "error"); return; }

  document.getElementById("audit-tbody").innerHTML = data.rows.length ? data.rows.map(r => `
    <tr><td>${fmtDateTime(r.created_at)}</td><td>${esc(r.user_name || "—")}</td><td>${esc(cap(r.action))}</td>
    <td>${esc(cap(r.entity))}${r.entity_id ? " #" + r.entity_id : ""}</td><td>${esc(r.details || "—")}</td>
    <td>${esc(r.ip_address || "—")}</td>
    <td><span class="badge ${r.success ? 'badge-green' : 'badge-red'}">${r.success ? "OK" : "Failed"}</span></td></tr>`).join("")
    : `<tr><td colspan="7" class="empty-state">No audit events found.</td></tr>`;

  const totalPages = Math.max(Math.ceil(data.total / data.per_page), 1);
  document.getElementById("audit-count").textContent = `${data.total} event${data.total === 1 ? "" : "s"}`;
  document.getElementById("audit-page-label").textContent = `Page ${data.page} of ${totalPages}`;
  document.getElementById("audit-prev").disabled = data.page <= 1;
  document.getElementById("audit-next").disabled = data.page >= totalPages;
}
document.getElementById("audit-action-filter").addEventListener("change", () => loadAuditPage(1));
document.getElementById("audit-prev").addEventListener("click", () => loadAuditPage(auditState.page - 1));
document.getElementById("audit-next").addEventListener("click", () => loadAuditPage(auditState.page + 1));

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
async function loadSettings() {
  let data;
  try { data = await api("GET", "/api/settings"); } catch (e) { toast(e.message, "error"); return; }
  const s = data.settings;
  document.getElementById("set-business-name").value = s.business_name || "";
  document.getElementById("set-business-address").value = s.business_address || "";
  document.getElementById("set-gst").value = s.gst_no || "";
  document.getElementById("set-currency-symbol").value = s.currency_symbol || "";
  document.getElementById("set-currency-code").value = s.currency_code || "";
  if (s.locale) document.getElementById("set-locale").value = s.locale;
  document.getElementById("set-rate-diesel").value = s.rate_diesel || "";
  document.getElementById("set-rate-petrol").value = s.rate_petrol || "";
  document.getElementById("set-rate-cng").value = s.rate_cng || "";
  applyRegionalSettings(s);

  const canEditSettings = CURRENT_USER && CURRENT_USER.role !== "staff";
  document.querySelectorAll("#settings-business-form input, #settings-business-form button").forEach(el => el.disabled = !canEditSettings);

  const stockWrap = document.getElementById("stock-rows-wrap");
  stockWrap.innerHTML = data.stock.map(st => `
    <div class="stock-edit-row">
      <label>${cap(st.fuel_type)}</label>
      <input class="form-input" type="number" step="0.01" data-fuel="${st.fuel_type}" data-field="quantity" value="${st.quantity}" placeholder="Quantity" ${canEditSettings ? "" : "disabled"}>
      <input class="form-input" type="number" step="0.01" data-fuel="${st.fuel_type}" data-field="low_threshold" value="${st.low_threshold}" placeholder="Low stock alert at" ${canEditSettings ? "" : "disabled"}>
    </div>`).join("");
  document.getElementById("settings-stock-save").disabled = !canEditSettings;

  if (CURRENT_USER && CURRENT_USER.role === "admin") {
    document.getElementById("pump-security-status").innerHTML = data.pump_code_set
      ? `<span style="color:var(--green)"><i class="ti ti-shield-check"></i> Pump code is set.</span> Resetting it requires your account password.`
      : `<span style="color:var(--red)"><i class="ti ti-shield-x"></i> Pump code is not set yet.</span> Set one below so Managers can register.`;
    document.getElementById("pump-code-current-wrap").style.display = data.pump_code_set ? "block" : "none";
  }
}
document.getElementById("settings-business-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("settings-msg");
  try {
    const payload = {
      business_name: document.getElementById("set-business-name").value,
      business_address: document.getElementById("set-business-address").value,
      gst_no: document.getElementById("set-gst").value,
      currency_symbol: document.getElementById("set-currency-symbol").value,
      currency_code: document.getElementById("set-currency-code").value,
      locale: document.getElementById("set-locale").value,
      rate_diesel: document.getElementById("set-rate-diesel").value,
      rate_petrol: document.getElementById("set-rate-petrol").value,
      rate_cng: document.getElementById("set-rate-cng").value,
    };
    await api("PUT", "/api/settings", payload);
    applyRegionalSettings(payload);
    msg.style.color = "var(--green)"; msg.textContent = "Settings saved.";
    toast("Settings updated", "success");
    document.getElementById("brand-business-name").textContent = document.getElementById("set-business-name").value;
    loadDashboard();
    setTimeout(() => msg.textContent = "", 2500);
  } catch (ex) { msg.style.color = "var(--red)"; msg.textContent = ex.message; }
});
document.getElementById("settings-stock-save").addEventListener("click", async () => {
  const rows = Array.from(document.querySelectorAll("#stock-rows-wrap .stock-edit-row")).map(row => {
    const inputs = row.querySelectorAll("input");
    return { fuel_type: inputs[0].dataset.fuel, quantity: inputs[0].value, low_threshold: inputs[1].value };
  });
  try {
    await api("PUT", "/api/settings", { stock: rows });
    toast("Stock levels updated", "success");
    loadDashboard();
  } catch (e) { toast(e.message, "error"); }
});
document.getElementById("settings-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("password-msg");
  try {
    await api("PUT", "/api/auth/password", {
      current_password: document.getElementById("set-current-pw").value,
      new_password: document.getElementById("set-new-pw").value,
    });
    msg.style.color = "var(--green)"; msg.textContent = "Password updated.";
    document.getElementById("settings-password-form").reset();
    toast("Password updated", "success");
  } catch (ex) { msg.style.color = "var(--red)"; msg.textContent = ex.message; }
});
document.getElementById("pump-code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("pump-code-msg");
  try {
    await api("PUT", "/api/pump/code", {
      new_code: document.getElementById("pump-new-code").value.trim(),
      confirm_code: document.getElementById("pump-confirm-code").value.trim(),
      current_password: document.getElementById("pump-current-password").value,
    });
    msg.style.color = "var(--green)"; msg.textContent = "Pump code updated.";
    document.getElementById("pump-code-form").reset();
    toast("Pump code updated", "success");
    loadSettings();
  } catch (ex) { msg.style.color = "var(--red)"; msg.textContent = ex.message; }
});

// Ledger modal tabs
tabWire("#modal-ledger");

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
boot();

})();
