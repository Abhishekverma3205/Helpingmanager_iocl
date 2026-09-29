# Fuel Station Manager

A full single-station operations system for a fuel dealer: customer credit
("udhari") management, owner/manager/staff security, staff HR & attendance,
and daily sales/testing/tank-dip logging. Flask + SQLite backend, vanilla
JS/HTML/CSS frontend, deploy-ready.

**Global by default** — currency symbol, currency code, and number/date
formatting are all configured per deployment from Settings, not hardcoded.
Point it at any market by setting your own business name, currency, and
locale the first time you log in.

## What's in it

**Udhari / credit management** (original feature set, unchanged)
- Dashboard, Udhari Records, Dealers/Customers, Customer Ledger, Payments, Reports
- Excel/CSV export, Excel bulk upload, Stock management, Fuel rates/settings

**Single-station security & authentication**
- One station per deployment, identified by a 6-digit **Pump Code stored as
  a hash** (never plaintext)
- **Owner registration — once only.** The first person to open a freshly
  deployed instance registers the station (business name + pump code) and
  becomes the one Owner. Every Owner and Manager gets a unique **Personal
  ID** (`OWN-0001`, `MGR-0001`, ...).
- **Manager registration** uses the same pump code — a Manager can never
  create another station or register another Owner; that endpoint only ever
  creates Manager accounts.
- **Staff** are created by the Owner or a Manager from inside the app (not by
  public self-registration) and get their own Personal ID (`STF-0001`, ...).
- Passwords hashed with Werkzeug's `scrypt`-based hasher; the pump code is
  hashed the same way.
- **CSRF protection** on every authenticated state-changing request
  (`X-CSRF-Token` header checked against a per-session token).
- `HttpOnly` + `SameSite=Lax` session cookies, `Secure` cookies automatically
  enabled when `FLASK_ENV=production`.
- Login lockout after 5 failed attempts (15-minute cooldown), applied to both
  normal logins and pump-code guesses on Manager registration.
- **Registration/login/logout audit logging** — every sensitive action is
  recorded with actor, IP, timestamp, and outcome. The **Owner** can view the
  full **Audit Log** from the sidebar.
- The **Full Data Export** (Owner-only) and the daily report export never
  include password hashes or the pump-code hash — those columns are never
  selected into any export query in the first place.

**Regional / localization settings** (Settings → Business Info)
- **Currency symbol** and **currency code** — shown throughout the app
  wherever an amount is displayed; defaults to `$` / `USD` but can be set to
  anything (`₹`, `€`, `£`, `R$`, ...).
- **Locale** — a dropdown of common number/date formats (US, UK, India,
  Germany, France, Spain, Brazil, UAE) controlling thousands separators,
  decimal points, and date rendering everywhere in the UI.
- **Time zone** — set via the `TZ` environment variable on the host/container
  (see Deployment below) so "today" and shift timestamps line up with the
  station's local clock rather than the server's default.
- **Tax / VAT Number** field (stored internally as `gst_no` for backward
  compatibility with earlier installs) — labeled generically so it fits GST,
  VAT, sales-tax IDs, or any other jurisdiction's tax registration number.

**Fuel station staff management**
- Personal ID, Employee Code, Phone, Designation, Joining Date, Shift,
  Emergency Contact, Address, Notes
- Activate/deactivate staff; reset a staff password (a temporary password is
  generated and shown once — it is never stored or logged in plaintext)

**Staff attendance**
- Present / Absent / Half Day / Leave / Off, with Check-in, Check-out, Shift, Remarks
- Date-wise marking screen + a monthly summary view per staff

**Daily Sales & Testing**
- **Fuel Receipts** (stock inward): quantity, invoice no., supplier —
  automatically adds to the live stock total
- **Daily Fuel Testing** (density check): testing quantity, density,
  temperature, water check, appearance, Pass/Fail/Hold result, sample number,
  tested-by, remarks
- **20 KL Tank Dip**: enter a dip in mm for Diesel or Petrol and the app
  computes the observed litres using the real horizontal-cylinder segment
  formula for a 20,000-litre tank (2 m diameter), capped at capacity, with a
  live preview as you type. Tank dimensions are stored per fuel type in the
  `tanks` table if your station's tanks differ from the 20 KL default.
- **Daily Sales**: Opening Stock, Receipts, Sales, Rate, Sales Amount,
  Testing, and the computed **Book Closing = Opening + Receipts − Sales −
  Testing**, plus a Physical Dip reading and the resulting Variance. A
  "Prefill Suggestions" button pulls the previous day's closing, the shift's
  logged receipts/testing, and the latest dip reading.
- **Daily Report export**: one Excel workbook per date with four separate
  sheets — Daily Sales, Daily Testing, Tank Dips, Fuel Receipts.
- **Full Data Export** (Owner only): one workbook covering Customers, Udhari
  Entries, Payments, Staff, Attendance, Daily Sales, Daily Testing, Tank
  Dips, and Fuel Receipts.

## Roles at a glance

| Role (stored as) | Shown as | Can do |
|---|---|---|
| `admin` | **Owner** | Everything: Users & Roles, Audit Log, pump code reset, full export, all of the below |
| `manager` | **Manager** | Everything except Owner/Manager account management, Audit Log, pump code changes, and full export |
| `staff` | **Staff** | View/add udhari entries & customers, record payments, log fuel receipts/testing/dip readings; no edit/delete, no Reports/Upload/Settings/Staff/Attendance |

Existing accounts from before this security model keep their role and keep
logging in exactly as before — nothing about legacy accounts changes except
the display label.

