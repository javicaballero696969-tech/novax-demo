# NovaX Render-ready prototype

This is a simulation-only crypto exchange prototype.

Files to upload to GitHub:
- package.json
- server.js
- render.yaml
- public/index.html

Render settings:
- Service type: Web Service
- Runtime: Node
- Build command: npm install
- Start command: npm start
- Health check: /api/health

Do not use this prototype for real funds, real cryptocurrency custody, or production authentication.

Note: SQLite data on a free/ephemeral deployment may not survive service replacement/restart. For production, use a managed PostgreSQL database and proper secrets/custody/security controls.
