// =============================================================================
// ELIGIBILITY HELPERS — server/utils/eligibility.js
// =============================================================================
// WHY THIS FILE EXISTS:
//   Exam eligibility previously lived as a single MongoDB query inside
//   examController.js that (a) compared education levels with a string `$lte`
//   (wrong for mixed "8"/"10"/"Graduate" data), (b) matched streams with an
//   exact `$in` (so exams marked "Any stream" / "General (all streams)" were
//   incorrectly excluded for every user), and (c) ignored subjects entirely.
//   These pure, unit-testable helpers implement the same eligibility system —
//   no new rules invented — but with correct normalization.
// HOW IT'S USED:
//   - isProfileComplete(profile) -> { complete, missing }. Required for a
//     recommendation request: educationLevel, stream, percentage. Age and
//     subjects are stored/accepted but NOT required for completeness.
//   - filterEligibleExams(exams, profile) -> exams the profile is eligible for.
//   - examMatchesStream / userMatchesExamSubjects are exported for testing.
// =============================================================================

const { normalizeEducationLevel, getEducationRank } = require("./educationLevels");

const CANONICAL_STREAMS = ["Science", "Commerce", "Arts/Humanities"];

// Matches exam stream entries that mean "open to every stream", including the
// variants present in the actual dataset. Entries with extra qualifiers in
// parentheses (e.g. "Any stream (Army wing)") are still all-streams entries —
// the parenthesis only clarifies the academy/wing, it does not restrict the
// school stream. "Any stream with Mathematics" also matches every stream on
// the stream axis; its Mathematics requirement is enforced separately by the
// subject check below.
const ALL_STREAMS_REGEX = /any\s*stream|general\s*\(all\s*streams\)/i;

const normalizeStream = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const exact = CANONICAL_STREAMS.find(
        (stream) => stream.toLowerCase() === trimmed.toLowerCase()
    );
    return exact || null;
};

const isValidStream = (value) => normalizeStream(value) !== null;

// NULL SEMANTICS (flexible-eligibility redesign): a null/undefined/empty
// exam criterion means "no confirmed requirement" — the check is SKIPPED
// (pass), never treated as "nobody eligible", "everybody eligible", or a
// wildcard match. Rationale: an exam must not be rejected for a rule nobody
// evidenced, and must not gain false specificity from one either.
const hasUsableListRequirement = (value) => {
    return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim() !== "");
};

const examMatchesStream = (examStreams, userStream) => {
    // No confirmed stream requirement -> criterion not evaluated (pass).
    if (!hasUsableListRequirement(examStreams)) return true;
    const canonicalUserStream = normalizeStream(userStream);
    if (!canonicalUserStream) return false;
    const userLower = canonicalUserStream.toLowerCase();
    return examStreams.some((entry) => {
        if (typeof entry !== "string") return false;
        const trimmed = entry.trim();
        if (!trimmed) return false;
        if (trimmed.toLowerCase() === userLower) return true;
        if (ALL_STREAMS_REGEX.test(trimmed)) return true;
        return false;
    });
};

// -----------------------------------------------------------------------------
// Subjects
// HOW: User subjects are atomic school subjects from the profile form
//   ("Physics", "Accountancy", ...). Exam `subjects` are a mix of atomic names
//   ("Physics"), composite entries ("Mathematics/Biology",
//   "General Ability Test (English + GK)") and generic aptitude topics
//   ("Logical Reasoning"). We tokenize exam subjects, detect which tokens name
//   a real school subject (via the canonical list + aliases), and require at
//   least one overlap with the user's subjects — but ONLY when both sides
//   carry usable data. Exams with no school-subject content skip the check,
//   and users who listed no subjects are never excluded by it.
// -----------------------------------------------------------------------------

