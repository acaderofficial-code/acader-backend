# acader-backend

Backend API for Acader: auth (Firebase), users, payments, Paystack, projects, admin, withdrawals, and notifications.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in values
npm start
```

Default port: `5050` (override with `PORT`).

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default `5050`) |
| `HOST` | Bind host (default `0.0.0.0`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `CORS_ORIGIN` | Allowed origin(s), comma-separated; `*` for all (default) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key for payment verification |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional path to Firebase service account JSON |
| `FIREBASE_SERVICE_ACCOUNT` | Optional JSON string for Firebase service account |
| Email (optional) | For payment-released emails (`EMAIL_USER`, etc.) |

Firebase auth user mapping is based on `firebase_uid` (with email as secondary metadata).

## API overview

- **Auth**: `GET /api/auth/me` — requires `Authorization: Bearer <Firebase ID token>`.
- **Payments**: Create (auth, `user_id` from token), list (admin), get by user/id (owner or admin), PATCH status (admin), verify Paystack (auth), dispute (owner).
- **Paystack**: `GET /api/paystack/verify/:reference` and `GET /api/payments/verify/:reference` — verify transaction (auth; owner/admin only).
- **Projects**: PATCH status (admin only).
- **Admin**: `/api/admin/*` — all routes require admin (users, payments, disputes, withdrawals, resolve dispute).
- **Withdrawals**: POST (auth, `user_id` from token), PATCH status (admin only; refund + notify on reject). Wallet updates are transactional.
- **Notifications**: GET by user / PATCH read (auth; only own data).
- **Reviews**: POST (auth, `reviewer_id` from token), GET by user (public).

## Webhooks

`POST /api/webhooks/paystack` uses raw JSON body parsing for Paystack signature verification (`x-paystack-signature`).

Errors return JSON `{ message: "..." }`.
