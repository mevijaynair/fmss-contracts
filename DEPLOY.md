# Deploying FMSS Contracts → contracts.fmss.ae

This app slots into the existing **fmss.ae** architecture (see `../SAMS/DEPLOY.md`
and `../SAMS/Caddyfile`): a single Linux VPS running **Caddy** (auto-HTTPS) that
reverse-proxies several Node apps, each a **systemd** service with its SQLite DB on
the persistent `/data` directory.

- **Address:** `contracts.fmss.ae`
- **Port:** `3002` (Caddy → `localhost:3002`; the proxy block already exists in `SAMS/Caddyfile`)
- **DB:** `/data/fmss.db` (migrated from your local copy — see Step 4)
- **Repo:** https://github.com/mevijaynair/fmss-contracts

No app code changes are needed: `PORT` and `FMSS_DB_PATH` are read from the
environment and `/api/health` already exists.

---

## Step 0 — Is the server already set up? (you said "not sure")

SSH in and check. The result tells you which path to follow:

```bash
ssh root@<your-server-ip>

systemctl status caddy        # is Caddy installed & running?
ls /opt/sams 2>/dev/null      # is SAMS already deployed here?
node --version                # v24+ expected
dig +short contracts.fmss.ae  # does DNS already point at this box?
```

- **Caddy is running and /opt/sams exists →** the box is already provisioned.
  Skip to **Step 2** (you only need to add this one app).
- **Caddy/Node missing →** the box is fresh. Do **Step 1** first.

---

## Step 1 — (Fresh server only) base setup

Follow **Steps 1 of `../SAMS/DEPLOY.md`** ("Prepare the Server") to install Node 24
and Caddy and create `/data`. Then continue below. (If you want SAMS too, do its
full guide; for this app alone, just the Node + Caddy + `/data` parts are required.)

---

## Step 2 — Create the app user & clone

`better-sqlite3` is a native module. If no prebuilt binary matches the server's
Node version, npm compiles it with node-gyp, which needs a C toolchain. Without
it the install dies with `gyp ERR! stack Error: not found: make` — and because
`npm ci` **deletes `node_modules` before installing**, a failure here leaves the
app with no dependencies at all. Install the toolchain first:

```bash
# as root
apt-get update && apt-get install -y build-essential python3

useradd -m -s /bin/bash fmss 2>/dev/null || true
mkdir -p /opt/fmss-contracts /data
chown fmss:fmss /opt/fmss-contracts /data
chmod 750 /data

su - fmss
git clone https://github.com/mevijaynair/fmss-contracts.git /opt/fmss-contracts
cd /opt/fmss-contracts
npm ci --omit=dev
```

---

## Step 3 — Configure the environment

```bash
cd /opt/fmss-contracts
cp .env.example .env
nano .env        # Set three variables:
                 # PORT=3002
                 # FMSS_DB_PATH=/data/fmss.db
                 # FMSS_AUTH_PASSWORD=<your-strong-password>
```

**Important:** This app is **view-only and password-protected**. No edits, adds, or deletes
are possible — only you can log in and view the data. Set a strong password you'll remember.

---

## Step 4 — Migrate your current data up

Your real data lives in your local `data/fmss.db`. Copy it to the server's
persistent path. **Stop the local server first** so SQLite checkpoints its
write-ahead log into the single `.db` file (otherwise recent changes sit in a
`-wal` sidecar).

On your **local machine** (PowerShell, from `H:\Football_ai\FMSS`):

```powershell
# 1. Stop the local server (free port 3100) so the DB is checkpointed & quiescent
Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 2. Copy the DB file up (scp ships with Windows OpenSSH)
scp data\fmss.db root@<your-server-ip>:/data/fmss.db
```

Back on the **server**, set ownership so the service can read/write it:

```bash
chown fmss:fmss /data/fmss.db
chmod 640 /data/fmss.db
# (If a stale -wal/-shm got copied, remove them; a clean shutdown won't leave any)
rm -f /data/fmss.db-wal /data/fmss.db-shm 2>/dev/null || true
```

