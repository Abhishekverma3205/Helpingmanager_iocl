"""
Database layer for Fuel Station Manager.
Uses plain sqlite3 (no ORM) for simplicity and transparency.
"""
import sqlite3
import os
import math
from datetime import datetime, timedelta
from werkzeug.security import generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH") or os.path.join(BASE_DIR, "instance", "dealer.db")

# Standard 20 KL (20,000 litre) horizontal cylindrical underground storage tank.
# diameter fixed at 2.0 m; length derived so that pi*r^2*L == 20,000 litres (20 m^3).
_TANK_DIAMETER_M = 2.0
_TANK_RADIUS_M = _TANK_DIAMETER_M / 2
_TANK_LENGTH_M = round(20.0 / (math.pi * _TANK_RADIUS_M ** 2), 4)
TANK_DEFAULTS = [
    ("diesel", _TANK_DIAMETER_M, _TANK_LENGTH_M),
    ("petrol", _TANK_DIAMETER_M, _TANK_LENGTH_M),
]

# Role labels shown in the UI. The stored role value never changes (keeps
# every existing query / legacy login working); only the display label
# changes so "admin" reads as "Owner" everywhere in the app.
ROLE_LABELS = {"admin": "Owner", "manager": "Manager", "staff": "Staff"}
PERSONAL_ID_PREFIX = {"admin": "OWN", "manager": "MGR", "staff": "STF"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','manager','staff')),
    avatar TEXT,
    active INTEGER DEFAULT 1,
    personal_id TEXT,
    employee_code TEXT,
    phone TEXT,
    designation TEXT,
    joining_date TEXT,
    shift TEXT,
    emergency_contact TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    vehicle_no TEXT,
    gst_no TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    fuel_type TEXT NOT NULL,
    qty REAL NOT NULL,
    rate REAL NOT NULL,
    amount REAL NOT NULL,
    paid_amount REAL DEFAULT 0,
    vehicle_no TEXT,
    driver_name TEXT,
    remarks TEXT,
    status TEXT DEFAULT 'pending',
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    entry_id INTEGER,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    mode TEXT DEFAULT 'cash',
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS stock (
    fuel_type TEXT PRIMARY KEY,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    low_threshold REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Single-pump identity & security. Exactly one row (id=1) ever exists.
CREATE TABLE IF NOT EXISTS pump (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    business_name TEXT NOT NULL,
    pump_code_hash TEXT,
    owner_user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tanks (
    fuel_type TEXT PRIMARY KEY,
    capacity_ltr REAL NOT NULL,
    diameter_m REAL NOT NULL,
    length_m REAL NOT NULL
);

-- Daily fuel testing (density check) — separate from the tank dip reading.
CREATE TABLE IF NOT EXISTS density_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL DEFAULT 'morning',
    fuel_type TEXT NOT NULL,
    testing_qty_ltr REAL DEFAULT 0,
    density REAL NOT NULL,
    temperature REAL,
    water_check TEXT DEFAULT 'pass',
    appearance TEXT,
    result TEXT DEFAULT 'pass',
    sample_no TEXT,
    tested_by TEXT,
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Physical 20 KL tank dip readings.
CREATE TABLE IF NOT EXISTS dip_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL DEFAULT 'morning',
    fuel_type TEXT NOT NULL,
    dip_mm REAL NOT NULL,
    dip_volume_ltr REAL NOT NULL,
    book_stock_ltr REAL,
    variation_ltr REAL,
    density REAL,
    temperature REAL,
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Fuel receipts / stock inward (tanker deliveries).
CREATE TABLE IF NOT EXISTS fuel_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL DEFAULT 'morning',
    fuel_type TEXT NOT NULL,
    qty_ltr REAL NOT NULL,
    invoice_no TEXT,
    supplier TEXT,
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

-- One row per date + shift + fuel type. Book Closing = Opening + Receipts - Sales - Testing.
CREATE TABLE IF NOT EXISTS daily_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL DEFAULT 'morning',
    fuel_type TEXT NOT NULL,
    opening_stock REAL NOT NULL DEFAULT 0,
    receipt_ltr REAL NOT NULL DEFAULT 0,
    sales_ltr REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    sales_amount REAL NOT NULL DEFAULT 0,
    testing_ltr REAL NOT NULL DEFAULT 0,
    book_closing REAL NOT NULL DEFAULT 0,
    physical_dip_ltr REAL,
    variance REAL,
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, shift, fuel_type),
    FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Date-wise staff attendance.
CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'present',
    check_in TEXT,
    check_out TEXT,
    shift TEXT,
    remarks TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(staff_id, date),
    FOREIGN KEY(staff_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
    identifier TEXT PRIMARY KEY,
    failed_count INTEGER DEFAULT 0,
    locked_until TEXT
);

-- Append-only audit trail: registration, login/logout, sensitive changes.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    details TEXT,
    ip_address TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""

# Columns added after the original release; applied via ALTER TABLE so an
# existing dealer's database (and all of their real data) upgrades in place
# instead of being recreated.
USERS_NEW_COLUMNS = [
    ("personal_id", "TEXT"),
    ("employee_code", "TEXT"),
    ("phone", "TEXT"),
    ("designation", "TEXT"),
    ("joining_date", "TEXT"),
    ("shift", "TEXT"),
    ("emergency_contact", "TEXT"),
    ("address", "TEXT"),
    ("notes", "TEXT"),
]
DENSITY_NEW_COLUMNS = [
    ("testing_qty_ltr", "REAL DEFAULT 0"),
    ("water_check", "TEXT DEFAULT 'pass'"),
    ("appearance", "TEXT"),
    ("result", "TEXT DEFAULT 'pass'"),
    ("sample_no", "TEXT"),
    ("tested_by", "TEXT"),
]


# MongoDB is the persistent data store. To minimize risk in this migration, the existing
# SQL statements in app.py are executed against an in-memory SQLite compatibility snapshot;
# changed tables are then persisted to MongoDB. This keeps existing business rules/routes
# intact while the app transitions, but it is intended for small, single-worker deployments.
import re
from pymongo import MongoClient, ASCENDING
from pymongo.errors import PyMongoError

MONGO_URI = os.environ.get("MONGO_URI", "").strip()
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME", "fuel_station_manager").strip() or "fuel_station_manager"

_mongo_client = None
_mongo_db = None


def _mongo():
    global _mongo_client, _mongo_db
    if not MONGO_URI:
        raise RuntimeError(
            "MongoDB is not configured. Set MONGO_URI in your .env file, for example "
            "mongodb+srv://<username>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority"
        )
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000, connectTimeoutMS=8000)
        _mongo_db = _mongo_client[MONGO_DB_NAME]
    return _mongo_db


def _table_from_sql(sql):
    match = re.search(r"\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+[\"`]?([a-zA-Z_][\w]*)", sql, re.I)
    return match.group(1).lower() if match else None


class _CursorProxy:
    def __init__(self, owner, cursor):
        self._owner = owner
        self._cursor = cursor

    def execute(self, sql, args=()):
        self._owner._mark_write(sql)
        self._cursor.execute(sql, args)
        return self

    def executemany(self, sql, seq):
        self._owner._mark_write(sql)
        self._cursor.executemany(sql, seq)
        return self

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class _MongoSQLConnection:
    """Small SQL-compatibility connection; MongoDB remains the durable store."""
    def __init__(self):
        self._conn = sqlite3.connect(":memory:")
        self._conn.row_factory = sqlite3.Row
        self._dirty_tables = set()
        self._closed = False
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(SCHEMA)
        self._load_snapshot()

    @property
    def row_factory(self):
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._conn.row_factory = value

    def _mark_write(self, sql):
        table = _table_from_sql(sql)
        if table:
            self._dirty_tables.add(table)

    def _table_names(self):
        return [r[0] for r in self._conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]

    def _load_snapshot(self):
        mongo = _mongo()
        for table in self._table_names():
            columns = [r[1] for r in self._conn.execute(f"PRAGMA table_info({table})").fetchall()]
            if not columns:
                continue
            docs = list(mongo[table].find({}))
            for doc in docs:
                fields = [c for c in columns if c in doc]
                # _id is Mongo's document key; SQL uses the table's original primary-key field.
                if not fields:
                    continue
                placeholders = ",".join("?" for _ in fields)
                names = ",".join(f'"{c}"' for c in fields)
                vals = [doc.get(c) for c in fields]
                try:
                    self._conn.execute(f'INSERT OR IGNORE INTO "{table}" ({names}) VALUES ({placeholders})', vals)
                except sqlite3.Error:
                    # A legacy document missing a newly-added optional field is upgraded by schema defaults.
                    continue

    def execute(self, sql, args=()):
        self._mark_write(sql)
        return self._conn.execute(sql, args)

    def executemany(self, sql, seq):
        self._mark_write(sql)
        return self._conn.executemany(sql, seq)

    def cursor(self):
        return _CursorProxy(self, self._conn.cursor())

    def executescript(self, sql_script):
        # DDL is local to each SQL compatibility snapshot. Data-changing statements are tracked.
        for statement in sql_script.split(";"):
            self._mark_write(statement)
        return self._conn.executescript(sql_script)

    def _persist(self):
        if not self._dirty_tables:
            self._conn.commit()
            return
        mongo = _mongo()
        tables = list(self._dirty_tables)
        # Persist only affected collections. For this transitional bridge, use one worker to avoid
        # concurrent full-collection rewrites; native Mongo CRUD is the next optimization step.
        for table in tables:
            columns = self._conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not columns:
                continue
            pk_columns = [r[1] for r in columns if r[5]]
            rows = self._conn.execute(f'SELECT * FROM "{table}"').fetchall()
            documents = []
            for row in rows:
                doc = dict(row)
                if pk_columns:
                    pk = pk_columns[0]
                    doc["_id"] = doc.get(pk)
                else:
                    doc["_id"] = doc.get("id")
                documents.append(doc)
            collection = mongo[table]
            collection.delete_many({})
            if documents:
                collection.insert_many(documents, ordered=True)
        self._conn.commit()
        self._dirty_tables.clear()

    def commit(self):
        self._persist()

    def close(self):
        if self._closed:
            return
        try:
            self._persist()
        finally:
            self._conn.close()
            self._closed = True


def get_db():
    return _MongoSQLConnection()


def query_db(query, args=(), one=False):
    conn = get_db()
    try:
        rows = conn.execute(query, args).fetchall()
        result = [dict(r) for r in rows]
        if one:
            return result[0] if result else None
        return result
    finally:
        conn.close()


def execute_db(query, args=()):
    conn = get_db()
    try:
        cur = conn.execute(query, args)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def init_db():
    mongo = _mongo()
    # Verify connectivity early so misconfigured deployments fail with a useful message.
    _mongo_client.admin.command("ping")
    # Create unique indexes corresponding to important relational constraints.
    mongo["users"].create_index([("email", ASCENDING)], unique=True, sparse=True)
    mongo["users"].create_index([("personal_id", ASCENDING)], unique=True, partialFilterExpression={"personal_id": {"$type": "string", "$gt": ""}})
    mongo["daily_sales"].create_index([("date", ASCENDING), ("shift", ASCENDING), ("fuel_type", ASCENDING)], unique=True, sparse=True)
    # Initialize missing collection schemas without overwriting any existing records.
    conn = get_db()
    conn.close()


def is_fresh_db():
    row = query_db("SELECT COUNT(*) as c FROM users", one=True)
    return row is None or row["c"] == 0


def _add_column_if_missing(conn, table, col_name, col_def):
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if col_name not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}")


