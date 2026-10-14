// -----------------------------------------------------------------------------
// VERIFY-EMAIL VIEW MODEL — pure helpers for the OTP verification screen.
// HOW: No React, no network, no storage side effects beyond guarded
//   sessionStorage helpers — so this module is unit-testable with node:test
//   (see verifyEmailViewModel.test.js), mirroring freshnessDashboardViewModel.
// WHY: The VerifyEmail page maps stable backend error CODES (never message
//   strings) to concise UI copy + a next action, and must survive refreshes
//   via the pending-email key without ever persisting OTPs or tokens.
// -----------------------------------------------------------------------------

export const OTP_LENGTH = 6;
export const PENDING_EMAIL_KEY = "nextstep:pendingEmail";

// Keep only digits, capped at 6 — drives the input, paste, and mobile entry.
export const sanitizeOtpInput = (value) =>
    String(value ?? "").replace(/\D/g, "").slice(0, OTP_LENGTH);

export const isCompleteOtp = (value) => new RegExp(`^\\d{${OTP_LENGTH}}$`).test(String(value ?? ""));

// Show the destination address recognisably but truncated: "as***@example.com".
export const maskEmail = (email) => {
    const clean = String(email ?? "").trim();
    const at = clean.indexOf("@");
    if (at <= 0) return clean;
    const local = clean.slice(0, at);
    const domain = clean.slice(at + 1);
    const visible = local.slice(0, 2);
    return `${visible}***@${domain}`;
};

// Stable backend code -> { message, action }. Actions: retry | resend | login
// | signup | wait | none. Unknown codes fall back to a generic message.
export const VERIFY_ERROR_DETAILS = {
    INVALID_CODE: {
        message: "That code doesn't match. Check the latest email and try again.",
        action: "retry",
    },
    EXPIRED_CODE: {
        message: "That code has expired. Request a new one to continue.",
        action: "resend",
    },
    TOO_MANY_ATTEMPTS: {
        message: "Too many incorrect attempts. Request a new code to continue.",
        action: "resend",
    },
    RESEND_COOLDOWN: {
        message: "A code was just sent. Wait a moment before requesting another.",
        action: "wait",
    },
    RESEND_LIMIT_REACHED: {
        message: "Too many code requests. Please try again later.",
        action: "wait",
    },
    EMAIL_SEND_FAILED: {
        message: "We couldn't send the email. Check the address or try resending.",
        action: "resend",
    },
    RECIPIENT_NOT_VERIFIED: {
        message:
            "We can't deliver to this address yet. Try a different email or contact support.",
        action: "retry",
    },
    ALREADY_VERIFIED: {
        message: "This email is already verified. Please log in.",
        action: "login",
    },
    NO_PENDING_VERIFICATION: {
        message: "No pending verification for this email. Sign up again to get a code.",
        action: "signup",
    },
    EMAIL_ALREADY_REGISTERED: {
        message: "An account with this email already exists. Please log in instead.",
        action: "login",
    },
    EMAIL_NOT_VERIFIED: {
        message: "Please verify your email first. Enter your code or resend it.",
        action: "retry",
    },
    RATE_LIMITED: {
        message: "Too many requests. Wait a moment and try again.",
        action: "wait",
    },
    VALIDATION_ERROR: {
        message: "Please check the highlighted fields and try again.",
        action: "retry",
    },
};

export const describeVerifyError = (code) =>
    VERIFY_ERROR_DETAILS[code] || {
        message: "Something went wrong. Please try again.",
        action: "retry",
    };

// Seconds of resend cooldown left, given the server's retryAfterSeconds or a
// local last-sent timestamp. Backend remains authoritative; this only drives
// the countdown display.
export const cooldownRemaining = ({ retryAfterSeconds, lastSentAt, cooldownSeconds = 60, now = Date.now() }) => {
    if (Number.isFinite(retryAfterSeconds)) return Math.max(0, Math.ceil(retryAfterSeconds));
    if (!lastSentAt) return 0;
    const elapsed = (now - new Date(lastSentAt).getTime()) / 1000;
    return Math.max(0, Math.ceil(cooldownSeconds - elapsed));
};

const storage = () => {
    try {
        return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch {
        return null;
    }
};

// Pending EMAIL only — never OTPs, never tokens.
export const savePendingEmail = (email) => {
    const store = storage();
    if (!store || !email) return;
    store.setItem(PENDING_EMAIL_KEY, String(email).trim().toLowerCase());
};

export const readPendingEmail = () => {
    const store = storage();
    if (!store) return "";
    return (store.getItem(PENDING_EMAIL_KEY) || "").trim();
};

export const clearPendingEmail = () => {
    const store = storage();
    if (!store) return;
    store.removeItem(PENDING_EMAIL_KEY);
};
