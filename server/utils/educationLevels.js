// =============================================================================
// EDUCATION LEVELS — server/utils/educationLevels.js
// =============================================================================
// WHY THIS FILE EXISTS:
//   The Exam dataset mixes numeric class levels (8, 10, 12) and qualification
//   labels ("Graduate"), while the User profile sends string values from the
//   frontend ("8", "9", "10", "12", "Graduate", "Post-Graduate", "Doctorate").
//   Comparing these with a MongoDB `$lte` on strings is unsafe because string
//   ordering is lexicographic ("8" > "10" lexicographically), so eligibility
//   checks returned wrong results. This module defines ONE canonical ordered
//   representation (a numeric rank) used by both profile validation and the
//   recommendation filter, in plain JS instead of Mongo string comparison.
// HOW IT'S USED:
//   - normalizeEducationLevel(value) -> canonical string ("8".."12",
//     "Graduate", "Post-Graduate", "Doctorate") or null if unrecognised.
//   - getEducationRank(value) -> numeric rank for ordering, or null.
//   - Bidirectional matching lives in utils/eligibility.js: a user is
//     eligible iff they meet the minimum AND any explicit maximum, or an
//     accepted alternative pathway. Unknown bounds never silently qualify.
// =============================================================================

const EDUCATION_LEVEL_RANK = {
    "8": 8,
    "9": 9,
    "10": 10,
    "11": 11,
    "12": 12,
    // Diploma (post-school vocational/polytechnic) sits above any school
    // class but below a bachelor's degree: a diploma holder meets Class-12
    // bars but NOT Graduate bars, and graduates meet Diploma bars unless an
    // explicit cap says otherwise. Approximation — post-10 vs post-12
    // diplomas are not distinguished (documented limitation).
    "Diploma": 13,
    "Graduate": 15,
    "Post-Graduate": 16,
    "Doctorate": 17,
};

// Graduate and above outrank any school class (8-12). Rank 14 is left unused
// as a gap so a future level could slot in without renumbering.

const ALLOWED_EDUCATION_LEVELS = Object.keys(EDUCATION_LEVEL_RANK);

// Accepts numbers, numeric strings, "Class N" variants and case variations of
// the qualification labels. Returns the canonical key or null.
const normalizeEducationLevel = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
        const asString = String(Math.trunc(value));
        return EDUCATION_LEVEL_RANK[asString] !== undefined ? asString : null;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    // "Class 10" / "class 8" variants.
    const classMatch = trimmed.match(/^class\s+(\d{1,2})$/i);
    if (classMatch) {
        return EDUCATION_LEVEL_RANK[classMatch[1]] !== undefined ? classMatch[1] : null;
    }

    // Bare numeric strings ("8", "10", "12").
    if (/^\d{1,2}$/.test(trimmed)) {
        return EDUCATION_LEVEL_RANK[trimmed] !== undefined ? trimmed : null;
    }

    const lower = trimmed.toLowerCase().replace(/\./g, "");
    if (lower === "diploma" || lower === "polytechnic" || lower === "ug diploma") return "Diploma";
    if (lower === "graduate" || lower === "graduation" || lower === "ug") return "Graduate";
    if (
        lower === "post-graduate" ||
        lower === "postgraduate" ||
        lower === "post graduate" ||
        lower === "pg"
    ) return "Post-Graduate";
    if (lower === "doctorate" || lower === "phd" || lower === "ph d" || lower === "doctorate/phd") {
        return "Doctorate";
    }

    // Exact canonical match (case-insensitive fallback).
    const exact = ALLOWED_EDUCATION_LEVELS.find((level) => level.toLowerCase() === lower);
    return exact || null;
};

const getEducationRank = (value) => {
    const canonical = normalizeEducationLevel(value);
    return canonical === null ? null : EDUCATION_LEVEL_RANK[canonical];
};

const isValidEducationLevel = (value) => normalizeEducationLevel(value) !== null;

module.exports = {
    EDUCATION_LEVEL_RANK,
    ALLOWED_EDUCATION_LEVELS,
    normalizeEducationLevel,
    getEducationRank,
    isValidEducationLevel,
};
