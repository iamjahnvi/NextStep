import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../context/useAuth";
import PasswordInput from "../components/PasswordInput";
import GoogleAuthButton from "../components/GoogleAuthButton";
import { savePendingEmail } from "./verifyEmailViewModel";
import "./Login.css";

const PROMO_CHIPS = ["JEE", "NEET", "CUET", "CLAT", "+40 more"];

// Sample watchlist for the live spotlight: illustrative deadlines that show
// what deadline tracking feels like once the user is inside.
const SPOTLIGHT_EXAMS = [
    { name: "JEE Main", meta: "Engineering · NTA", daysLeft: 12, windowDays: 60 },
    { name: "NEET UG", meta: "Medical · NTA", daysLeft: 26, windowDays: 60 },
    { name: "CUET UG", meta: "Universities · NTA", daysLeft: 9, windowDays: 60 },
    { name: "CLAT", meta: "Law · Consortium", daysLeft: 34, windowDays: 90 },
];

const SPOTLIGHT_INTERVAL_MS = 4500;

// Live deadline spotlight: cycles the sample watchlist with a closing
// countdown bar. Dots allow manual jumps; hovering pauses rotation.
function Spotlight({ index, onPausedChange, onSelect, variant = "" }) {
    const exam = SPOTLIGHT_EXAMS[index % SPOTLIGHT_EXAMS.length];
    const progress = Math.max(
        0,
        Math.min(100, (exam.daysLeft / exam.windowDays) * 100)
    );

    return (
        <div
            className={`login-spotlight${variant ? ` ${variant}` : ""}`}
            onMouseEnter={() => onPausedChange(true)}
            onMouseLeave={() => onPausedChange(false)}
        >
            <div className="login-spotlight__top">
                <span className="login-spotlight__live">Deadline watch</span>
                <div className="login-spotlight__dots" role="tablist" aria-label="Featured deadlines">
                    {SPOTLIGHT_EXAMS.map((item, i) => (
                        <button
                            key={item.name}
                            type="button"
                            role="tab"
                            aria-selected={i === index % SPOTLIGHT_EXAMS.length}
                            aria-label={`Show ${item.name} deadline`}
                            className={i === index % SPOTLIGHT_EXAMS.length ? "is-active" : ""}
                            onClick={() => onSelect(i)}
                        />
                    ))}
                </div>
            </div>
            <div className="login-spotlight__body" key={index}>
                <p className="login-spotlight__name">{exam.name}</p>
                <p className="login-spotlight__meta">{exam.meta}</p>
                <div className="login-spotlight__due">
                    <span>
                        Closes in <strong>{exam.daysLeft} days</strong>
                    </span>
                </div>
                <div className="login-spotlight__bar" aria-hidden="true">
                    <span style={{ width: `${progress}%` }} />
                </div>
            </div>
        </div>
    );
}

function PromoBackground() {
    return (
        <svg className="login-bg-deco" viewBox="0 0 700 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <path
                d="M540 40 L470 40 L470 220 L540 220"
                fill="none"
                stroke="rgba(47,124,246,0.16)"
                strokeWidth="26"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M660 60 L730 60 L730 240 L660 240"
                fill="none"
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="26"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="560" cy="560" r="150" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
            <circle
                cx="560"
                cy="560"
                r="118"
                fill="none"
                stroke="rgba(47,124,246,0.14)"
                strokeWidth="2"
                strokeDasharray="3 7"
            />
            <circle cx="560" cy="560" r="90" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
            <g transform="translate(180,620)">
                <path
                    d="M0 -46 L28 -14 L11 -14 L11 46 L-11 46 L-11 -14 L-28 -14 Z"
                    fill="rgba(47,124,246,0.10)"
                    transform="rotate(0)"
                />
                <path
                    d="M0 -46 L28 -14 L11 -14 L11 46 L-11 46 L-11 -14 L-28 -14 Z"
                    fill="rgba(255,255,255,0.05)"
                    transform="rotate(72)"
                />
                <path
                    d="M0 -46 L28 -14 L11 -14 L11 46 L-11 46 L-11 -14 L-28 -14 Z"
                    fill="rgba(47,124,246,0.10)"
                    transform="rotate(144)"
                />
                <path
                    d="M0 -46 L28 -14 L11 -14 L11 46 L-11 46 L-11 -14 L-28 -14 Z"
                    fill="rgba(255,255,255,0.05)"
                    transform="rotate(216)"
                />
                <path
                    d="M0 -46 L28 -14 L11 -14 L11 46 L-11 46 L-11 -14 L-28 -14 Z"
                    fill="rgba(47,124,246,0.10)"
                    transform="rotate(288)"
                />
            </g>
        </svg>
    );
}

