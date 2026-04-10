# MioServer

Self-hosted relay server for [MioIsland](https://github.com/MioMioOS/MioIsland) (Mac) and [Code Light](https://github.com/MioMioOS/CodeLight) (iPhone).

Handles device pairing, real-time session sync via Socket.io, APNs push notifications, and Live Activity updates.

## Quick Start

```bash
git clone https://github.com/MioMioOS/MioServer.git
cd MioServer
npm install
cp .env.example .env
# Edit .env: set DATABASE_URL, MASTER_SECRET, PORT
npx prisma db push
npx tsx --env-file=.env ./sources/main.ts
```

## Production Deployment

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma migrate deploy
npx prisma generate

# Start with pm2
pm2 start "npx tsx --env-file=.env ./sources/main.ts" --name mio-server

# Nginx reverse proxy (recommended)
# See below for example config
```

### Nginx config

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

Then add TLS with `certbot --nginx -d your-domain.com`.

## APNs Push Notifications

Place your Apple `.p8` key file as `apns-key.p8` in the project root, and set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` in `.env`.

Alternatively, base64-encode the `.p8` content and set it as `APNS_KEY` in `.env`.

## Stack

- **Fastify** + **Socket.io** — HTTP API + real-time relay
- **Prisma** + **PostgreSQL** — device registry, sessions, messages
- **TypeScript** via **tsx** — no build step, runs directly

## Requirements

- Node.js 20+
- PostgreSQL 14+

## License

CC BY-NC 4.0
