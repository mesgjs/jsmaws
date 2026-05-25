# JSMAWS Deployment Guide

This guide covers deploying the JavaScript Modular Application Web Server (JSMAWS) on a Linux server. It assumes a Debian/Ubuntu-based system; adapt package names and paths for other distributions.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Installation](#installation)
3. [Directory Layout](#directory-layout)
4. [User and Privilege Setup](#user-and-privilege-setup)
5. [Configuration](#configuration)
6. [Deno Permissions](#deno-permissions)
7. [systemd Unit File](#systemd-unit-file)
8. [SSL / Let's Encrypt Integration](#ssl--lets-encrypt-integration)
9. [Log Rotation](#log-rotation)
10. [Pool Sizing Recommendations](#pool-sizing-recommendations)
11. [Upgrading JSMAWS](#upgrading-jsmaws)

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Deno | 2.0+ | Latest stable |
| OS | Linux (kernel 4.x+) | Linux (kernel 5.x+) |
| RAM | 256 MB | 1 GB+ |
| Disk | 100 MB | 1 GB+ (for logs and content) |

JSMAWS is a Deno application. No Node.js, npm, or other JavaScript runtime is required.

Check your Deno version:

```bash
deno --version
```

Install or upgrade Deno:

```bash
curl -fsSL https://deno.land/install.sh | sh
# Or via package manager:
# brew install deno  (macOS)
# winget install DenoLand.Deno  (Windows)
```

---

## Installation

Clone or copy the JSMAWS source to a stable location:

```bash
git clone https://github.com/your-org/jsmaws.git /opt/jsmaws
cd /opt/jsmaws
```

Verify the installation by running the test suite:

```bash
./deno-test
```

All tests should pass before deploying.

---

## Directory Layout

The recommended directory layout separates server code, configuration, content, and logs:

```
/opt/jsmaws/          — JSMAWS source code (read-only in production)
/etc/jsmaws/          — Configuration files (jsmaws.slid, secrets)
/var/www/html/        — Static file root (served by @static mod-app)
/var/www/apps/        — Mod-app root (JavaScript mod-app files)
/var/log/jsmaws/      — Log files
/var/lib/jsmaws/      — Persistent data (Deno KV stores, etc.)
/run/jsmaws/          — Runtime files (PID file, sockets)
```

Create the directories:

```bash
sudo mkdir -p /etc/jsmaws
sudo mkdir -p /var/www/html
sudo mkdir -p /var/www/apps
sudo mkdir -p /var/log/jsmaws
sudo mkdir -p /var/lib/jsmaws
sudo mkdir -p /run/jsmaws
```

---

## User and Privilege Setup

JSMAWS uses privilege separation: the main (operator) process runs as root (to bind ports 80 and 443), while all sub-processes that handle requests run as an unprivileged user.

### Create a dedicated service user

```bash
# Create www-data group and user (if not already present)
sudo groupadd --system --gid 33 www-data 2>/dev/null || true
sudo useradd --system --uid 33 --gid 33 --no-create-home \
    --shell /usr/sbin/nologin www-data 2>/dev/null || true
```

On Debian/Ubuntu, `www-data` (UID 33, GID 33) is typically already present.

### Set directory ownership

```bash
# Content directories: owned by www-data
sudo chown -R www-data:www-data /var/www/html
sudo chown -R www-data:www-data /var/www/apps

# Log directory: owned by www-data (sub-processes write logs)
sudo chown -R www-data:www-data /var/log/jsmaws

# Data directory: owned by www-data
sudo chown -R www-data:www-data /var/lib/jsmaws

# Config directory: owned by root, readable by root only (contains secrets)
sudo chown root:root /etc/jsmaws
sudo chmod 700 /etc/jsmaws
```

### Numeric UID/GID in configuration

JSMAWS requires **numeric** UID and GID values (symbolic names are not supported). Use `id` to look up the numeric values:

```bash
id www-data
# uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Set `uid=33` and `gid=33` in your `jsmaws.slid` configuration file.

---

## Configuration

Create `/etc/jsmaws/jsmaws.slid`:

```slid
[(
    /* ── Network ─────────────────────────────────────────────── */
    hostname=0.0.0.0
    httpPort=80
    httpsPort=443

    /* ── SSL ─────────────────────────────────────────────────── */
    certFile=/etc/letsencrypt/live/example.com/fullchain.pem
    keyFile=/etc/letsencrypt/live/example.com/privkey.pem
    sslCheckIntervalHours=1
    acmeChallengeDir=/var/www/acme-challenge

    /* ── Process Management ──────────────────────────────────── */
    uid=33
    gid=33
    shutdownDelay=30
    shutdownSpread=0.1

    /* ── Logging ─────────────────────────────────────────────── */
    logLevel=info
    logDestination=console
    logFormat=apache

    /* ── Filesystem Settings ─────────────────────────────────── */
    root=/var/www/html
    appRoot=/var/www/apps

    /* ── Process Pools ───────────────────────────────────────── */
    pools=[
        fast=[
            minProcs=2
            maxProcs=10
            maxWorkers=8
            maxReqs=1000
            reqTimeout=5
        ]
        standard=[
            minProcs=1
            maxProcs=20
            maxWorkers=4
            maxReqs=100
            reqTimeout=60
            conTimeout=300
        ]
        stream=[
            minProcs=0
            maxProcs=50
            maxWorkers=1
            maxReqs=1
            reqTimeout=0
            idleTimeout=60
            conTimeout=3600
            resType=[stream bidi]
        ]
    ]

    /* ── Routes ──────────────────────────────────────────────── */
    routes=[
        [path=/static/:*  pool=fast  app=@static  method=read]
        [path=/api/:*  pool=standard  app=./api.esm.js]
        [regex='^/.*'  response=404]
    ]
)]
```

See [`docs/configuration.md`](configuration.md) for the full configuration reference.

---

## Deno Permissions

JSMAWS requires the following Deno permission flags:

| Flag | Purpose |
|------|---------|
| `--allow-read` | Read configuration files, SSL certificates, static files, mod-apps |
| `--allow-write` | Write log files (if logging to files) |
| `--allow-net` | Bind HTTP/HTTPS ports, accept connections |
| `--allow-run` | Spawn sub-processes (responder, router, auth processes) |
| `--allow-env` | Read environment variables (for `:env:` value references) |
| `--allow-sys` | Read system info (hostname, OS info) |
| `--unstable-worker-options` | Required for mod-app worker spawning with custom permissions |

The recommended invocation:

```bash
deno run \
    --allow-read \
    --allow-write=/var/log/jsmaws \
    --allow-net \
    --allow-run \
    --allow-env \
    --allow-sys \
    --unstable-worker-options \
    /opt/jsmaws/src/operator.esm.js \
    --config /etc/jsmaws/jsmaws.slid
```

> **Security note:** For production, restrict `--allow-read` to specific directories rather than using a blanket allow:
> ```bash
> --allow-read=/etc/jsmaws,/var/www,/opt/jsmaws/src,/etc/letsencrypt
> ```

---

## systemd Unit File

Create `/etc/systemd/system/jsmaws.service`:

```ini
[Unit]
Description=JavaScript Modular Application Web Server
Documentation=https://github.com/your-org/jsmaws
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/jsmaws

# Main process command
ExecStart=/usr/local/bin/deno run \
    --allow-read=/etc/jsmaws,/var/www,/opt/jsmaws/src,/etc/letsencrypt \
    --allow-write=/var/log/jsmaws \
    --allow-net \
    --allow-run \
    --allow-env \
    --allow-sys \
    --unstable-worker-options \
    /opt/jsmaws/src/operator.esm.js \
    --config /etc/jsmaws/jsmaws.slid

# Graceful reload (re-reads configuration)
ExecReload=/bin/kill -HUP $MAINPID

# Graceful stop (allows in-flight requests to complete)
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60

# Restart policy
Restart=on-failure
RestartSec=5s

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jsmaws

# Security hardening
NoNewPrivileges=no
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable jsmaws
sudo systemctl start jsmaws
sudo systemctl status jsmaws
```

View logs:

```bash
sudo journalctl -u jsmaws -f
```

Reload configuration without restarting:

```bash
sudo systemctl reload jsmaws
# Or equivalently:
sudo kill -HUP $(systemctl show -p MainPID --value jsmaws)
```

---

## SSL / Let's Encrypt Integration

JSMAWS integrates with external ACME clients (such as certbot) for SSL certificate management. The server monitors certificate files for changes and reloads the HTTPS listener automatically.

### Initial certificate issuance

JSMAWS must be running (on port 80) before certbot can complete the HTTP-01 challenge. Use the `acmeChallengeDir` configuration key to point JSMAWS at the challenge directory:

```slid
acmeChallengeDir=/var/www/acme-challenge
```

Create the challenge directory:

```bash
sudo mkdir -p /var/www/acme-challenge
sudo chown www-data:www-data /var/www/acme-challenge
```

Issue the certificate:

```bash
sudo certbot certonly \
    --webroot \
    --webroot-path /var/www/acme-challenge \
    -d example.com \
    -d www.example.com
```

### Automatic renewal

certbot installs a systemd timer or cron job for automatic renewal. After renewal, JSMAWS detects the updated certificate files (via `sslCheckIntervalHours`) and reloads the HTTPS listener automatically — no manual intervention required.

To force an immediate reload after certificate renewal, add a post-renewal hook:

```bash
# /etc/letsencrypt/renewal-hooks/post/jsmaws-reload.sh
#!/bin/bash
systemctl reload jsmaws
```

```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/jsmaws-reload.sh
```

### Certificate expiry warnings

JSMAWS logs a warning when the certificate will expire within 30 days, and an error when it has already expired. These messages appear in the server log at startup and on each certificate reload.

---

## Log Rotation

If logging to the system journal (the default with the systemd unit above), log rotation is handled automatically by `journald`. No additional configuration is needed.

If you redirect logs to files, configure logrotate. Create `/etc/logrotate.d/jsmaws`:

```
/var/log/jsmaws/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data www-data
    sharedscripts
    postrotate
        systemctl reload jsmaws > /dev/null 2>&1 || true
    endscript
}
```

---

## Pool Sizing Recommendations

Pool sizing depends on your workload. The following are starting points; tune based on observed CPU, memory, and latency metrics.

### Small site (< 100 req/s, single server)

```slid
pools=[
    fast=[
        minProcs=1
        maxProcs=4
        maxWorkers=4
        maxReqs=500
        reqTimeout=5
    ]
    standard=[
        minProcs=1
        maxProcs=8
        maxWorkers=2
        maxReqs=100
        reqTimeout=30
        conTimeout=120
    ]
    stream=[
        minProcs=0
        maxProcs=20
        maxWorkers=1
        maxReqs=1
        reqTimeout=0
        idleTimeout=30
        conTimeout=1800
        resType=[stream bidi]
    ]
]
```

### Medium site (100–1000 req/s)

```slid
pools=[
    fast=[
        minProcs=2
        maxProcs=10
        maxWorkers=8
        maxReqs=1000
        reqTimeout=5
    ]
    standard=[
        minProcs=2
        maxProcs=20
        maxWorkers=4
        maxReqs=100
        reqTimeout=60
        conTimeout=300
    ]
    stream=[
        minProcs=0
        maxProcs=100
        maxWorkers=1
        maxReqs=1
        reqTimeout=0
        idleTimeout=60
        conTimeout=3600
        resType=[stream bidi]
    ]
]
```

### High-traffic site (> 1000 req/s)

For high-traffic deployments, consider:
- Running multiple JSMAWS instances behind a load balancer
- Increasing `maxProcs` and `maxWorkers` based on available CPU cores
- Using "on-demand" scaling (`minProcs=0`) for infrequently-used pools to conserve memory
- Monitoring process recycling frequency (`maxReqs`) and adjusting to balance memory usage vs. spawn overhead

**General guidelines:**
- `maxWorkers` should not exceed the number of CPU cores available to the process
- `maxReqs` controls memory leak mitigation via process recycling; lower values = more frequent recycling = higher spawn overhead
- `stream` pool processes handle one connection each (`maxReqs=1`, `maxWorkers=1`); size `maxProcs` based on expected concurrent WebSocket/SSE connections

---

## Upgrading JSMAWS

1. **Pull the new version:**
   ```bash
   cd /opt/jsmaws
   git pull
   ```

2. **Run the test suite:**
   ```bash
   ./deno-test
   ```

3. **Review the changelog** for any configuration changes or breaking changes.

4. **Reload or restart the service:**
   - For configuration-compatible upgrades: `sudo systemctl reload jsmaws`
   - For upgrades requiring a full restart: `sudo systemctl restart jsmaws`

   A reload sends SIGHUP to the operator process, which re-reads the configuration file. A restart stops and starts the service, briefly interrupting all connections.

5. **Verify the service is running:**
   ```bash
   sudo systemctl status jsmaws
   sudo journalctl -u jsmaws -n 50
   ```

---

## See Also

- [`docs/configuration.md`](configuration.md) — Full configuration reference
- [`docs/mod-app-development.md`](mod-app-development.md) — Writing mod-apps for JSMAWS
- [`examples/`](../examples/) — Example mod-apps and configuration
- [`arch/pool-configuration-design.md`](../arch/pool-configuration-design.md) — Pool configuration design
