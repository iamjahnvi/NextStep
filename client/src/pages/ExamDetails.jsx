import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import api from "../services/api";
import { useAuth } from "../context/useAuth";
import { useTheme } from "../lib/useTheme";
import ProfileMenu from "../components/ProfileMenu";
import ThemeToggle from "../components/ThemeToggle";
import {
    CAREER_TYPE_OPTIONS,
    EXAM_TYPE_OPTIONS,
} from "../constants/discoveryOptions";
import "./MainPage.css";
import "./ExamDetails.css";

// -----------------------------------------------------------------------------
// ExamDetails — individual exam page.
// Layout takes inspiration from exam-detail.html (Claude mock): hero header
// with monogram + pills, Eligibility card, Registration card, and a right
// "At a glance / Your progress" rail. The top navbar is intentionally the
// same dx-topbar used on MainPage so navigation stays consistent.
// -----------------------------------------------------------------------------

const SAVED_KEY = "nextstep:savedExams";

function loadSaved() {
    try {
        const raw = localStorage.getItem(SAVED_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function completeness(profile) {
    if (!profile) return 0;
    const parts = [
        profile.educationLevel,
        profile.stream,
        profile.percentage,
        profile.dateOfBirth,
        profile.gender,
        Array.isArray(profile.subjects) && profile.subjects.length > 0 ? "x" : "",
    ];
    const filled = parts.filter((v) => v !== undefined && v !== null && v !== "").length;
    return Math.round((filled / parts.length) * 100);
}

// Canonical status, mirroring server/utils/discovery.js getApplicationStatus:
// start <= now <= end -> Open; now < start -> Opening Soon; now > end -> Closed.
function getRegistrationStatus(start, end) {
    const now = new Date();
    const s = start ? new Date(start) : null;
    const e = end ? new Date(end) : null;
    if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "Closed";
    if (now < s) return "Opening Soon";
    if (now <= e) return "Open";
    return "Closed";
}

function formatDate(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

function shortDate(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function examInitials(exam) {
    const words = String(exam?.name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

function careerLabel(value) {
    const found = CAREER_TYPE_OPTIONS.find((o) => o.value === value);
    return found ? found.label : value || "—";
}

function examTypeLabel(value) {
    const found = EXAM_TYPE_OPTIONS.find((o) => o.value === value);
    return found ? found.label : value || "—";
}

// -----------------------------------------------------------------------------
// Nullable-eligibility display (flexible-eligibility redesign).
// Backend null means "no confirmed value" — never render a fabricated
// requirement ("All streams", "Science", "Other"). Human-readable fallbacks.
// Education renders bidirectionally: an explicit cap shows as a range
// ("Class 8 – Class 12") or a single class ("Class 10"); an explicitly open
// upper side keeps the "+" suffix. Unknown uppers fall back to the
// minimum-only label (matching excludes those exams conservatively — the
// label never invents a cap).
// -----------------------------------------------------------------------------
function educationLevelName(value) {
    if (value === undefined || value === null || value === "") return null;
    if (
        value === "Graduate" ||
        value === "Post-Graduate" ||
        value === "Doctorate" ||
        value === "Diploma"
    ) return value;
    return `Class ${value}`;
}

function educationRangeLabel(exam) {
    const min = educationLevelName(exam?.minimumEducationLevel);
    const max = educationLevelName(exam?.maximumEducationLevel);
    const alts = Array.isArray(exam?.alternativeQualifications)
        ? exam.alternativeQualifications.map(educationLevelName).filter(Boolean)
        : [];
    let main = null;
    if (min && max) {
        main = min === max ? min : `${min} – ${max}`;
    } else if (min) {
        main = `${min}+`;
    } else if (max) {
        main = `Up to ${max}`;
    }
    if (!main) return null;
    if (alts.length > 0) return `${main} (or ${alts.join(", ")})`;
    return main;
}

function ageLabel(value) {
    if (value === undefined || value === null || value === "") return null;
    return `${value} years`;
}

function sourceBadge(source) {
    if (source === "MANUAL") return "Manual";
    if (source === "SCRAPER") return "Scraper";
    if (source === "SEED") return "Dataset";
    return null;
}

// Extended common eligibility fields worth showing when a record carries
// them. Key = backend path under exam.eligibility, label = human row label.
const EXTENDED_ELIGIBILITY_ROWS = [
    ["requiredQualification", "Required qualification"],
    ["qualifyingExam", "Qualifying exam"],
    ["degreeRequirements", "Degree requirements"],
    ["yearOfStudy", "Year of study"],
    ["graduationYear", "Graduation year"],
    ["attemptsAllowed", "Attempts allowed"],
    ["nationality", "Nationality"],
    ["domicile", "Domicile"],
    ["workExperience", "Work experience"],
    ["professionalRegistration", "Professional registration"],
    ["institutionRequirement", "Institution requirement"],
    ["genderEligibility", "Gender eligibility"],
    ["ageRelaxation", "Age relaxation"],
    ["categoryRelaxation", "Category relaxation"],
    ["otherEligibility", "Other eligibility"],
];

function formatEligibilityValue(value) {
    if (value === undefined || value === null || value === "") return null;
    if (Array.isArray(value)) {
        const items = value.filter((v) => typeof v === "string" && v.trim() !== "");
        return items.length > 0 ? items.join(", ") : null;
    }
    return String(value);
}

function statusMeta(status) {
    if (status === "Open") return { label: "Registration Open", pill: "Registration Open", cls: "open" };
    if (status === "Opening Soon") return { label: "Upcoming", pill: "Upcoming", cls: "upcoming" };
    return { label: "Registration Closed", pill: "Registration Closed", cls: "closed" };
}

function IconSearch() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
    );
}

function IconBell() {
    return (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
            <path d="M10 19a2.2 2.2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconBookmark({ filled }) {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
            <path
                d="M6.5 4.5h11a.5.5 0 0 1 .5.5v14.1a.4.4 0 0 1-.63.33L12 15.7l-5.37 3.73a.4.4 0 0 1-.63-.33V5a.5.5 0 0 1 .5-.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconShare() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M7 17 17 7M9 7h8v8"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ExamDetails() {
    const navigate = useNavigate();
    const { id } = useParams();
    const { user } = useAuth();
    const { theme, toggleTheme } = useTheme();
    const [exam, setExam] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [savedMap, setSavedMap] = useState(loadSaved);
    const [shared, setShared] = useState(false);

    useEffect(() => {
        const fetchExam = async () => {
            setLoading(true);
            setError("");
            try {
                const response = await api.get(`/exams/${id}`);
                if (response.data.success) {
                    setExam(response.data.data);
                }
            } catch (err) {
                setError(err.response?.data?.message || "Failed to load exam details.");
            } finally {
                setLoading(false);
            }
        };

        fetchExam();
    }, [id]);

    useEffect(() => {
        try {
            localStorage.setItem(SAVED_KEY, JSON.stringify(savedMap));
        } catch {
            /* storage full / private mode — saved marks just won't persist */
        }
    }, [savedMap]);

    const goMain = (view) => {
        navigate("/main", view ? { state: { view } } : undefined);
    };

    if (loading) {
        return (
            <div className={`dx-page${theme === "dark" ? " dx-page--dark" : ""}`}>
                <header className="dx-topbar">
                    <div className="dx-topbar__inner">
                        <button type="button" className="dx-brand" onClick={() => goMain()}>
                            <span className="dx-brand__mark">N</span>
                            NextStep
                        </button>
                    </div>
                </header>
                <div className="ed-layout">
                    <div className="dx-state" aria-label="Loading exam details">
                        <h2>Loading exam…</h2>
                        <p>Fetching the details for this exam.</p>
                    </div>
                </div>
            </div>
        );
    }

    if (!exam) {
        return (
            <div className={`dx-page${theme === "dark" ? " dx-page--dark" : ""}`}>
                <header className="dx-topbar">
                    <div className="dx-topbar__inner">
                        <button type="button" className="dx-brand" onClick={() => goMain()}>
                            <span className="dx-brand__mark">N</span>
                            NextStep
                        </button>
                    </div>
                </header>
                <div className="ed-layout">
                    <div className="dx-state" role="alert">
                        <h2>Something went wrong.</h2>
                        <p>{error || "Exam not found."}</p>
                        <button type="button" className="dx-btn-dark" onClick={() => goMain()}>
                            Back to discovery
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const status = getRegistrationStatus(exam.registrationStartDate, exam.registrationEndDate);
    const meta = statusMeta(status);
    const isSaved = Boolean(savedMap[exam._id]);
    const pct = completeness(user?.profile);
    const classLabel = educationRangeLabel(exam) || "No education requirement";
    const streamLabel = Array.isArray(exam.streams) && exam.streams.length > 0
        ? exam.streams.join(" · ")
        : "No stream requirement";

    const toggleSaved = () => {
        setSavedMap((prev) => {
            const next = { ...prev };
            if (next[exam._id]) delete next[exam._id];
            else next[exam._id] = exam;
            return next;
        });
    };

    const handleShare = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            setShared(true);
            setTimeout(() => setShared(false), 2000);
        } catch {
            setShared(false);
        }
    };

    return (
        <div className={`dx-page${theme === "dark" ? " dx-page--dark" : ""}`}>
            {/* ---- top bar (same as MainPage for consistency) ---- */}
            <header className="dx-topbar">
                <div className="dx-topbar__inner">
                    <button type="button" className="dx-brand" onClick={() => goMain()}>
                        <span className="dx-brand__mark">N</span>
                        NextStep
                    </button>
                    <nav className="dx-tabs" aria-label="Primary">
                        {[
                            ["discover", "Discover"],
                            ["matches", "My Matches"],
                            ["saved", "Saved"],
                            ["resources", "Resources"],
                        ].map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                className="dx-tab"
                                onClick={() => goMain(key)}
                            >
                                {label}
                                {key === "saved" && Object.keys(savedMap).length > 0 && (
                                    <span className="dx-tab-count">{Object.keys(savedMap).length}</span>
                                )}
                            </button>
                        ))}
                    </nav>
                    <div className="dx-topsearch" role="search">
                        <input
                            type="search"
                            placeholder="Search exams, olympiads, or keywords…"
                            aria-label="Search exams"
                            onKeyDown={(e) => {
                                if (e.key === "Enter") goMain("discover");
                            }}
                        />
                        <span className="dx-topsearch__icon" aria-hidden="true">
                            <IconSearch />
                        </span>
                    </div>
                    <div className="dx-topactions">
                    <button type="button" className="dx-bell" aria-label="Notifications">
                        <IconBell />
                        <span className="dx-bell__dot" aria-hidden="true" />
                    </button>
                    <ThemeToggle theme={theme} onToggle={toggleTheme} />
                    <ProfileMenu completeness={pct} />
                    </div>
                </div>
            </header>

            <div className="ed-wrap">
                <button type="button" className="ed-breadcrumb" onClick={() => goMain()}>
                    <span aria-hidden="true">←</span> Back to discovery
                </button>

                <div className="ed-layout">
                {/* ---- main column ---- */}
                <div className="ed-main">

                    <section className="ed-hero" aria-label={`${exam.name} overview`}>
                        <div className="ed-hero__top">
                            <div className="ed-hero__id">
                                <div className="ed-badge" aria-hidden="true">
                                    {examInitials(exam)}
                                </div>
                                <div>
                                    <h1 className="ed-hero__title">{exam.name}</h1>
                                    {exam.fullForm && (
                                        <p className="ed-hero__fullname">{exam.fullForm}</p>
                                    )}
                                </div>
                            </div>
                            <div className="ed-hero__actions">
                                <button
                                    type="button"
                                    className={`ed-iconbtn${isSaved ? " is-saved" : ""}`}
                                    onClick={toggleSaved}
                                    aria-label={isSaved ? `Remove ${exam.name} from saved` : `Save ${exam.name}`}
                                    aria-pressed={isSaved}
                                    title={isSaved ? "Saved" : "Save"}
                                >
                                    <IconBookmark filled={isSaved} />
                                </button>
                                <button
                                    type="button"
                                    className="ed-iconbtn"
                                    onClick={handleShare}
                                    aria-label="Copy link to this exam"
                                    title={shared ? "Link copied!" : "Share"}
                                >
                                    <IconShare />
                                </button>
                            </div>
                        </div>

                        {exam.description && (
                            <p className="ed-hero__desc">{exam.description}</p>
                        )}

                        <div className="ed-pills">
                            <span className="ed-pill ed-pill--neutral">{streamLabel}</span>
                            <span className="ed-pill ed-pill--neutral">{classLabel}</span>
                            <span className={`ed-pill ed-pill--${meta.cls}`}>
                                <span className="ed-pill__dot" aria-hidden="true" />
                                {meta.pill}
                            </span>
                        </div>
                    </section>

                    <section className="ed-card" aria-label="Eligibility">
                        <h2 className="ed-card__title">Eligibility</h2>
                        <p className="ed-card__sub">What you need to qualify for this exam</p>
                        <div className="ed-info-grid">
                            <div className="ed-info">
                                <p className="ed-info__label">Stream</p>
                                <p className="ed-info__value">
                                    {Array.isArray(exam.streams) && exam.streams.length > 0
                                        ? exam.streams.join(", ")
                                        : "No stream requirement specified"}
                                </p>
                            </div>
                            <div className="ed-info">
                                <p className="ed-info__label">Education Level</p>
                                <p className="ed-info__value">
                                    {educationRangeLabel(exam) ||
                                        "No education requirement specified"}
                                </p>
                            </div>
                            <div className="ed-info">
                                <p className="ed-info__label">Minimum Percentage</p>
                                <p className="ed-info__value">
                                    {exam.eligibility?.minimumPercentage ?? "No minimum percentage specified"}
                                    {exam.eligibility?.minimumPercentage != null ? "%" : ""}
                                </p>
                            </div>
                            <div className="ed-info">
                                <p className="ed-info__label">Minimum Age</p>
                                <p className="ed-info__value">
                                    {ageLabel(exam.minimumAge) || "No minimum age specified"}
                                </p>
                            </div>
                            <div className="ed-info">
                                <p className="ed-info__label">Maximum Age</p>
                                <p className="ed-info__value">
                                    {ageLabel(exam.maximumAge) || "No maximum age specified"}
                                </p>
                            </div>
                            <div className="ed-info ed-info--full">
                                <p className="ed-info__label">Subjects</p>
                                {Array.isArray(exam.subjects) && exam.subjects.length > 0 ? (
                                    <div className="ed-tags">
                                        {exam.subjects.map((subject) => (
                                            <span key={subject} className="ed-tag">
                                                {subject}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="ed-info__value">No subject requirement specified</p>
                                )}
                            </div>
                            {EXTENDED_ELIGIBILITY_ROWS.filter(
                                ([key]) => formatEligibilityValue(exam.eligibility?.[key]) !== null
                            ).map(([key, label]) => (
                                <div className="ed-info" key={key}>
                                    <p className="ed-info__label">{label}</p>
                                    <p className="ed-info__value">
                                        {formatEligibilityValue(exam.eligibility?.[key])}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </section>

                    {Array.isArray(exam.customEligibility) && exam.customEligibility.length > 0 && (
                        <section className="ed-card" aria-label="Additional eligibility criteria">
                            <h2 className="ed-card__title">Additional Criteria</h2>
                            <p className="ed-card__sub">Further requirements for this exam</p>
                            <div className="ed-info-grid">
                                {exam.customEligibility.map((criterion) => (
                                    <div className="ed-info" key={criterion.key}>
                                        <p className="ed-info__label">
                                            {criterion.label}
                                            {sourceBadge(criterion.source) && (
                                                <span className="ed-tag" style={{ marginLeft: 8 }}>
                                                    {sourceBadge(criterion.source)}
                                                </span>
                                            )}
                                        </p>
                                        <p className="ed-info__value">{criterion.value}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="ed-card" aria-label="Registration details">
                        <h2 className="ed-card__title">Registration Details</h2>
                        <p className="ed-card__sub">Key dates for this admission cycle</p>
                        <div className="ed-reg-list">
                            <div className="ed-reg-row">
                                <span className="ed-reg-row__label">Start Date</span>
                                <span className="ed-reg-row__value">{formatDate(exam.registrationStartDate)}</span>
                            </div>
                            <div className="ed-reg-row">
                                <span className="ed-reg-row__label">End Date</span>
                                <span className="ed-reg-row__value">{formatDate(exam.registrationEndDate)}</span>
                            </div>
                            <div className="ed-reg-row">
                                <span className="ed-reg-row__label">Registration Status</span>
                                <span className={`ed-status ed-status--${meta.cls}`}>
                                    <span className="ed-status__dot" aria-hidden="true" />
                                    {status}
                                </span>
                            </div>
                        </div>

                        <div className="ed-cta">
                            {exam.officialWebsite && (
                                <a
                                    className="dx-btn-dark ed-cta__primary"
                                    href={exam.officialWebsite}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Visit official website <span className="ed-cta__arrow" aria-hidden="true">↗</span>
                                </a>
                            )}
                            <button type="button" className="dx-btn-ghost ed-cta__back" onClick={() => goMain()}>
                                <span className="ed-cta__arrow ed-cta__arrow--left" aria-hidden="true">←</span> Back to discovery
                            </button>
                        </div>
                    </section>
                </div>

                {/* ---- right rail ---- */}
                <div className="ed-side">
                    <section className="ed-card ed-card--tight" aria-label="At a glance">
                        <h2 className="ed-rail__title">At a glance</h2>
                        <div className="ed-rail__row">
                            <span className="ed-rail__label">Career type</span>
                            <span className="ed-rail__val">{careerLabel(exam.careerType)}</span>
                        </div>
                        <div className="ed-rail__row">
                            <span className="ed-rail__label">Exam type</span>
                            <span className="ed-rail__val">{examTypeLabel(exam.examType)}</span>
                        </div>
                        <div className="ed-rail__row">
                            <span className="ed-rail__label">Education required</span>
                            <span className="ed-rail__val">
                                {educationRangeLabel(exam) || "—"}
                            </span>
                        </div>
                        <div className="ed-rail__row">
                            <span className="ed-rail__label">Application window</span>
                            <span className="ed-rail__val">{shortDate(exam.registrationEndDate)}</span>
                        </div>
                    </section>

                    <section className="ed-card ed-card--tight" aria-label="Your progress">
                        <h2 className="ed-rail__title">Your progress</h2>
                        <div className="ed-track">
                            <span
                                className={`ed-track__dot${pct >= 100 ? "" : " is-pending"}`}
                                aria-hidden="true"
                            />
                            <span className="ed-track__text">
                                {pct >= 100
                                    ? "Profile eligible for this exam"
                                    : "Complete your profile to check eligibility"}
                            </span>
                        </div>
                        <div className="ed-track">
                            <span
                                className={`ed-track__dot${isSaved ? "" : " is-pending"}`}
                                aria-hidden="true"
                            />
                            <span className="ed-track__text">
                                {isSaved ? "Saved to your list" : "Not saved yet"}
                            </span>
                        </div>
                        <div className="ed-track">
                            <span
                                className={`ed-track__dot${status === "Closed" ? " is-pending" : ""}`}
                                aria-hidden="true"
                            />
                            <span className="ed-track__text">
                                Registration window — {status.toLowerCase()}
                            </span>
                        </div>
                    </section>
                </div>
                </div>
            </div>
        </div>
    );
}

export default ExamDetails;