def next_personal_id(role, conn=None):
    """Next sequential Personal ID for a role, e.g. OWN-0001, MGR-0002, STF-0013."""
    owns_conn = conn is None
    conn = conn or get_db()
    prefix = PERSONAL_ID_PREFIX.get(role, "USR")
    row = conn.execute(
        "SELECT personal_id FROM users WHERE role=? AND personal_id LIKE ? ORDER BY id DESC LIMIT 1",
        (role, f"{prefix}-%"),
    ).fetchone()
    n = 1
    if row and row["personal_id"]:
        try:
            n = int(row["personal_id"].split("-")[-1]) + 1
        except ValueError:
            n = 1
    if owns_conn:
        conn.close()
    return f"{prefix}-{n:04d}"


def migrate_schema():
    """Apply backward-compatible defaults and legacy account fixes."""
    conn = get_db()
    try:
        for col, coldef in USERS_NEW_COLUMNS:
            _add_column_if_missing(conn, "users", col, coldef)
        for col, coldef in DENSITY_NEW_COLUMNS:
            _add_column_if_missing(conn, "density_entries", col, coldef)
        users_missing = conn.execute(
            "SELECT id, role FROM users WHERE personal_id IS NULL OR personal_id='' ORDER BY id ASC"
        ).fetchall()
        for u in users_missing:
            pid = next_personal_id(u["role"], conn=conn)
            conn.execute("UPDATE users SET personal_id=? WHERE id=?", (pid, u["id"]))
        pump = conn.execute("SELECT * FROM pump WHERE id=1").fetchone()
        owner = conn.execute("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").fetchone()
        if not pump and owner:
            biz = conn.execute("SELECT value FROM settings WHERE key='business_name'").fetchone()
            conn.execute(
                "INSERT INTO pump (id,business_name,pump_code_hash,owner_user_id) VALUES (1,?,NULL,?)",
                (biz["value"] if biz else "Fuel Station", owner["id"]),
            )
        for fuel_type, diameter_m, length_m in TANK_DEFAULTS:
            conn.execute(
                "INSERT OR IGNORE INTO tanks (fuel_type,capacity_ltr,diameter_m,length_m) VALUES (?,?,?,?)",
                (fuel_type, 20000.0, diameter_m, length_m),
            )
        default_settings = {
            "business_name": "", "business_address": "", "gst_no": "",
            "currency_symbol": "$", "currency_code": "USD", "locale": "en-US",
            "rate_diesel": "0", "rate_petrol": "0", "rate_cng": "0",
        }
        for k, v in default_settings.items():
            conn.execute("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", (k, v))
        conn.commit()
    finally:
        conn.close()

