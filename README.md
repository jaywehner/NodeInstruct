# Node Instruct

Node Instruct is a lightweight, self-hosted flow editor for building node-based instruction/decision flows with rich text and media nodes.

## Features

- **Flow editor UI**
  - Drag/move nodes on a canvas
  - Connect nodes by dragging from output ports to another node’s input port
  - Multiple outputs per node (up to 6), with labels and color
  - Zoom controls
- **Node types**
  - Start / End
  - Text (sanitized rich text)
  - Image, File, Video, Audio uploads (with optional caption above media)
- **Public sharing**
  - Mark a flow as public
  - Copy a share link for read-only viewing
- **Users & roles**
  - Admin, Editor, View Only
  - Admin UI for user management and settings

## Tech stack

- Node.js + Express
- SQLite (better-sqlite3)
- MySQL / MariaDB (mysql2)
- jQuery + jQuery UI
- Multer (uploads)

## Getting started

### Prerequisites

- Node.js 18+ recommended

### Install

```bash
npm install
```

### Run

```bash
npm start
```

Then open:

- `http://localhost:3000`

## Run with Docker

### Build the image

```bash
docker build -t nodeinstruct .
```

### Run the container

```bash
docker run -d \
  --name nodeinstruct \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e SESSION_SECRET=replace-with-a-long-random-secret \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=replace-this-temporary-password \
  -v nodeinstruct_data:/app/data \
  -v nodeinstruct_storage:/app/storage \
  nodeinstruct
```

Then open:

- `http://localhost:3000`

### Docker notes

- The container listens on port `3000`.
- Persist `/app/data` and `/app/storage` with Docker volumes or bind mounts.
- `SESSION_SECRET` should always be set to a strong random value in Docker deployments.
- SQLite is the default backend when the app starts in Docker.

## Run with Docker Compose

This repository includes a `docker-compose.yml` with:

- `app`
  - the NodeInstruct web application
- `mariadb`
  - an optional MariaDB service behind the `external-db` profile

### Start the app with SQLite

```bash
docker compose up -d --build
```

This starts NodeInstruct with persisted Docker volumes for:

- `/app/data`
- `/app/storage`

### Start the optional MariaDB service too

```bash
docker compose --profile external-db up -d --build
```

This starts:

- NodeInstruct
- MariaDB

NodeInstruct will still start on SQLite by default. If you want to switch to MariaDB, open `/admin` and use the database migration tools after the app is running.

### Compose configuration

Before using `docker compose` in production, update the values in `docker-compose.yml` for:

- `SESSION_SECRET`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `MARIADB_PASSWORD`
- `MARIADB_ROOT_PASSWORD`

### Stop the compose stack

```bash
docker compose down
```

### Remove the compose stack and volumes

```bash
docker compose down -v
```

Only use `-v` if you intentionally want to delete persisted SQLite/MariaDB data and uploaded files.

## Bootstrap admin login

On first run, if no users exist, the server creates a bootstrap admin account.

- Default username: `admin`
- Temporary password:
  - Uses `BOOTSTRAP_ADMIN_PASSWORD` if provided
  - Otherwise a secure random password is generated and printed to the server console

The bootstrap admin is forced to change the password after first login.

## Configuration (environment variables)