// Canonical school subjects (lowercased) matching the profile form options,
// plus aliases for spelling variants used in the exam dataset.
const SUBJECT_ALIAS_TO_CANONICAL = {
    physics: "physics",
    chemistry: "chemistry",
    mathematics: "mathematics",
    maths: "mathematics",
    math: "mathematics",
    biology: "biology",
    botany: "biology",
    zoology: "biology",
    biotechnology: "biology",
    english: "english",
    hindi: "hindi",
    sanskrit: "sanskrit",
    history: "history",
    geography: "geography",
    "political science": "political science",
    economics: "economics",
    accountancy: "accountancy",
    accounting: "accountancy",
    "business studies": "business studies",
    "computer science": "computer science",
    "physical education": "physical education",
    psychology: "psychology",
    sociology: "sociology",
    philosophy: "philosophy",
    "fine arts": "fine arts",
    "home science": "home science",
    "legal studies": "legal studies",
    entrepreneurship: "entrepreneurship",
    "general knowledge": "general knowledge",
    gk: "general knowledge",
    "environmental science": "environmental science",
    "information technology": "information technology",
    "artificial intelligence": "artificial intelligence",
    "data science": "data science",
    "engineering graphics": "engineering graphics",
    agriculture: "agriculture",
    marketing: "marketing",
    "fashion studies": "fashion studies",
    music: "music",
    dance: "dance",
    "informatics practices": "informatics practices",
    "applied mathematics": "applied mathematics",
    statistics: "statistics",
    "business mathematics": "business mathematics",
    "mass media studies": "mass media studies",
    journalism: "journalism",
    anthropology: "anthropology",
    "public administration": "public administration",
    "regional languages": "regional languages",
    "social science": "social science",
    civics: "civics",
    "work experience": "work experience",
    "web application development": "web application development",
    ites: "it/ites",
    retail: "retail",
    tourism: "tourism",
    beauty: "beauty & wellness",
    wellness: "beauty & wellness",
    "food production": "food production",
    banking: "banking & insurance",
    insurance: "banking & insurance",
    "design thinking": "design thinking & innovation",
    "financial markets management": "financial markets management",
    yoga: "yoga",
    french: "french",
    german: "german",
    spanish: "spanish",
    marathi: "marathi",
    gujarati: "gujarati",
    punjabi: "punjabi",
    kannada: "kannada",
    malayalam: "malayalam",
    odia: "odia",
    assamese: "assamese",
    urdu: "urdu",
    "art education": "art education",
    "health education": "health education",
};

const canonicalizeSubject = (value) => {
    if (typeof value !== "string") return null;
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    return SUBJECT_ALIAS_TO_CANONICAL[lower] || lower;
};

const normalizeUserSubjects = (subjects) => {
    if (!Array.isArray(subjects)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of subjects) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
};

