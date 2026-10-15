# Email OTP Verification — NextStep

New **email/password sign-ups only**. Google sign-in and existing accounts are untouched.

## Flow

1. `POST /api/v1/auth/signup { name, email, password, confirmPassword }`
   → `201` (new) or `200` (pending-account retry) with
   `{ success, code: "VERIFICATION_REQUIRED", emailSent, email, expiresInMinutes }`.
   **No JWT is issued.** A 6-digit code is emailed; only its SHA-256 hash is stored.
2. `POST /api/v1/auth/verify-otp { email, code }`
   → `200 { code: "VERIFIED", token, user }` on success (normal 7-day JWT, existing conventions).
   Replays return `ALREADY_VERIFIED` with **no token** (log in instead).
3. `POST /api/v1/auth/resend-otp { email }`
   → `200 { code: "OTP_SENT", ... }`. Invalidates the prior code — only the latest works.
4. `POST /api/v1/auth/login` for a pending account → `403 { code: "EMAIL_NOT_VERIFIED" }`, no token.
   Verified accounts and Google sign-in behave exactly as before.

## Stable error codes (frontend maps these, never message strings)

`VERIFICATION_REQUIRED`, `VERIFIED`, `ALREADY_VERIFIED`, `EMAIL_ALREADY_REGISTERED`,
`EMAIL_NOT_VERIFIED`, `NO_PENDING_VERIFICATION`, `INVALID_CODE` (malformed + wrong;
wrong attempts return `attemptsLeft`), `EXPIRED_CODE`, `TOO_MANY_ATTEMPTS`,
`RESEND_COOLDOWN` (with `retryAfterSeconds`), `RESEND_LIMIT_REACHED`,
`EMAIL_SEND_FAILED`, `RECIPIENT_NOT_VERIFIED`, `VALIDATION_ERROR`, `RATE_LIMITED`,
`USER_NOT_FOUND`, `INVALID_CREDENTIALS`, `INTERNAL_ERROR`.

## Frontend

- `/signup` → on success navigates to `/verify-email` (address passed via router state
  + `sessionStorage[nextstep:pendingEmail]` — email only, never OTPs/tokens).
- `/verify-email` (public): labelled 6-digit input (`inputMode=numeric`,
  `autoComplete=one-time-code`), paste support, Verify loading/disabled states, resend
  with visible cooldown, wrong-address + back-to-login paths, refresh/new-tab recovery
  via the pending-email key or manual address entry.
- `/login`: `EMAIL_NOT_VERIFIED` shows an inline "Verify now →" action.
- API origin: `VITE_API_URL` env with `http://localhost:5000/api/v1` fallback
  (`client/src/services/api.js`). Set `VITE_API_URL` in production builds.

## Configuration (placeholders only — real values live in untracked `.env`)

```
SMTP_HOST=email-smtp.<region>.amazonaws.com   # region-specific SES SMTP endpoint
SMTP_PORT=587                                  # 587 STARTTLS | 465 implicit TLS
SMTP_USER=…  SMTP_PASS=…                       # SES SMTP credentials (backend only)
EMAIL_FROM="NextStep <no-reply@yourdomain>"    # must be SES-verified
OTP_TTL_MINUTES=10  OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60  OTP_MAX_RESENDS_PER_HOUR=5
```

`.env` / `.env.*` are git-ignored (root `.gitignore`); only `.env.example` is committed.

## SES sandbox

The SES account is in **sandbox mode**: sends to unverified recipients fail. The API
surfaces this as `RECIPIENT_NOT_VERIFIED` with a safe, actionable message (no AWS
internals leak). **Unrestricted student delivery requires SES production access**
(verify the sender identity/domain, then request production access in the SES console
for the sending region). Verification is never weakened to make sandbox testing pass.

## Local testing (mocked mail, no AWS needed)

```powershell
# backend (isolated Mongo + stub mail transport — see tests/emailOtp.test.js)
cd server; npm test
# frontend view-model tests (pure, no browser)
cd client; node --test src/pages/verifyEmailViewModel.test.js src/pages/freshnessDashboardViewModel.test.js
# builds / lint
cd client; npm run build; npx eslint src/pages/VerifyEmail.jsx src/pages/verifyEmailViewModel.js src/pages/Signup.jsx src/pages/Login.jsx src/services/api.js src/App.jsx
```

To exercise real SMTP locally, fill the five mail vars in `server/.env` (never commit)
and sign up with a sandbox-verified recipient address.

## Backwards compatibility (no migration, no destructive ops)

- `User.isEmailVerified` has **no schema default**: legacy documents missing the field
  read as verified; Google-linked accounts always count as verified. Only an explicit
  `false` on a password account is pending. No `deleteMany`/rewrites were run.
- `GET /auth/me` now returns an explicit safe projection (password/OTP state never
  serialized; schema-level `toJSON` stripping added as defense-in-depth).
- Rate limits (in-memory, per-IP): signup 10/15min, login 30/15min, verify 20/15min,
  resend 5/15min — plus per-email OTP attempt cap, resend cooldown, and hourly budget.
  Revisit with a shared store if horizontally scaled.

## Security notes / remaining prerequisites

- OTPs: `crypto.randomInt` 6-digit, SHA-256 hash + `timingSafeEqual`, 10-min TTL,
  5-attempt cap, atomic consume via guarded `findOneAndUpdate`, resend supersedes.
- Pending-account retry updates only name/password — never verified data, Google
  identity, or profile. Concurrent signups converge via duplicate-key recovery.
- Still open (pre-existing, out of scope): open CORS allowlist, no helmet, JWT
  secret boot validation, avatar-in-doc bloat. Production still needs `VITE_API_URL`,
  SES production access, and the five mail vars on the host.
