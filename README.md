# Wedora — Server

REST API for **Wedora**, a wedding planning platform where customers discover wedding services and request bookings, vendors publish services and manage requests, and admins moderate the platform.

> Status: authentication and authorization core is in place. Service, booking and payment endpoints are added in upcoming phases.

## Security Model

- The Next.js client signs users in with Better Auth and issues short-lived (15 min) EdDSA JWTs.
- Every protected request must send `Authorization: Bearer <jwt>`. The API verifies signature, issuer, audience and expiry against the client's JWKS (`jose`) — invalid or expired tokens get **401**.
- The token only proves *who* the caller is. Role, block status and subscription are loaded **from MongoDB on every request**, so changes (e.g. an admin blocking a user) apply immediately.
- Blocked users and wrong roles get **403**. Role middleware: `requireRole("admin" | "vendor" | "customer")`.
- Request bodies are validated with Zod; unknown fields are rejected.

## API (so far)

| Method & path      | Access                  | Purpose                                         |
| ------------------ | ----------------------- | ----------------------------------------------- |
| `GET /api/health`  | public                  | Liveness check                                  |
| `GET /api/me`      | signed in               | Current profile, read fresh from the database   |
| `POST /api/me/role`| signed in, no role yet  | One-time Customer/Vendor choice for Google sign-ups (`409` if already set) |
| `GET /api/services` | public | Approved + available services. Query: `q`, `category`, `location`, `minPrice`, `maxPrice`, `sort` (`newest`, `price_asc`, `price_desc`), `page`, `limit` |
| `GET /api/services/featured` | public | Newest approved services for the home page |
| `GET /api/services/categories` | public | Service count per category |
| `GET /api/services/:id` | signed in | Details (customers: public services only; owner vendor and admins: any status) |
| `GET /api/vendor/services` | vendor | Own services + plan usage (`activeCount`, `activeLimit`) |
| `POST /api/vendor/services` | vendor | Create (starts **pending**; Free plan max 3 active → `403 PLAN_LIMIT_REACHED`) |
| `PATCH /api/vendor/services/:id` | vendor (owner) | Update; content edits send approved/rejected services back to review |
| `PATCH /api/vendor/services/:id/availability` | vendor (owner) | Pause / resume |
| `DELETE /api/vendor/services/:id` | vendor (owner) | Delete |
| `GET /api/admin/services` | admin | All services with `q`, `status`, `category`, pagination |
| `PATCH /api/admin/services/:id/status` | admin | Approve / reject (reason required) / back to review |
| `DELETE /api/admin/services/:id` | admin | Delete inappropriate services |

| `POST /api/bookings` | customer | Request a booking (`serviceId`, `eventDate` YYYY-MM-DD, `eventLocation`, `message`); vendor/customer are set by the server; duplicates → `409` |
| `GET /api/customer/bookings` | customer | Own booking requests with service and vendor info (`status` filter) |
| `GET /api/customer/bookings/:id` | customer (owner) | Booking details |
| `PATCH /api/customer/bookings/:id/cancel` | customer (owner) | Cancel — pending only (`409` otherwise) |
| `GET /api/vendor/bookings` | vendor | Requests for own services with customer contact info (`status` filter) |
| `PATCH /api/vendor/bookings/:id` | vendor (owner) | `{ status: "accepted" | "rejected" }` — pending only, once (`409` otherwise) |

Prices are whole US dollars. Malformed or unknown ids return `404`. Status changes are atomic (`findOneAndUpdate` on `status: "pending"` + owner), and a partial unique index blocks duplicate active requests even under concurrent submissions. Deleting a service cancels its pending requests.

## Technology Stack

| Area       | Choice                         |
| ---------- | ------------------------------ |
| Runtime    | Node.js 24, TypeScript (ESM)   |
| Framework  | Express 5                      |
| Validation | Zod                            |
| Database   | MongoDB (native driver)        |
| Auth       | JWT verification with `jose` (Better Auth JWKS) |
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
| `npm run db:setup`  | Create MongoDB indexes (idempotent)  |

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
