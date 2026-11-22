# Wedora — Server

REST API for **Wedora**, a wedding planning platform where customers discover wedding services and request bookings, vendors publish services and manage requests, and admins moderate the platform.

> Status: authentication, services, bookings, dashboards and Stripe payments are in place. Deployment follows.

## Security Model

- The Next.js client signs users in with Better Auth and issues short-lived (15 min) EdDSA JWTs.
- Every protected request must send `Authorization: Bearer <jwt>`. The API verifies signature, issuer, audience and expiry against the client's JWKS (`jose`) — invalid or expired tokens get **401**.
- The token only proves *who* the caller is. Role, block status and subscription are loaded **from MongoDB on every request**, so changes (e.g. an admin blocking a user) apply immediately.
- Blocked users and wrong roles get **403**. Role middleware: `requireRole("admin" | "vendor" | "customer")`.
- Request bodies are validated with Zod; unknown fields are rejected.

## API

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
| `GET /api/vendor/stats` | vendor | Total / active / live services, pending & accepted bookings, current plan |
| `GET /api/customer/stats` | customer | Total, pending, accepted, rejected, cancelled booking requests |
| `GET /api/admin/stats` | admin | Users, vendors, customers, blocked users, services, pending services, transactions |
| `GET /api/admin/users` | admin | Users with `q` (name/email/business), `role`, `status` (active/blocked), pagination |
| `GET /api/admin/users/:id` | admin | User details with activity counts |
| `PATCH /api/admin/users/:id/block` | admin | `{ isBlocked }` — signs blocked users out (sessions deleted); admins and yourself can't be blocked (`403`) |
| `POST /api/billing/checkout` | vendor | Start Stripe Checkout for Premium → `{ url }`. Price ($29/month, USD) and vendor id are set by the server; `409` if already Premium; an open session is reused |
| `GET /api/billing/status` | vendor | Plan, paid-through date, cancellation flag, recent payments; `?session_id=` adds that checkout's status (own sessions only) |
| `POST /api/billing/cancel` | vendor | Cancel at period end — Premium stays until the paid-through date |
| `POST /api/billing/resume` | vendor | Undo a scheduled cancellation |
| `POST /api/webhooks/stripe` | Stripe signature | The **only** way Premium is activated — raw body, signature verified, idempotent |
| `GET /api/admin/transactions` | admin | Read-only payment ledger with vendor info, `q`, `status`, pagination and totals |

Prices are whole US dollars. Malformed or unknown ids return `404`. Status changes are atomic (`findOneAndUpdate` on `status: "pending"` + owner), and a partial unique index blocks duplicate active requests even under concurrent submissions. Deleting a service cancels its pending requests.

## Payments (Stripe)

- Vendors upgrade through **Stripe Checkout** in subscription mode: $29/month in USD (local-currency conversion is turned off).
- Checkout creates a `pending` transaction. **Only a signature-verified webhook** switches Premium on, so the success page can't grant it.
- Handled events:
  - `checkout.session.completed`: activates Premium; the transaction becomes `paid`
  - `checkout.session.expired` and `async_payment_failed`: the transaction becomes `expired` / `failed`
  - `invoice.paid` and `invoice.payment_failed`: renewals are recorded and the paid-through date is extended
  - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`: plan, expiry and cancellation are kept in sync
- The handler re-reads the subscription from Stripe on every event, so out-of-order deliveries are safe. Unique session and invoice ids make redeliveries harmless.
- If an event fails, the webhook returns 5xx and Stripe retries.

**Local webhooks** (Stripe CLI, test mode):

```bash
stripe listen --forward-to localhost:5000/api/webhooks/stripe   --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted
```

Put the `whsec_…` secret it prints in `STRIPE_WEBHOOK_SECRET`.

**Production:** add an endpoint `https://<api-domain>/api/webhooks/stripe` in Stripe (Developers → Webhooks) for the same events, then set its signing secret in the Vercel environment.

Test card: `4242 4242 4242 4242`, any future date, any CVC.

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