// Split composite exam subject strings into searchable tokens.
const tokenizeExamSubject = (subject) => {
    return String(subject)
        .split(/[\/;,+&()]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
};

// School-subject phrases named by one exam (canonical keys), including subject
// requirements implied by qualified all-streams entries such as
// "Any stream with Mathematics".
const examSchoolSubjects = (exam) => {
    const found = new Set();
    const subjects = Array.isArray(exam.subjects) ? exam.subjects : [];
    for (const subject of subjects) {
        if (typeof subject !== "string") continue;
        for (const token of tokenizeExamSubject(subject)) {
            for (const alias of Object.keys(SUBJECT_ALIAS_TO_CANONICAL)) {
                if (token.includes(alias)) {
                    found.add(SUBJECT_ALIAS_TO_CANONICAL[alias]);
                }
            }
        }
    }
    const streams = Array.isArray(exam.streams) ? exam.streams : [];
    for (const entry of streams) {
        if (typeof entry !== "string") continue;
        const withMatch = entry.match(/with\s+([a-z\s./+&(),-]+)/i);
        if (withMatch) {
            for (const token of tokenizeExamSubject(withMatch[1])) {
                for (const alias of Object.keys(SUBJECT_ALIAS_TO_CANONICAL)) {
                    if (token.includes(alias)) {
                        found.add(SUBJECT_ALIAS_TO_CANONICAL[alias]);
                    }
                }
            }
        }
    }
    return [...found];
};

const userMatchesExamSubjects = (userSubjects, exam) => {
    // No confirmed subject requirement (null/empty/unusable) -> pass.
    // examSchoolSubjects already yields [] for such exams; the explicit
    // early return below documents the null contract in one place.
    const rawSubjects = exam ? exam.subjects : null;
    const rawStreams = exam ? exam.streams : null;
    if (!hasUsableListRequirement(rawSubjects) && !hasUsableListRequirement(rawStreams)) return true;
    const required = examSchoolSubjects(exam);
    if (required.length === 0) return true; // exam names no school subject -> N/A
    const normalized = normalizeUserSubjects(userSubjects);
    if (normalized.length === 0) return true; // user listed none -> do not exclude
    const userCanonical = new Set(
        normalized.map(canonicalizeSubject).filter(Boolean)
    );
    return required.some((subject) => userCanonical.has(subject));
};

// -----------------------------------------------------------------------------
// Profile completeness
// Required: educationLevel (recognised), stream (recognised),
// percentage (number 0-100). Age and subjects are accepted/stored but never
// required here, per Phase 1 spec.
// -----------------------------------------------------------------------------
const isProfileComplete = (profile) => {
    const missing = [];
    const source = profile && typeof profile === "object" ? profile : {};
    if (normalizeEducationLevel(source.educationLevel) === null) {
        missing.push("educationLevel");
    }
    if (normalizeStream(source.stream) === null) {
        missing.push("stream");
    }
    const percentage =
        source.percentage === "" || source.percentage === undefined || source.percentage === null
            ? null
            : Number(source.percentage);
    if (
        percentage === null ||
        !Number.isFinite(percentage) ||
        percentage < 0 ||
        percentage > 100
    ) {
        missing.push("percentage");
    }
    return { complete: missing.length === 0, missing };
};

const examMatchesEducation = (exam, userEducationLevel) => {
    // exam: exam-like object { minimumEducationLevel, maximumEducationLevel,
    //   noUpperEducationLimit, alternativeQualifications }. Preferred form —
    //   enforces the range in BOTH directions (see describeEducation below).
    // Legacy scalar form (a bare minimum level) keeps minimum-only semantics
    // for backward compatibility with older callers; all endpoints use the
    // object form via isEligibleForExam.
    if (exam === null || exam === undefined || typeof exam !== "object") {
        const examRank = getEducationRank(exam);
        if (examRank === null) return true;
        const userRank = getEducationRank(userEducationLevel);
        if (userRank === null) return false;
        return userRank >= examRank;
    }
    const described = describeEducationEligibility(exam);
    if (described.state === "CONTRADICTORY" || described.state === "UNKNOWN") return false;
    const userRank = getEducationRank(userEducationLevel);
    if (userRank === null) return false;
    // Minimum side: below the bar is out, unless an explicitly accepted
    // alternative pathway covers the student's own level.
    if (described.minRank !== null && userRank < described.minRank) {
        const canonicalUser = normalizeEducationLevel(userEducationLevel);
        if (!canonicalUser || !described.alternatives.includes(canonicalUser)) return false;
    }
    // Maximum side: above an explicit cap is out. Alternatives never override
    // a cap (pathways widen entry, they do not lift ceilings).
    if (described.maxRank !== null && userRank > described.maxRank) return false;
    return true;
};

// Classifies an exam's education requirements WITHOUT deciding eligibility:
//   BOUNDED  — min and/or max known (unknown side defaults only when the
//              other side is explicit: min-only needs noUpperEducationLimit,
//              max-only needs no minimum... see below).
//   OPEN     — a known floor with an explicitly unrestricted upper
//              (noUpperEducationLimit === true).
//   UNKNOWN  — no evaluable floor (no known minimum AND no usable
//              alternative pathways) or no explicit upper semantics.
//   CONTRADICTORY — min and max both known but max ranks below min.
// A missing maximum is NEVER read as "everyone eligible" or "nobody
// eligible": it is UNKNOWN unless noUpperEducationLimit is explicitly true.
const describeEducationEligibility = (exam) => {
    const source = exam && typeof exam === "object" ? exam : {};
    const minRank = getEducationRank(source.minimumEducationLevel);
    const maxRank = getEducationRank(source.maximumEducationLevel);
    const upperOpen = source.noUpperEducationLimit === true;
    const alternatives = normalizeAlternativeQualifications(source.alternativeQualifications);
    const minKnown = minRank !== null;
    const maxKnown = maxRank !== null;
    if (minKnown && maxKnown && maxRank < minRank) {
        return { state: "CONTRADICTORY", minRank, maxRank, upperOpen, alternatives };
    }
    // Evaluable floor: a known minimum, or usable alternative pathways.
    if (!minKnown && alternatives.length === 0) {
        return { state: "UNKNOWN", minRank, maxRank, upperOpen, alternatives };
    }
    // Upper side must be explicit: a known cap, or an explicit "no cap".
    if (!maxKnown && !upperOpen) {
        return { state: "UNKNOWN", minRank, maxRank, upperOpen, alternatives };
    }
    if (maxKnown) {
        return { state: "BOUNDED", minRank, maxRank, upperOpen, alternatives };
    }
    return { state: "OPEN", minRank, maxRank, upperOpen, alternatives };
};

// Canonical alternative levels accepted as entry pathways (e.g. Diploma for
// lateral-entry exams). Unrecognized entries are dropped for evaluation —
// free-text nuance stays in customEligibility/display, never in matching.
const normalizeAlternativeQualifications = (value) => {
    const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const canonical = normalizeEducationLevel(entry);
        if (canonical === null) continue;
        if (!seen.has(canonical)) {
            seen.add(canonical);
            out.push(canonical);
        }
    }
    return out;
};

