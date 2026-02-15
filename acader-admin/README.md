# acader-admin

Admin dashboard for Acader. Uses Firebase Auth for login and calls the backend API
with a Firebase ID token.

## Run locally

```bash
npm install
npm run dev
```

## Environment variables

Create `.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:5050

NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

## Auth behavior

- After login, the Firebase ID token is stored and refreshed via `onIdTokenChanged`.
- All admin requests include `Authorization: Bearer <token>`.

## Admin routes used

- `GET /api/admin/stats`
- `GET /api/admin/users`
- `GET /api/payments`
- `PATCH /api/payments/:id/status`
- `POST /api/payments/:id/dispute`
- `GET /api/admin/disputes`
- `PATCH /api/admin/disputes/:id/resolve`
- `GET /api/admin/withdrawals`
- `PATCH /api/withdrawals/:id/status`
