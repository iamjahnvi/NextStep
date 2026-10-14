// =============================================================================
// MAILER — server/services/mailer.js
// =============================================================================
// WHAT: AWS SES SMTP email delivery via Nodemailer (verification OTP emails).
// WHY: New email/password sign-ups must verify their address with a code sent
//   through the project's SES SMTP setup. All credentials stay on the backend.
// ENV (read only here, never logged or returned):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
// HOW: Lazy singleton transport. Tests inject a stub via setMailTransport() so
//   no real email is ever sent in automated tests. Every failure maps to a
//   stable, non-leaking error `code` — provider details never reach the client.
// NOTE (SES sandbox): while the SES account is in sandbox mode, sends to
//   unverified recipients fail. That surfaces as RECIPIENT_NOT_VERIFIED with a
//   safe message; production SES access is required for open student delivery.
// =============================================================================

const nodemailer = require("nodemailer");

const REQUIRED_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"];

const missingMailVars = () =>
    REQUIRED_VARS.filter((key) => !(process.env[key] || "").trim());

const isMailConfigured = () => missingMailVars().length === 0;

// Injectable transport for tests. Production lazily builds the SMTP transport.
let injectedTransport = null;
const setMailTransport = (transport) => {
    injectedTransport = transport || null;
};

let cachedTransport = null;
let cachedKey = null;

const getTransport = () => {
    if (injectedTransport) return injectedTransport;
    const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
    // Port 465 = implicit TLS; 587/others = STARTTLS.
    const secure = port === 465;
    const key = [process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_USER, secure].join("|");
    if (!cachedTransport || cachedKey !== key) {
        cachedTransport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 20000,
        });
        cachedKey = key;
    }
    return cachedTransport;
};

const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[ch]);

// Map Nodemailer/SES errors to stable codes. Never include provider text.
const classifyMailError = (error) => {
    const message = String((error && error.message) || "");
    const code = String((error && error.code) || "");
    const responseCode = Number(error && error.responseCode);
    // SES sandbox / identity rejection patterns (message inspected locally
    // only; the inspection result is a generic code, never the raw text).
    if (
        /not verified|verify.*identit|Email address is not verified|InvalidClientTokenId|SignatureDoesNotMatch|Auth/i.test(
            message
        ) ||
            responseCode === 403
    ) {
        // Authentication/identity failures are config problems, not recipient
        // problems — but both stay generic to the client.
        if (/not verified|verify.*identit/i.test(message) && !/auth/i.test(message)) {
            return "RECIPIENT_NOT_VERIFIED";
        }
        return "EMAIL_SEND_FAILED";
    }
    if (code === "EAUTH" || /auth/i.test(message)) return "EMAIL_SEND_FAILED";
    if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION")
        return "EMAIL_SEND_FAILED";
    return "EMAIL_SEND_FAILED";
};

const buildVerificationMail = ({ to, code, ttlMinutes }) => {
    const safeCode = escapeHtml(code);
    const text =
        `Welcome to NextStep!\n\n` +
        `Your email verification code is: ${code}\n\n` +
        `This code expires in ${ttlMinutes} minutes. Enter it on the verification screen to activate your account.\n\n` +
        `If you did not create a NextStep account, you can ignore this email.\n` +
        `Never share this code with anyone — NextStep staff will never ask for it.`;
    // Table-based, image-free layout so the code is readable on mobile and
    // accessible clients without loading remote assets.
    const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#16233f;">` +
        `<div style="border:2px solid #16233f;border-radius:12px;overflow:hidden;">` +
        `<div style="padding:20px 24px;border-bottom:1px solid #c7cedd;">` +
        `<div style="font-weight:bold;font-size:18px;">NextStep</div>` +
        `<div style="font-size:12px;color:#55617d;letter-spacing:0.08em;">EMAIL VERIFICATION</div>` +
        `</div>` +
        `<div style="padding:24px;">` +
        `<p style="margin:0 0 12px;">Welcome to NextStep! Use this code to verify your email address:</p>` +
        `<div style="font-size:32px;font-weight:bold;letter-spacing:0.35em;text-align:center;` +
        `border:1px dashed #2f7cf6;border-radius:8px;padding:14px 8px 14px 16px;margin:16px 0;"` +
        ` role="text" aria-label="Your verification code is ${safeCode}">${safeCode}</div>` +
        `<p style="margin:0 0 12px;color:#55617d;">This code expires in ${ttlMinutes} minutes. ` +
        `If you did not create a NextStep account, you can ignore this email.</p>` +
        `<p style="margin:0;font-size:12px;color:#8993ac;">Never share this code with anyone. ` +
        `NextStep staff will never ask for it.</p>` +
        `</div></div></div>`;
    return {
        from: process.env.EMAIL_FROM || "NextStep <no-reply@nextstep.example>",
        to,
        subject: `Your NextStep verification code (${code})`,
        text,
        html,
    };
};

// Sends the OTP email. Resolves { sent: true } or rejects with err.code in
// { EMAIL_NOT_CONFIGURED, EMAIL_SEND_FAILED, RECIPIENT_NOT_VERIFIED }.
// Never logs bodies, codes, or credentials.
const sendVerificationOtp = async ({ to, code, ttlMinutes }) => {
    const missing = missingMailVars();
    if (missing.length > 0 && !injectedTransport) {
        const err = new Error("Email service is not configured on the server.");
        err.code = "EMAIL_NOT_CONFIGURED";
        throw err;
    }
    const transport = getTransport();
    try {
        await transport.sendMail(buildVerificationMail({ to, code, ttlMinutes }));
        return { sent: true };
    } catch (error) {
        const err = new Error("Could not send the verification email.");
        err.code = classifyMailError(error);
        err.cause = undefined;
        throw err;
    }
};

module.exports = {
    isMailConfigured,
    missingMailVars,
    sendVerificationOtp,
    setMailTransport,
    buildVerificationMail,
};