const examMatchesPercentage = (exam, userPercentage) => {
    const required =
        exam && exam.eligibility && exam.eligibility.minimumPercentage;
    if (required === undefined || required === null) return true;
    const percentage = Number(userPercentage);
    if (!Number.isFinite(percentage)) return false;
    return percentage >= Number(required);
};

const examMatchesAge = (exam, userAge) => {
    const minimumAge = exam ? exam.minimumAge : null;
    const maximumAge = exam ? exam.maximumAge : null;
    // No confirmed age bounds -> criterion not evaluated (pass).
    if ((minimumAge === undefined || minimumAge === null) &&
        (maximumAge === undefined || maximumAge === null)) return true;
    // Age is optional on the profile: without a verified age the user cannot
    // satisfy an age-gated exam, so it is excluded (other exams still match).
    if (userAge === undefined || userAge === null || userAge === "") return false;
    const age = Number(userAge);
    if (!Number.isFinite(age)) return false;
    if (minimumAge !== undefined && minimumAge !== null && age < Number(minimumAge)) return false;
    if (maximumAge !== undefined && maximumAge !== null && age > Number(maximumAge)) return false;
    return true;
};

// -----------------------------------------------------------------------------
// Age from date of birth
// HOW: calculateAgeFromDOB() derives full years from a stored DOB against a
//   reference date (defaults to now, injectable for tests). getAgeFromProfile()
//   prefers profile.dateOfBirth — the source of truth — and falls back to the
//   legacy numeric profile.age so documents written before DOB existed still
//   evaluate. Returns a number or null when no usable age exists.
// WHY: The profile form collects DOB via a calendar, never a typed age, so
//   eligibility must compute age dynamically instead of trusting a stored one.
// -----------------------------------------------------------------------------
const calculateAgeFromDOB = (dateOfBirth, now = new Date()) => {
    const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) return null;
    const ref = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(ref.getTime()) || dob > ref) return null;
    let age = ref.getFullYear() - dob.getFullYear();
    const hadBirthday =
        ref.getMonth() > dob.getMonth() ||
        (ref.getMonth() === dob.getMonth() && ref.getDate() >= dob.getDate());
    if (!hadBirthday) age -= 1;
    return age;
};

const getAgeFromProfile = (profile, now = new Date()) => {
    const source = profile && typeof profile === "object" ? profile : {};
    if (source.dateOfBirth !== undefined && source.dateOfBirth !== null && source.dateOfBirth !== "") {
        const derived = calculateAgeFromDOB(source.dateOfBirth, now);
        if (derived !== null) return derived;
    }
    if (source.age !== undefined && source.age !== null && source.age !== "") {
        const legacy = Number(source.age);
        if (Number.isFinite(legacy)) return legacy;
    }
    return null;
};

const isEligibleForExam = (exam, profile) => {
    // NOTE: only the core structured criteria gate eligibility (education,
    // stream, percentage, age bounds, subjects). Extended common fields
    // (eligibility.nationality, domicile, ...) and customEligibility entries
    // are display-only until a future implementation wires them in — they
    // must never silently filter anyone out.
    if (!exam || !profile) return false;
    // Education is evaluated bidirectionally from the whole exam record
    // (minimum AND maximum/alternatives) — never minimum-only.
    if (!examMatchesEducation(exam, profile.educationLevel)) return false;
    if (!examMatchesStream(exam.streams, profile.stream)) return false;
    if (!examMatchesPercentage(exam, profile.percentage)) return false;
    if (!examMatchesAge(exam, getAgeFromProfile(profile))) return false;
    if (!userMatchesExamSubjects(profile.subjects, exam)) return false;
    return true;
};

const filterEligibleExams = (exams, profile) => {
    if (!Array.isArray(exams)) return [];
    return exams.filter((exam) => isEligibleForExam(exam, profile));
};

module.exports = {
    CANONICAL_STREAMS,
    normalizeStream,
    isValidStream,
    hasUsableListRequirement,
    examMatchesStream,
    normalizeUserSubjects,
    canonicalizeSubject,
    examSchoolSubjects,
    userMatchesExamSubjects,
    isProfileComplete,
    examMatchesEducation,
    describeEducationEligibility,
    normalizeAlternativeQualifications,
    examMatchesPercentage,
    examMatchesAge,
    calculateAgeFromDOB,
    getAgeFromProfile,
    isEligibleForExam,
    filterEligibleExams,
};
