# Security Policy

## Supported Versions

We release patches and security fixes for the latest version on the `main` branch.

| Version | Supported |
| ------- | --------- |
| Latest (`main`) | Yes |
| Older releases | Best effort / Please upgrade |

## Reporting a Vulnerability

If you discover a security vulnerability in **openCalory**, please **do not** open a public issue.

Instead, report it responsibly via:
- [GitHub Private Vulnerability Reporting](https://github.com/NathanP278/openCalory/security/advisories/new)
- Or contact the maintainers directly through the email provided in the repository profile.

Please include:
- A description of the vulnerability and its potential impact
- Detailed steps to reproduce or a minimal proof of concept
- Any potential remediations or pull requests if available

We will acknowledge receipt promptly, assess the issue, and provide an estimated timeline for a fix.

## Self-Hosting Security Recommendations

When self-hosting openCalory on a public server:
1. **Always set `SYNC_ACCESS_KEY`:** Protects synchronization and AI proxy endpoints behind signed session cookies or Bearer authentication.
2. **Use HTTPS:** Web camera access (for barcode scanning) and service workers require a secure origin (HTTPS or `localhost`). Place production deployments behind a reverse proxy with TLS (such as Caddy, Nginx, or Cloudflare).
3. **Keep secrets on the server:** Never commit `.env` or `.env.local` files containing `AI_API_KEY`, `TURSO_AUTH_TOKEN`, or other credentials.