def seed_db():
    """Populate demo data matching the original mockup, so the dashboard
    isn't empty on first run of a brand-new install."""
    conn = get_db()
    cur = conn.cursor()

    # --- Users ---
    users = [
        ("Admin User", "admin@example.com", "admin123", "admin", "AD"),
        ("Manager User", "manager@example.com", "mgr123", "manager", "MG"),
        ("Staff User", "staff@example.com", "staff123", "staff", "ST"),
    ]
    admin_id = None
    for name, email, pw, role, av in users:
        pid = next_personal_id(role, conn=conn)
        cur.execute(
            "INSERT INTO users (name,email,password_hash,role,avatar,personal_id) VALUES (?,?,?,?,?,?)",
            (name, email, generate_password_hash(pw), role, av, pid),
        )
        if email == "admin@example.com":
            admin_id = cur.lastrowid

    # --- Settings (demo values — a real deployment sets its own currency,
    # locale and rates from Settings → Business Info) ---
    default_settings = {
        "business_name": "Demo Fuel Station",
        "business_address": "1 Main Street, Springfield",
        "gst_no": "",
        "currency_symbol": "$",
        "currency_code": "USD",
        "locale": "en-US",
        "rate_diesel": "3.85",
        "rate_petrol": "3.65",
        "rate_cng": "2.90",
    }
    for k, v in default_settings.items():
        cur.execute("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", (k, v))

    # --- Pump (demo code: 123456) ---
    cur.execute(
        "INSERT INTO pump (id,business_name,pump_code_hash,owner_user_id) VALUES (1,?,?,?)",
        ("Demo Fuel Station", generate_password_hash("123456"), admin_id),
    )

    # --- Stock ---
    stock_rows = [
        ("diesel", 2400, "Ltr.", 3000),
        ("petrol", 4200, "Ltr.", 5000),
        ("cng", 1500, "Kg", 2000),
    ]
    for f, q, u, th in stock_rows:
        cur.execute(
            "INSERT OR REPLACE INTO stock (fuel_type,quantity,unit,low_threshold) VALUES (?,?,?,?)",
            (f, q, u, th),
        )

    # --- Tanks (20 KL horizontal cylindrical tanks for diesel & petrol) ---
    for fuel_type, diameter_m, length_m in TANK_DEFAULTS:
        cur.execute(
            "INSERT OR REPLACE INTO tanks (fuel_type,capacity_ltr,diameter_m,length_m) VALUES (?,?,?,?)",
            (fuel_type, 20000.0, diameter_m, length_m),
        )

    # --- Customers ---
    customers = [
        ("Vikram Transport", "555-0101", "42 Station Road, Springfield", "AB-1234", ""),
        ("Summit Traders", "555-0102", "18 Civil Lines Ave, Springfield", "CD-5678", ""),
        ("R.K. Construction", "555-0103", "7 Balrampur Road, Springfield", "EF-9012", "TAX-1111Z1"),
        ("Northside Roadways", "555-0104", "100 Bus Terminal Rd, Springfield", "GH-3456", ""),
        ("Amana Enterprises", "555-0105", "23 Market Street, Springfield", "IJ-7890", ""),
    ]
    customer_ids = {}
    for name, phone, addr, veh, gst in customers:
        cur.execute(
            "INSERT INTO customers (name,phone,address,vehicle_no,gst_no) VALUES (?,?,?,?,?)",
            (name, phone, addr, veh, gst),
        )
        customer_ids[name] = cur.lastrowid

    # --- Entries (spread across the last 30 days for a realistic chart) ---
    today = datetime.now().date()
    demo_entries = [
        ("Vikram Transport", 0, "diesel", 200, 3.85, 200),
        ("Summit Traders", 0, "petrol", 150, 3.65, 0),
        ("R.K. Construction", 1, "diesel", 175, 3.85, 110),
        ("Northside Roadways", 1, "diesel", 100, 3.85, 0),
        ("Amana Enterprises", 2, "petrol", 120, 3.65, 75),
        ("Vikram Transport", 3, "diesel", 180, 3.85, 240),
        ("Summit Traders", 4, "cng", 90, 2.90, 80),
        ("R.K. Construction", 5, "diesel", 210, 3.85, 200),
        ("Northside Roadways", 6, "petrol", 80, 3.65, 0),
        ("Amana Enterprises", 8, "diesel", 140, 3.85, 0),
        ("Vikram Transport", 10, "petrol", 95, 3.65, 120),
        ("Summit Traders", 12, "diesel", 160, 3.85, 0),
        ("R.K. Construction", 14, "cng", 60, 2.90, 60),
        ("Northside Roadways", 16, "diesel", 130, 3.85, 160),
        ("Amana Enterprises", 18, "petrol", 100, 3.65, 0),
        ("Vikram Transport", 20, "diesel", 150, 3.85, 0),
        ("Summit Traders", 22, "petrol", 110, 3.65, 200),
        ("R.K. Construction", 24, "diesel", 190, 3.85, 0),
        ("Northside Roadways", 26, "diesel", 105, 3.85, 120),
        ("Amana Enterprises", 28, "cng", 70, 2.90, 0),
    ]
    for name, days_ago, fuel, qty, rate, paid in demo_entries:
        amount = round(qty * rate, 2)
        paid = min(paid, amount)
        status = "paid" if paid >= amount else ("partial" if paid > 0 else "pending")
        d = (today - timedelta(days=days_ago)).isoformat()
        cur.execute(
            """INSERT INTO entries (customer_id,date,fuel_type,qty,rate,amount,paid_amount,
               vehicle_no,driver_name,remarks,status,created_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (customer_ids[name], d, fuel, qty, rate, amount, paid, "", "", "", status, admin_id),
        )
        if paid > 0:
            cur.execute(
                """INSERT INTO payments (customer_id,entry_id,amount,date,mode,remarks,created_by)
                   VALUES (?,?,?,?,?,?,?)""",
                (customer_ids[name], cur.lastrowid, paid, d, "cash", "Partial/full settlement", admin_id),
            )

    conn.commit()
    conn.close()


def log_action(user_id, user_name, action, entity, entity_id=None, details=None, ip_address=None, success=True):
    """Append-only audit trail for sensitive actions (never updated or
    deleted through the app), used to satisfy accountability/traceability
    over who changed what."""
    try:
        execute_db(
            "INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,details,ip_address,success) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (user_id, user_name, action, entity, entity_id, details, ip_address, 1 if success else 0),
        )
    except Exception:
        pass  # auditing must never block the underlying operation


def ensure_ready():
    init_db()
    fresh = is_fresh_db()
    if fresh and os.environ.get("SEED_DEMO_DATA", "").lower() in ("1", "true", "yes"):
        # Demo/dev convenience only. A real deployment starts empty and the
        # first person to open the app registers the Owner + pump code.
        seed_db()
    migrate_schema()
