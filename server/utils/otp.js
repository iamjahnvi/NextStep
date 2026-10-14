// =============================================================================
// OTP HELPERS — server/utils/otp.js
// =============================================================================
// WHAT: Cryptographically-secure 6-digit email-verification codes + hashing.
// WHY: Email OTP verification for new email/password sign-ups. Plaintext OTPs
//   are never stored or logged — only a SHA-256 hash. Math.random() is never
//   used (it is predictable); crypto.randomInt() is.
// HOW: generateOtp() -> "042913"; hashOtp(code) -> hex digest compared with
//   crypto.timingSafeEqual to avoid timing side-channels.
// CONFIG (env, all optional — safe defaults):
//   OTP_TTL_MINUTES (default 10), OTP_MAX_ATTEMPTS (default 5),
//   OTP_RESEND_COOLDOWN_SECONDS (default 60), OTP_MAX_RESENDS_PER_HOUR (5)
// =============================================================================

const crypto = require("crypto");

const OTP_LENGTH = 6;

const normalizeEmail = (email) =>
    typeof email === "string" ? email.trim().toLowerCase() : "";

// Generate a zero-padded numeric OTP using a CSPRNG. Never Math.random().
const generateOtp = (length = OTP_LENGTH) => {
    const max = 10 ** length;
    const value = crypto.randomInt(0, max);
    return String(value).padStart(length, "0");
};

// SHA-256 hash of the code. No salt needed: 6 digits are brute-forceable, so
// the hash exists to avoid plaintext storage, while attempt limits + expiry
// (enforced in the controller) provide the real protection.
const hashOtp = (code) => {
    if (typeof code !== "string") return null;
    return crypto.createHash("sha256").update(code, "utf8").digest("hex");
};

// Constant-time comparison of a candidate code against a stored hash.
// Returns false for any malformed input (never throws).
const verifyOtpHash = (candidate, storedHash) => {
    if (typeof candidate !== "string" || typeof storedHash !== "string") return false;
    const candidateHash = hashOtp(candidate);
    if (!candidateHash) return false;
    const a = Buffer.from(candidateHash, "hex");
    const b = Buffer.from(storedHash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

// Strict "exactly 6 digits" check for request validation.
const isWellFormedOtp = (code) =>
    typeof code === "string" && new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);

const intFromEnv = (name, fallback, min, max) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const getOtpConfig = () => ({
    ttlMinutes: intFromEnv("OTP_TTL_MINUTES", 10, 1, 1440),
    maxAttempts: intFromEnv("OTP_MAX_ATTEMPTS", 5, 1, 20),
    resendCooldownSeconds: intFromEnv("OTP_RESEND_COOLDOWN_SECONDS", 60, 0, 3600),
    maxResendsPerHour: intFromEnv("OTP_MAX_RESENDS_PER_HOUR", 5, 1, 50),
    length: OTP_LENGTH,
});

module.exports = {
    OTP_LENGTH,
    normalizeEmail,
    generateOtp,
    hashOtp,
    verifyOtpHash,
    isWellFormedOtp,
    getOtpConfig,
};