> On first start the app runs idempotent migrations and re-applies the cashier role
> (Vijay). Because the DB already has data, the seeder is skipped — your imported
> history and balances are preserved as-is.

---

## Step 5 — Install the systemd service

```bash
# as root
cp /opt/fmss-contracts/fmss-contracts.service /etc/systemd/system/fmss-contracts.service
systemctl daemon-reload
systemctl enable --now fmss-contracts
systemctl status fmss-contracts          # should be active (running)
journalctl -u fmss-contracts -n 30 --no-pager   # look for "FMSS running → http://localhost:3002"

# Local smoke test (before DNS/HTTPS):
curl -s http://localhost:3002/api/health   # -> {"ok":true}
```

---

## Step 6 — Caddy (HTTPS reverse proxy)

The `contracts.fmss.ae` block already exists in `SAMS/Caddyfile` (→ `localhost:3002`).

- **If you deploy SAMS's Caddyfile as-is**, no change is needed — just reload Caddy.
- **If this app is the only thing on the box**, add this block to `/etc/caddy/Caddyfile`:

```caddy
contracts.fmss.ae {
  reverse_proxy localhost:3002
  encode gzip
  header / {
    -Server
    Strict-Transport-Security max-age=31536000
    X-Content-Type-Options nosniff
    X-Frame-Options SAMEORIGIN
  }
}
```

Then:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

---

## Step 7 — DNS

At your `fmss.ae` registrar add an A record (the wildcard `*.fmss.ae → fmss.ae`
from the SAMS plan also covers this, in which case you can skip this):

```
Type  Name        Value
A     contracts   <your-server-ip>
```

Verify, then open the site:

```bash
dig +short contracts.fmss.ae     # -> <your-server-ip>
```
→ https://contracts.fmss.ae (Caddy issues the TLS cert automatically)

**Test the login:**
- You should see a password-protected login page
- Enter the `FMSS_AUTH_PASSWORD` from your `.env`
- You should see the dashboard with your imported data (players, games, balances)
- All view-only — no edit/add/delete buttons are visible

---

## Updating after future changes

```bash
su - fmss
cd /opt/fmss-contracts
git status -sb          # confirm you are on main, not a feature branch
git pull
npm ci --omit=dev
exit
systemctl restart fmss-contracts
```

Then confirm it actually came back up:

```bash
systemctl status fmss-contracts --no-pager
curl -fsS localhost:3002/api/health && echo
```

**If `git pull` says "Already up to date" but you expected changes**, the work is
almost certainly still on an unmerged branch — a `git pull` on `main` fetches the
branch ref but does not move `main`. Merge the PR first, then pull again.

**If `npm ci` fails on `better-sqlite3`** (`Error: not found: make`), the build
toolchain is missing. `npm ci` has already emptied `node_modules` at that point,
so the service will not start until you finish the install:

```bash
apt-get update && apt-get install -y build-essential python3
```

Then re-run the `npm ci --omit=dev` and restart above.

> **Note on paths.** This guide assumes the documented layout: the repo cloned to
> `/opt/fmss-contracts`, owned by the `fmss` user. At least one server was set up
> with the repo at `/root/fmss-contracts` running as `root` instead. Check with
> `systemctl cat fmss-contracts | grep -E 'WorkingDirectory|User'` and use whatever
> path that reports.

---

## Backups

The whole app state is one file: `/data/fmss.db`. Schedule a daily copy
(`crontab -e` as root):

```bash
0 2 * * * sqlite3 /data/fmss.db ".backup '/backups/fmss-$(date +\%F).db'"
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u fmss-contracts -n 50` — usually a bad `.env` or DB perms |
| `SQLITE_CANTOPEN` / read-only | `/data` owned by `fmss`? `ReadWritePaths=/data` in the unit? `FMSS_DB_PATH=/data/fmss.db`? |
| 502 from Caddy | App not listening on 3002 — `curl localhost:3002/api/health` |
| Cert error | `systemctl reload caddy`; confirm DNS resolves to this box |
| Data looks empty | The migrated `fmss.db` didn't land at `/data/fmss.db`, or a `-wal` sidecar was lost — re-copy after a clean local shutdown |
