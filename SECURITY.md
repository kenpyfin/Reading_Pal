# Security Assessment: Scanner Activity (Log Review)

## Summary

Logs from **2026-02-18** show **automated reconnaissance/vulnerability scanning** against your frontend and backend. The requests appear from IP **192.168.240.1** in the frontend/backend logs; that IP is **not** your LAN (e.g. 10.0.1.\*). See [Where does 192.168.240.1 come from?](#where-does-1921682401-come-from) below. The pattern is typical of bots probing for exposed config files, env files, and common CMS/plugin paths.

## What the scanner did

- **Frontend (port 3100):** Hundreds of GET requests for sensitive paths, including:
  - `.env` and variants (`.env.local`, `.env.prod`, `.env.example`, etc.)
  - Paths like `/backend/.env`, `/config/.env`, `/api/.env`
  - `.git/config`, `.git/HEAD`, `.git/logs/HEAD`
  - `config.json`, `config.yml`, `secrets.json`, `credentials.json`, `docker-compose.yml`
  - `wp-config.php`, `configuration.php`, `database.yml`, `.ssh/id_rsa`, `.aws/credentials`
  - Many random `.php` paths (e.g. `tfm.php`, `666.php`) often associated with webshells/WordPress
- **Backend:** One request to `GET /api/.env` → **404 Not Found** (correct behavior).

## Why the frontend returns 200 for “everything”

The frontend is served with **`serve -s build`** (SPA mode). In SPA mode, any path that does not match a file in `build/` is served **index.html** with status **200**. So:

- Requests to `/.env`, `/.git/config`, `/config.json`, etc. do **not** serve real files from disk.
- They receive the React app’s **index.html** (and then the JS bundle), so **no env or config content is actually leaked** by the current setup.

Returning 200 for paths like `/.env` or `/.git/config` is still undesirable because:

1. It signals “something exists here” to scanners and can encourage further probing.
2. If a sensitive file (e.g. `.env`) were ever added under `frontend/public/` or otherwise ended up in `build/`, it could be served without any extra configuration.

## Where does 192.168.240.1 come from?

Your LAN is **10.0.1.\***. The **192.168.240.1** you see in the logs is **not** the real client; it is the **immediate TCP client** of the frontend container, i.e. the next hop that forwards traffic to it.

Typical setup:

1. **Reverse proxy (SWAG)** — Your `nginx/readingpal.subdomain.conf` proxies to `10.0.1.22` (backend, frontend, image server). So traffic flow is: **real client → SWAG → 10.0.1.22:3100 (frontend)**.
2. **Docker port mapping** — The host (10.0.1.22) receives the connection from SWAG and forwards it into the frontend container. The frontend container only sees the connection as coming from the **host’s IP on the Docker network** (the bridge gateway). Docker often uses a **192.168.x.0/24** subnet for a compose/bridge network; **.1** is usually the gateway (the host). So **192.168.240.1** is almost certainly **your host (10.0.1.22)** as seen from inside Docker — i.e. “who connected to this container” = the host that did the port forward. If SWAG runs on the same host, it’s the same machine; if SWAG is on another box, 192.168.240.1 is still the host that runs the reading_pal stack.

So the **scanner** is whoever is sending requests **to** your frontend (via SWAG or directly to 10.0.1.22:3100): that could be a bot on the internet (if readingpal.kenpyfin.com is public), another device on 10.0.1.\*, or something else. To see the **real client IP**, check **SWAG/nginx access logs** and use **X-Forwarded-For** (or nginx’s `$remote_addr` before proxying); that’s where the original client IP is recorded.

## Findings

| Item | Status |
|------|--------|
| Backend `/api/.env` | ✅ Returns 404 |
| Sensitive files in frontend build | ✅ None identified; CRA only bundles `public/` and build output |
| `.dockerignore` for frontend | ⚠️ Was missing; added to exclude `.env`, `.git`, and similar |
| SPA fallback 200 for bad paths | ⚠️ Informational; consider nginx with explicit 404 for non-asset paths in production |

## Recommendations

1. **Keep using `.dockerignore` in `frontend/`**  
   Ensures `.env`, `.env.*`, `.git`, and other sensitive or unnecessary files are never sent to the Docker build context or end up in the image.

2. **Harden production serving (optional)**  
   For production, consider serving the frontend with **nginx** (or similar) and:
   - Serve only known static assets (e.g. `/static/*`, `index.html`, `favicon.ico`).
   - Return **404** (or **403**) for paths like `/.env`, `/.git`, `*.php`, and other sensitive patterns, instead of falling back to `index.html`.

3. **Network / operational**  
   - **192.168.240.1** is the Docker-side view of your host (or the proxy’s next hop), not the real client. Use SWAG/nginx logs and `X-Forwarded-For` to identify the actual client IP if you need to block or rate-limit.
   - Ensure the root `.env` (and any secrets) are only on the host/backend and **never** committed or copied into `frontend/public/` or the frontend image.

4. **Monitoring**  
   - Consider alerting or logging when many 404s or suspicious paths (e.g. `/.env`, `/.git`, `*.php`) are requested in a short time from the same IP.

## Conclusion

No evidence that secrets or config files were actually served. The backend correctly returns 404 for `/api/.env`. The main improvements are: (1) adding `frontend/.dockerignore` to avoid leaking secrets via the build context, and (2) optionally hardening production with nginx and explicit 404s for sensitive paths.
