import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../context/useAuth";
import {
    sanitizeOtpInput,
    isCompleteOtp,
    maskEmail,
    describeVerifyError,
    cooldownRemaining,
    savePendingEmail,
    readPendingEmail,
    clearPendingEmail,
} from "./verifyEmailViewModel";
import "./VerifyEmail.css";

const RESEND_COOLDOWN_FALLBACK = 60;

function VerifyEmail() {
    const navigate = useNavigate();
    const location = useLocation();
    const { login } = useAuth();
    const codeInputRef = useRef(null);

    // Email recovery order: navigation state -> surviving session key ->
    // manual entry (refresh/new-tab/lost-state recovery). OTPs and tokens are
    // never persisted — only the address.
    const [email, setEmail] = useState(
        () => location.state?.email || readPendingEmail() || ""
    );
    const [emailLocked, setEmailLocked] = useState(
        () => !!(location.state?.email || readPendingEmail())
    );
    const [code, setCode] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [resending, setResending] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [error, setError] = useState(null); // { message, action }
    const [info, setInfo] = useState(() => {
        if (location.state?.emailSent === false) {
            return "We couldn't deliver the first email. Check the address below, or resend the code.";
        }
        if (location.state?.email) {
            const mins = location.state?.expiresInMinutes || 10;
            return `A 6-digit code was sent to ${maskEmail(location.state.email)}. It expires in about ${mins} minutes.`;
        }
        return "";
    });

    // Persist the pending address across refreshes (email only).
    useEffect(() => {
        if (email) savePendingEmail(email);
    }, [email]);

    // Focus the code field when an address is known (keyboard/SR safe: a
    // single labelled input, no focus stealing afterwards).
    useEffect(() => {
        if (emailLocked && codeInputRef.current) codeInputRef.current.focus();
    }, [emailLocked]);

    // Resend cooldown countdown; the backend remains authoritative.
    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
        return () => clearInterval(timer);
    }, [cooldown]);

    const failWith = useCallback((err, fallbackAction = "retry") => {
        if (!err?.response) {
            setError({
                message: "You're offline or the server is unreachable. Check your connection and try again.",
                action: fallbackAction,
            });
            return;
        }
        const data = err.response.data || {};
        const details = describeVerifyError(data.code);
        let message = details.message;
        if (data.code === "INVALID_CODE" && Number.isFinite(data.attemptsLeft)) {
            message =
                data.attemptsLeft > 0
                    ? `Incorrect code. ${data.attemptsLeft} attempt${data.attemptsLeft === 1 ? "" : "s"} left before you need a new code.`
                    : "Incorrect code. Request a new code to continue.";
        }
        if (data.code === "RESEND_COOLDOWN") {
            setCooldown(cooldownRemaining({ retryAfterSeconds: data.retryAfterSeconds }));
        }
        setError({ message: data.message || message, action: details.action });
    }, []);

    const handleVerify = async (e) => {
        e?.preventDefault();
        if (verifying || resending) return;
        if (!isCompleteOtp(code)) {
            setError({
                message: "Enter the 6-digit code from your email.",
                action: "retry",
            });
            return;
        }
        setVerifying(true);
        setError(null);
        try {
            // Double-submit guard: the request already in flight owns this slot.
            const response = await api.post("/auth/verify-otp", { email, code });
            if (response.data?.code === "VERIFIED" && response.data?.token) {
                clearPendingEmail();
                await login(response.data.token);
                navigate("/main");
            } else if (response.data?.code === "ALREADY_VERIFIED") {
                clearPendingEmail();
                navigate("/login");
            } else {
                setError(describeVerifyError(response.data?.code));
            }
        } catch (err) {
            // Session issuance after verification happens server-side; a
            // failure here means no token was returned, so no partial session.
            failWith(err);
        } finally {
            setVerifying(false);
        }
    };

    const handleResend = async () => {
        if (resending || verifying || cooldown > 0 || !email) return;
        setResending(true);
        setError(null);
        try {
            const response = await api.post("/auth/resend-otp", { email });
            if (response.data?.success) {
                setInfo("A new code was sent. Only the latest code works.");
                setCode("");
                setCooldown(RESEND_COOLDOWN_FALLBACK);
                codeInputRef.current?.focus();
            } else if (response.data?.code === "ALREADY_VERIFIED") {
                clearPendingEmail();
                navigate("/login");
            } else {
                setError(describeVerifyError(response.data?.code));
            }
        } catch (err) {
            failWith(err, "resend");
        } finally {
            setResending(false);
        }
    };

    const handleUseEmail = (e) => {
        e.preventDefault();
        const clean = email.trim().toLowerCase();
        if (!clean) return;
        savePendingEmail(clean);
        setEmailLocked(true);
        setInfo("Enter the code from your email, or resend a fresh one below.");
        setError(null);
    };

    const actionFooter = () => {
        if (!error) return null;
        switch (error.action) {
            case "login":
                return (
                    <button type="button" className="verify-inline-link" onClick={() => navigate("/login")}>
                        Go to login →
                    </button>
                );
            case "signup":
                return (
                    <button type="button" className="verify-inline-link" onClick={() => navigate("/signup")}>
                        Back to signup →
                    </button>
                );
            case "resend":
                return (
                    <button
                        type="button"
                        className="verify-inline-link"
                        onClick={handleResend}
                        disabled={resending || cooldown > 0}
                    >
                        {resending ? "Sending…" : cooldown > 0 ? `Resend available in ${cooldown}s` : "Resend a new code →"}
                    </button>
                );
            default:
                return null;
        }
    };

    return (
        <div className="verify-page">
            <nav className="verify-nav">
                <div className="verify-brand">
                    <span className="verify-brand-mark" aria-hidden="true">N</span>
                    NextStep
                </div>
                <button type="button" className="verify-nav-link verify-mono" onClick={() => navigate("/")}>
                    ← Back home
                </button>
            </nav>

            <div className="verify-wrap">
                <div className="verify-card-stage">
                    <div className="verify-form-card">
                        <div className="verify-form-top">
                            <div>
                                <div className="verify-mono verify-form-label">EMAIL CHECK</div>
                                <div className="verify-form-title">Verify your email</div>
                            </div>
                        </div>

                        <div className="verify-form-body">
                            {info && (
                                <div className="verify-info" role="status">{info}</div>
                            )}
                            {error && (
                                <div className="verify-form-error" role="alert">
                                    <span>{error.message}</span>
                                    <span className="verify-error-action">{actionFooter()}</span>
                                </div>
                            )}

                            {!emailLocked ? (
                                <form onSubmit={handleUseEmail}>
                                    <p className="verify-hint">
                                        Enter the address you signed up with to resume verification.
                                    </p>
                                    <div className="verify-field">
                                        <label className="verify-mono" htmlFor="verify-email">
                                            Email address
                                        </label>
                                        <input
                                            id="verify-email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            autoComplete="email"
                                            required
                                        />
                                    </div>
                                    <button type="submit" className="verify-btn-primary" disabled={!email.trim()}>
                                        Continue
                                    </button>
                                </form>
                            ) : (
                                <form onSubmit={handleVerify}>
                                    <p className="verify-hint">
                                        Code sent to <strong>{maskEmail(email)}</strong>
                                        <span className="verify-full-email"> ({email})</span>
                                        {" · "}
                                        <button
                                            type="button"
                                            className="verify-inline-link"
                                            onClick={() => {
                                                setEmailLocked(false);
                                                setError(null);
                                            }}
                                        >
                                            Wrong address?
                                        </button>
                                    </p>

                                    <div className="verify-field">
                                        <label className="verify-mono" htmlFor="verify-code">
                                            6-digit code
                                        </label>
                                        <input
                                            ref={codeInputRef}
                                            id="verify-code"
                                            type="text"
                                            inputMode="numeric"
                                            autoComplete="one-time-code"
                                            placeholder="––––––"
                                            maxLength={6}
                                            value={code}
                                            onChange={(e) => setCode(sanitizeOtpInput(e.target.value))}
                                            onPaste={(e) => {
                                                const pasted = sanitizeOtpInput(
                                                    e.clipboardData?.getData("text") ?? ""
                                                );
                                                if (pasted) {
                                                    e.preventDefault();
                                                    setCode(pasted);
                                                }
                                            }}
                                            aria-describedby="verify-code-help"
                                            required
                                        />
                                        <p id="verify-code-help" className="verify-field-help">
                                            Numbers only. You can paste the code straight from your email.
                                        </p>
                                    </div>

                                    <button
                                        type="submit"
                                        className="verify-btn-primary"
                                        disabled={verifying || resending || !isCompleteOtp(code)}
                                    >
                                        {verifying ? "Verifying…" : "Verify email"}
                                    </button>

                                    <div className="verify-resend-row">
                                        <span className="verify-mono verify-resend-label">
                                            DIDN&apos;T GET IT?
                                        </span>
                                        <button
                                            type="button"
                                            className="verify-inline-link"
                                            onClick={handleResend}
                                            disabled={resending || verifying || cooldown > 0}
                                        >
                                            {resending
                                                ? "Sending…"
                                                : cooldown > 0
                                                    ? `Resend in ${cooldown}s`
                                                    : "Resend code"}
                                        </button>
                                    </div>

                                    <p className="verify-form-footer">
                                        Already verified?{" "}
                                        <button
                                            type="button"
                                            className="verify-form-footer__link"
                                            onClick={() => navigate("/login")}
                                        >
                                            Log in
                                        </button>
                                    </p>
                                </form>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default VerifyEmail;