// -----------------------------------------------------------------------------
// CLIENT-SIDE EMAIL VALIDATION (login)
// HOW: The same regex used in Signup flags a malformed email before the request
//   is sent. WHY: gives instant feedback so users notice a typo immediately.
// -----------------------------------------------------------------------------
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function Login() {
    const navigate = useNavigate();
    const { login } = useAuth();
    const [rememberMe, setRememberMe] = useState(false);
    const [formData, setFormData] = useState({
        email: "",
        password: "",
    });
    const [errors, setErrors] = useState({
        email: "",
        _form: "",
    });
    // Set when the backend reports EMAIL_NOT_VERIFIED: the password was right
    // but the account is pending OTP — offer the verification path.
    const [needsVerification, setNeedsVerification] = useState(false);

    // Spotlight rotation: shared by the desktop + mobile instances so they
    // stay in sync. Paused on hover/focus and never auto-advances under
    // reduced-motion.
    const [spotIndex, setSpotIndex] = useState(0);
    const [spotPaused, setSpotPaused] = useState(false);

    useEffect(() => {
        if (spotPaused) return;
        if (
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ) {
            return;
        }
        const timer = setInterval(() => {
            setSpotIndex((i) => (i + 1) % SPOTLIGHT_EXAMS.length);
        }, SPOTLIGHT_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [spotPaused]);

    const handleChange = (e) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value,
        });
        // live email validation while typing
        if (e.target.name === "email") {
            const value = e.target.value;
            let error = "";
            if (value && !EMAIL_REGEX.test(value.trim())) {
                error = "Please enter a valid email address (e.g. you@example.com).";
            }
            setErrors((prev) => ({ ...prev, email: error }));
        }
    };

    // Google sign-in lives in components/GoogleAuthButton (official GIS button
    // rendered invisibly over our custom styling, so the account chooser
    // reliably opens). Its onError surfaces inline here.
    const handleGoogleError = (message) => {
        setErrors((prev) => ({ ...prev, _form: message || "" }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // ---------------------------------------------------------------------
        // Validate email format before sending to the server.
        // WHY: surface an invalid email early instead of relying on the generic
        //   "Invalid email or password" from the backend.
        // ---------------------------------------------------------------------
        const nextErrors = { email: "", _form: "" };
        if (!formData.email.trim()) {
            nextErrors.email = "Email is required.";
        } else if (!EMAIL_REGEX.test(formData.email.trim())) {
            nextErrors.email = "Please enter a valid email address (e.g. you@example.com).";
        }
        if (!formData.password) {
            nextErrors._form = "Please enter your password.";
        }
        setErrors(nextErrors);
        if (nextErrors.email || nextErrors._form) {
            return;
        }

        try {
            const response = await api.post("/auth/login", formData);
            if (response.data.success) {
                // Establish the shared session (JWT + /auth/me hydration)
                // before entering the authenticated hub.
                await login(response.data.token);
            }
            // WHY: removed the original alert() success popup; we navigate to the
            //   main hub directly to indicate a successful login.
            navigate("/main");
        } catch (error) {
            // WHY: replaced alert() with an inline error banner for clarity/UX.
            const data = error.response?.data || {};
            if (data.code === "EMAIL_NOT_VERIFIED") {
                // Password correct, email pending: no token issued. Route to
                // the OTP screen instead of leaving the user stuck.
                const pendingEmail = (data.email || formData.email).trim().toLowerCase();
                savePendingEmail(pendingEmail);
                setNeedsVerification(true);
                setErrors((prev) => ({
                    ...prev,
                    _form: "Please verify your email before logging in. Enter the code we sent, or resend it.",
                }));
                return;
            }
            setNeedsVerification(false);
            setErrors((prev) => ({
                ...prev,
                _form: data.message || "Login failed. Please try again.",
            }));
        }
    };

    return (
        <div className="login-page">
            <div className="login-layout">
                <div className="login-panel-left">
                    <button
                        type="button"
                        className="login-brand"
                        onClick={() => navigate("/")}
                    >
                        <span className="login-brand-mark" aria-hidden="true">N</span>
                        NextStep
                    </button>

                    <div className="login-form-wrap">
                        <h1 className="login-title">Log in to your account</h1>
                        <p className="login-signup-line">
                            Don&apos;t have an account?{" "}
                            <button
                                type="button"
                                className="login-signup-line__link"
                                onClick={() => navigate("/signup")}
                            >
                                Sign up
                            </button>
                        </p>

                        <GoogleAuthButton
                            label="Continue with Google"
                            buttonClassName="login-oauth-btn"
                            onError={handleGoogleError}
                        />

                        <div className="login-divider">
                            <span className="login-mono">OR WITH EMAIL AND PASSWORD</span>
                        </div>

                        <form onSubmit={handleSubmit} autoComplete="off">
                            {errors._form && (
                                <div className="login-form-error">
                                    {errors._form}
                                    {needsVerification && (
                                        <button
                                            type="button"
                                            className="login-signup-line__link"
                                            style={{ marginLeft: 8 }}
                                            onClick={() =>
                                                navigate("/verify-email", {
                                                    state: { email: formData.email.trim().toLowerCase() },
                                                })
                                            }
                                        >
                                            Verify now →
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className="login-field">
                                <label className="login-mono" htmlFor="email">
                                    Email address
                                </label>
                                <input
                                    id="email"
                                    type="email"
                                    name="email"
                                    placeholder="you@example.com"
                                    value={formData.email}
                                    onChange={handleChange}
                                    autoComplete="off"
                                    required
                                />
                                {errors.email && (
                                    <p className="login-field__error">{errors.email}</p>
                                )}
                            </div>

                            <div className="login-field">
                                <label className="login-mono" htmlFor="password">
                                    Password
                                </label>
                                <PasswordInput
                                    id="password"
                                    name="password"
                                    placeholder="Enter your password"
                                    value={formData.password}
                                    onChange={handleChange}
                                    autoComplete="current-password"
                                    required
                                />
                            </div>

                            <div className="login-row-between">
                                <label className="login-remember">
                                    <input
                                        type="checkbox"
                                        checked={rememberMe}
                                        onChange={(e) => setRememberMe(e.target.checked)}
                                    />
                                    Remember me
                                </label>
                                <button type="button" className="login-forgot">
                                    Forgot password?
                                </button>
                            </div>

                            <button type="submit" className="login-btn-primary">
                                Log in
                            </button>
                        </form>

                        <p className="login-foot-note">
                            By continuing, you agree to NextStep&apos;s Terms of Service and Privacy
                            Policy.
                        </p>

                        <Spotlight
                            index={spotIndex}
                            onPausedChange={setSpotPaused}
                            onSelect={setSpotIndex}
                            variant="login-spotlight--mobile"
                        />
                    </div>
                </div>

                <div className="login-panel-right">
                    <PromoBackground />

                    <div className="login-promo">
                        <h2>Every exam window, tracked automatically.</h2>
                        <p>
                            Once you&apos;re in, NextStep watches application deadlines for every exam
                            you qualify for and tells you before they close.
                        </p>
                        <Spotlight
                            index={spotIndex}
                            onPausedChange={setSpotPaused}
                            onSelect={setSpotIndex}
                        />
                        <button
                            type="button"
                            className="login-browse"
                            onClick={() => navigate("/")}
                        >
                            Browse supported exams →
                        </button>

                        <div className="login-promo-cards">
                            {PROMO_CHIPS.map((chip) => (
                                <span key={chip} className="login-mini-chip login-mono">
                                    {chip}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Login;
