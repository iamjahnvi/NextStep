// =============================================================================
// RATE LIMITS — server/utils/rateLimit.js
// =============================================================================
// WHAT: Minimal in-memory rate limiters for auth endpoints (abuse prevention).
// WHY: Signup/verify/resend/login must be bounded so OTP emails and guessing
//   cannot be abused, without making ordinary users unusable.
// HOW: express-rate-limit with JSON 429 responses carrying a stable
//   RATE_LIMITED code. In-memory store suits the current single-instance
//   deployment; revisit with a shared store if horizontally scaled.
// =============================================================================

const { rateLimit } = require("express-rate-limit");

const jsonHandler = (req, res) =>
    res.status(429).json({
        success: false,
        code: "RATE_LIMITED",
        message: "Too many requests. Please wait a moment and try again.",
    });

const makeLimiter = ({ windowMs, limit }) =>
    rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        handler: jsonHandler,
    });

// 10 signups / 15 min per IP — generous for households, stops bulk creation.
const signupLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });
// 30 login attempts / 15 min per IP.
const loginLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30 });
// 20 verify attempts / 15 min per IP (per-account attempt cap also enforced).
const verifyLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 20 });
// 5 resends / 15 min per IP (per-email cooldown + hourly cap also enforced).
const resendLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });

module.exports = {
    signupLimiter,
    loginLimiter,
    verifyLimiter,
    resendLimiter,
};
