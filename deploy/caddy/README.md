# Yuvomi with automatic HTTPS

This optional Docker Compose deployment runs Yuvomi behind Caddy. Caddy obtains a
Let's Encrypt certificate, redirects HTTP to HTTPS and renews the certificate
automatically. The application port is not published on the host.

If an existing reverse proxy or Cloudflare Tunnel already provides trusted HTTPS,
keep that deployment. This example is a separate installation path, not a second
Compose file to combine with `docker-compose.yml`. It does not configure your DNS,
router or firewall for you.

## Before you start

- A public hostname you control, for example `planner.example.com`.
- Its DNS A record points to your server's public IPv4 address. If you publish an
  AAAA record, IPv6 must reach this server too; remove an incorrect record.
- Incoming TCP ports 80 and 443 reach this host, including router forwarding and
  firewall rules where needed. UDP 443 is optional and enables HTTP/3.
- These host ports are free. An existing NAS proxy or another web server may
  already own them. Use that proxy instead of stopping an unrelated service.
- Docker with Compose v2, and a checkout of this repository.

With carrier-grade NAT or blocked inbound ports, use an existing HTTPS tunnel or
a proxy configured for DNS-01 validation. DNS-01 also supports internal-only
services with a real domain, without exposing the service to the internet.
The stock Caddy image in this example does not include DNS provider plugins.
Do not put a broad DNS management token into Yuvomi's `.env` for this example.

## Configure and start

Run every command below **from the repository root**, not this directory.

1. Copy `.env.example` to `.env` for a new installation and set a strong, unique
   `SESSION_SECRET`. Set `DB_ENCRYPTION_KEY` to a real private key if you want
   database encryption, or clear its placeholder for an unencrypted database.
   Keep the encryption key with your recoverable backups. Restrict `.env` to the
   account administering this installation (`chmod 600 .env` on Unix).
2. Add these two values to `.env`, using your own domain and contact address:

   ```dotenv
   YUVOMI_DOMAIN=planner.example.com
   ACME_EMAIL=you@example.com
   ```

   The domain is a hostname only: no `https://`, port or path. This deployment
   sets `BASE_URL=https://<hostname>`, `SESSION_SECURE=true` and `TRUST_PROXY=1`
   itself. Keep the domain stable: passkeys, SSO callbacks and installed PWAs
   depend on the address your household uses.
3. Validate the configuration, then start:

   ```bash
   docker compose --project-directory . --env-file .env -f deploy/caddy/compose.yaml config --quiet
   docker compose --project-directory . --env-file .env -f deploy/caddy/compose.yaml up -d
   ```

4. Open `https://planner.example.com` with your domain and create the first
   administrator. Certificate issuance may take a short time; inspect Caddy's
   logs if it does not complete. No certificate import is needed on family devices.

Use the same command prefix for `logs`, `pull`, `restart` and `down`. Do not switch
back to the root Compose file for routine updates. Existing data can be reused by
setting `DATA_DIR`, `BACKUP_DIR`, `MODULES_DIR` and the document storage paths to
their existing locations, but stop the old app container first: two instances
must never open the same database at once. Back up the database and its encryption
key before migrating an existing installation.

## Check and troubleshoot

```bash
docker compose --project-directory . --env-file .env -f deploy/caddy/compose.yaml logs --tail 100 caddy
docker compose --project-directory . --env-file .env -f deploy/caddy/compose.yaml ps
```

Check that the browser trusts the HTTPS certificate, HTTP redirects to HTTPS, and
you can sign in. If issuance fails, check DNS (including AAAA), inbound ports,
outbound internet access and system time. A private address or `.local` hostname
does not follow this public-domain certificate path.

For repeated issuance experiments, use Let's Encrypt staging first by adding
`ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` to `.env`.
Use a separate test Compose project, fresh app data and a test hostname; staging
certificates are deliberately **not trusted** by browsers. Do not enter household
credentials or bypass browser certificate warnings in that test. Remove the staging
override and use the production project for a trusted certificate.

## Persistence and backups

The `caddy_data` named volume holds ACME account keys, certificates and private
keys. Keep it across container replacement and include it in protected backups.
The `caddy_config` volume holds Caddy's saved configuration. `docker compose down`
preserves these volumes; **`down -v` deletes them**. Do not repeatedly delete the
certificate storage to retry issuance; that can consume Let's Encrypt rate limits.
Yuvomi's database backups do not include Caddy's volumes or the database encryption
key. Certificate renewal is handled by the running proxy; no cron job is needed.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/).
