# Wedora — Server

REST API for **Wedora**, a wedding planning platform where customers discover wedding services and request bookings, vendors publish services and manage requests, and admins moderate the platform.

> Status: project foundation. Features, the full endpoint list, live links and deployment notes are added as they are built.

## Technology Stack

| Area       | Choice                         |
| ---------- | ------------------------------ |
| Runtime    | Node.js 24, TypeScript (ESM)   |
| Framework  | Express 5                      |
| Validation | Zod                            |
| Security   | Helmet, strict CORS            |
| Testing    | Vitest, Supertest              |
| Hosting    | Vercel (zero-config Express)   |

## Run Locally

Requirements: Node.js 24 and npm.

```bash
npm ci --include=dev
cp .env.example .env      # then fill in the values you need
npm run dev               # http://localhost:5000
```

Check that it is running: `GET http://localhost:5000/api/health`.

## Scripts

| Command             | Purpose                              |
| ------------------- | ------------------------------------ |
| `npm run dev`       | Start the API with hot reload        |
| `npm run build`     | Compile TypeScript to `dist/`        |
| `npm start`         | Run the compiled build               |
| `npm run lint`      | ESLint (zero warnings allowed)       |
| `npm run typecheck` | TypeScript type check                |
| `npm test`          | Run the test suite                   |

## Environment Variables

See [.env.example](.env.example). Secrets (MongoDB URI, Stripe keys) live only in `.env` locally and in the Vercel project settings in production — never in Git.

## Response Format

```json
{ "success": true, "data": {} }
{ "success": false, "message": "Readable message", "error": { "code": "MACHINE_CODE" } }
```

## Links

- Live website: _to be added_
- Client repository: _to be added_