- `PO
  - Default: `3000`
- `NODE_ENV`
  - Set to `production` in production deployments
- `SESSION_SECRET`
  - **Required in production**
  - Used to sign session cookies
- `ALLOW_SELF_REGISTER`
  - Default: disabled
  - Set to `true` / `1` / `yes` to allow open self-registration
- `BOOTSTRAP_ADMIN_USERNAME`
  - Default: `admin`
- `BOOTSTRAP_ADMIN_PASSWORD`
  - Optional bootstrap admin password for first run

These environment variables can be supplied directly with `docker run` or through `docker-compose.yml`.

## Data & storage

This app stores data on disk in:

- `data/nodeinstruct.sqlite` (initial database before optional migration)
- `data/database-config.json` (database backend configuration after external DB migration)
- `storage/<username>/...` (uploaded files)

The active database stores:

- persistent sessions
- persistent rate-limit counters

## Database backends and migration

Node Instruct starts on SQLite by default.

From the admin page you can migrate the app to:

- `MySQL`
- `MariaDB`

### Before you migrate

1. Create an empty MySQL or MariaDB database.
2. Create a dedicated database user with only the permissions needed for that database.
3. Open `/admin` as an admin user.
4. In the **Database Backend** section:
   - choose `MySQL` or `MariaDB`
   - enter host, port, username, and database name
   - enter the database password
5. Click **Test Connection** and confirm it succeeds.
6. Click **Migrate to MySQL/MariaDB**.

### What migration moves

- users
- flows
- uploads metadata
- settings
- sessions
- rate limit counters

Uploaded files remain on disk under `storage/<username>/...`.

In Docker deployments, the corresponding container paths are:

- `/app/data`
- `/app/storage`

### Important migration rule

Migration is intentionally **one-way**.

After Node Instruct switches to MySQL/MariaDB:

- the instance is locked to the external database backend
- the admin UI disables reverting to SQLite
- the runtime rejects switching back to SQLite

### Password handling in the admin UI

- The saved database password is **never returned to the browser**.
- After a password has been stored server-side, the admin UI shows a **Keep existing saved password** option.
- If you leave that option enabled, test and migration requests reuse the server-side password without exposing it in the page.
- If you type a new password, the new value is used for that request instead.

## Upload policy

Uploads are validated by file extension.

Allowed extensions:

- Documents:
  - `.pdf`, `.doc`, `.docx`, `.docm`, `.dotx`, `.rtf`
  - `.xls`, `.xlsx`, `.xlsm`, `.xltx`
  - `.ppt`, `.pptx`
  - `.csv`, `.txt`, `.xml`, `.json`
  - `.zip`
  - `.pub`
  - `.crt`, `.csr`
- Images:
  - `.png`, `.jpg`, `.jpeg`, `.gif`, `.tiff`
- Audio:
  - `.mp3`, `.wav`, `.ogg`, `.flac`
- Video:
  - `.mp4`, `.mpeg`, `.avi`, `.webm`, `.wmv`, `.ogg`, `.mov`, `.m4v`

## Security notes

- **Sessions**
  - Cookie is `httpOnly` and `sameSite=lax`.
  - In `production`, cookies are marked `secure`.
  - Sessions are stored in the active database so they survive server restarts.
- **CSRF protection**
  - Mutating `/api/*` requests require an `X-CSRF-Token` header.
  - The frontend sets this automatically via `public/js/common.js`.
- **Registration**
  - Self-registration is disabled by default.
  - `ALLOW_SELF_REGISTER` sets the initial default.
  - Admins can change the live setting later from `/admin`.
- **Uploads**
  - Uploaded files are no longer exposed by an unauthenticated static file route.
  - Logged-in users can access their own uploads.
  - Admins can access all uploads.
  - Public flow viewers can only access files referenced by that public flow.
- **Text sanitization**
  - Text node HTML is sanitized server-side before saving.
- **External database credentials**
  - Database passwords are not sent back to the admin page after they are saved.
  - The migration config is stored on disk in `data/database-config.json`; secure the `data` directory with OS-level permissions and backups.
  - The server attempts to restrict the config file permissions when writing it.
  - Use a dedicated MySQL/MariaDB account with the minimum required privileges.
  - Prefer private network access, strong passwords, and TLS between the app server and the database when available.
- **Production deployment**
  - Set a strong `SESSION_SECRET`.
  - Do not expose your MySQL/MariaDB server directly to the public internet unless it is intentionally hardened.
  - Back up both the external database and the `storage` directory.

## Common tasks

### Create a public flow link

1. Open a flow in the editor.
2. Check **Public**.
3. Click **Copy Link**.

### Admin settings

- Visit `/admin` (admin role required)
- Set max upload size (MB)
- Enable or disable self-registration
- Test MySQL/MariaDB connectivity before migration
- Migrate from SQLite to MySQL/MariaDB once

### Browse public flows

- Visit `/public-flows`
- Filter by owner or flow name
- Use the pagination controls to move through results

## Troubleshooting

- If you set `NODE_ENV=production` you must also set `SESSION_SECRET`, or the server will refuse to start.
- On first run without `BOOTSTRAP_ADMIN_PASSWORD`, check the server console for the generated temporary admin password.
- If an upload fails, confirm the file extension is on the allowed list and that the max upload size allows it.
- If database connection testing fails, verify the host, port, user credentials, database name, firewall rules, and database server bind settings.
- If external DB migration fails because the target is not empty, create a fresh empty database and retry.

## License

Private/internal project (no license specified).