## Setup (local)

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # then edit .env for your local settings
python app.py
```

Open **http://localhost:5000**.

- **Brand-new install**: the app shows a "Register your Station" screen.
  Fill in the business name, choose a 6-digit pump code, and create the
  Owner account — you're logged in immediately. Then set your currency and
  locale from **Settings → Business Info**.
- **Migrating from an earlier IOCL-branded install**: your existing data —
  customers, udhari entries, payments, and any `@iocl.com` demo accounts —
  is untouched and keeps working. Point `DATABASE_PATH` at your existing
  `iocl.db` file (see below) to keep using it under the new codebase, and
  set your currency/locale once from Settings — legacy installs default to
  `$` / `USD` / `en-US` until you change them.

To seed a fresh install with demo data instead of the empty registration
flow (useful for local exploration), set `SEED_DEMO_DATA=true` before first
run — this creates demo accounts (`admin@example.com` / `admin123`, pump
code `123456`) and sample customers.

## Deployment

The app is production-ready behind a real WSGI server. Copy `.env.example`
to `.env` (locally) or set these as real environment variables on your
host/PaaS — see the comments in `.env.example` for what each one does:

```bash
export SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
export FLASK_ENV=production
export DATABASE_PATH=/path/to/persistent/dealer.db   # optional, for platforms with a persistent disk
export TZ=America/Chicago                             # optional, set to the station's local time zone
gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 60
```

In production:
- `SECRET_KEY` is **required** (the app refuses to start without it) —
  session cookies and CSRF tokens are signed/derived from it.
- Cookies are marked `Secure` automatically, so the app must be served over
  HTTPS.
- `DATABASE_PATH` lets you point SQLite at a persistent volume; otherwise it
  defaults to `instance/dealer.db` next to the code, which is fine for a
  single-instance deployment with a persistent disk but will not survive an
  ephemeral filesystem. The directory is created automatically if missing.
- `TZ` controls what the server considers "today" and how shift timestamps
  are recorded — set it to the station's own IANA time zone name (e.g.
  `Europe/London`, `Asia/Kolkata`) rather than leaving it at the host's
  default (usually UTC on most cloud platforms).
- Put the app behind a reverse proxy that terminates TLS; `ProxyFix` is
  already wired in so `X-Forwarded-*` headers are trusted for one hop.
- `GET /healthz` returns `{"status": "ok"}` with a `200` once the app can
  reach its database — point your load balancer's/platform's health check
  at this path.

### Option A — PaaS (Render / Railway / Heroku-style)

A `Procfile` is included:

```
web: gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 60
```

Set `SECRET_KEY`, `FLASK_ENV=production`, and (if the platform offers a
persistent disk) `DATABASE_PATH` in the platform's dashboard, then deploy
from your Git repository as usual.

### Option B — Docker / any container host

A `Dockerfile` is included and builds a slim, non-root production image with
gunicorn and a built-in `HEALTHCHECK`:

```bash
docker build -t fuel-station-manager .
docker run -d -p 8000:8000 \
  -e SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_hex(32))") \
  -e FLASK_ENV=production \
  -e TZ=Europe/London \
  -v fsm-data:/data -e DATABASE_PATH=/data/dealer.db \
  fuel-station-manager
```

The named volume (`fsm-data` above) is what makes the SQLite file survive
container restarts/redeploys — without it, data is lost whenever the
container is recreated.

## Project structure

```
fuel_station_manager/
├── app.py                  # Flask app + all API routes (auth, pump, staff,
│                            #   attendance, daily ops, udhari, reports, exports)
├── database.py              # SQLite schema, migrations, demo seed data, audit logging
├── requirements.txt
├── Procfile                  # gunicorn entrypoint for PaaS deployment
├── Dockerfile                 # production container image
├── .dockerignore
├── .gitignore
├── .env.example                # documents every environment variable the app reads
├── templates/
│   └── index.html            # Single-page app shell (all screens incl. registration)
├── static/
│   ├── css/style.css
│   └── js/app.js              # All frontend logic (fetch calls, rendering, modals)
└── instance/
    └── dealer.db               # created/migrated automatically on first run
```

## Data model notes

- An **entry** (udhari record) has `amount = qty × rate`, tracks
  `paid_amount`, and derives its status (`pending` / `partial` / `paid`)
  automatically.
- A **payment** without a specific entry auto-allocates across that
  customer's oldest outstanding entries first (FIFO).
- The **tank dip formula** treats each 20 KL tank as a horizontal cylinder
  (2 m diameter, ~6.37 m length) and computes the wetted circular-segment
  volume for a given dip height — the same math used for real dip charts.
  Adjust the `tanks` table if your station's tanks use a different capacity
  or diameter.
- **Book Closing = Opening Stock + Receipts − Sales − Testing**; saving a
  Daily Sales entry also syncs the dashboard's live stock total for that
  fuel.
- Deleting a customer, fuel receipt, or entry reverses any stock adjustment
  it made. Staff with attendance history can't be deleted — deactivate them
  instead.
- Currency and locale live in the `settings` table (`currency_symbol`,
  `currency_code`, `locale`) and are read by the frontend on every login;
  changing them in Settings updates every amount/date shown in the app
  immediately, without a page reload.

## Migrating an existing database safely

`database.py`'s `migrate_schema()` runs on every startup and only ever
*adds* columns and tables (`ALTER TABLE ... ADD COLUMN`, `CREATE TABLE IF
NOT EXISTS`) — it never drops or rewrites existing data. Personal IDs are
backfilled for any account that predates them, and a pending (unset) pump
record is bootstrapped around the first `admin`-role account it finds, so
an upgrade never fails and never loses a single customer, entry, or
payment. Currency/locale settings are inserted with sane defaults
(`$` / `USD` / `en-US`) if they don't already exist, so upgrading an older
database is safe and non-destructive.
