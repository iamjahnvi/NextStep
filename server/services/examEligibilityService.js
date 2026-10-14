// =============================================================================
// MANUAL ELIGIBILITY SERVICE — server/services/examEligibilityService.js
// =============================================================================
// WHAT: The smallest safe backend layer for human/operator corrections to
//   exam eligibility. NextStep has no admin dashboard; scraper adjudication
//   only fixes staging drafts. This module lets an operator correct a
//   PRODUCTION Exam record without touching anything else.
// WHY: Automated extraction cannot reliably identify every criterion (see the
//   GATE evidence audit: degree-level exams carry no school streams/subjects
//   at all). Humans must be able to add/correct values — and those values
//   must stay distinguishable from scraper/seed data forever.
// CONTRACT (pure document mutation — no DB I/O here, callers save):
//   applyManualEligibility(examDoc, { field, value, updatedBy, note })
//     field: "streams" | "subjects" | "minimumAge" | "maximumAge" |
//            "minimumEducationLevel" | "maximumEducationLevel" |
//            "noUpperEducationLimit" | "alternativeQualifications" |
//            "description" | "eligibility.<commonField>" (see MANUAL_ELIGIBILITY_FIELDS).
//     value: the corrected value (null clears back to "no confirmed value").
//     Throws on unknown fields, mistyped values, or unrecognised education
//     levels — UNKNOWN is expressed as null, never as a guessed string.
//     Stamps origin (-> MIXED unless already MANUAL) and appends a manualEdits
//     audit entry. Returns the same doc (unsaved).
//   addCustomEligibility(examDoc, { key, label, value, status?, notes?,
//     updatedBy? }) / updateCustomEligibility / removeCustomEligibility
//     Controlled custom criteria (unique keys enforced by the schema).
//   getFieldProvenance(examDoc, field)
//     -> "MANUAL" if a manual edit covers the field, else examDoc.origin.
// SAFEGUARDS:
//   - The scraper publish executor only ever CREATES new Exam records (one
//     per publish identity) and never updates existing ones — a routine
//     ingestion cannot overwrite manual corrections. This is asserted by the
//     executor's own tests and re-asserted in server/tests.
//   - LLM output is never authoritative here: there is no LLM input to this
//     module at all. Values arrive from the operator call-site only.
// =============================================================================

const { normalizeEducationLevel } = require("../utils/educationLevels");
const { normalizeAlternativeQualifications } = require("../utils/eligibility");

const MANUAL_TOP_LEVEL_FIELDS = [
    "streams",
    "subjects",
    "minimumAge",
    "maximumAge",
    "minimumEducationLevel",
    "maximumEducationLevel",
    "noUpperEducationLimit",
    "alternativeQualifications",
    "description",
];

const MANUAL_ELIGIBILITY_FIELDS = [
    "minimumPercentage",
    "degreeRequirements",
    "requiredQualification",
    "qualifyingExam",
    "graduationYear",
    "yearOfStudy",
    "attemptsAllowed",
    "nationality",
    "domicile",
    "workExperience",
    "professionalRegistration",
    "institutionRequirement",
    "genderEligibility",
    "ageRelaxation",
    "categoryRelaxation",
    "otherEligibility",
];

const MANUAL_CUSTOM_STATUSES = ["CONFIRMED", "NEEDS_VERIFICATION", "NOT_APPLICABLE"];

const splitField = (field) => {
    if (typeof field !== "string") return null;
    const trimmed = field.trim();
    if (trimmed === "") return null;
    if (MANUAL_TOP_LEVEL_FIELDS.includes(trimmed)) return { area: "top", name: trimmed };
    if (trimmed.startsWith("eligibility.")) {
        const name = trimmed.slice("eligibility.".length);
        if (MANUAL_ELIGIBILITY_FIELDS.includes(name)) return { area: "eligibility", name };
    }
    return null;
};

const cleanStringList = (value) => {
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        if (typeof entry !== "string") return null;
        const trimmed = entry.trim();
        if (!trimmed) return null;
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            out.push(trimmed);
        }
    }
    return out.length > 0 ? out : null;
};

// Normalizes one operator-supplied value for a known field. Returns
// { ok, value } — never invents: anything unrecognised is { ok: false }.
const normalizeManualValue = (field, value) => {
    if (value === null || value === undefined) return { ok: true, value: null };

    switch (field) {
        case "streams":
        case "subjects":
        case "degreeRequirements": {
            const cleaned = cleanStringList(value);
            return cleaned ? { ok: true, value: cleaned } : { ok: false };
        }
        case "minimumAge":
        case "maximumAge":
        case "graduationYear":
        case "attemptsAllowed": {
            const num = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
            if (typeof num !== "number" || !Number.isFinite(num)) return { ok: false };
            if (!Number.isInteger(num) || num < 0) return { ok: false };
            if (field === "graduationYear" && (num < 1900 || num > 2100)) return { ok: false };
            return { ok: true, value: num };
        }
        case "minimumPercentage": {
            const num = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
            if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > 100) {
                return { ok: false };
            }
            return { ok: true, value: num };
        }
        case "minimumEducationLevel":
        case "maximumEducationLevel": {
            if (typeof value !== "string" && typeof value !== "number") return { ok: false };
            const canonical = normalizeEducationLevel(value);
            return canonical ? { ok: true, value: canonical } : { ok: false };
        }
        case "noUpperEducationLimit": {
            // Explicit booleans only (plus "true"/"false" strings from forms).
            // null clears back to "not established".
            if (typeof value === "boolean") return { ok: true, value };
            if (typeof value === "string") {
                const lower = value.trim().toLowerCase();
                if (lower === "true") return { ok: true, value: true };
                if (lower === "false") return { ok: true, value: false };
            }
            return { ok: false };
        }
        case "alternativeQualifications": {
            if (!Array.isArray(value)) return { ok: false };
            const canonical = normalizeAlternativeQualifications(value);
            // Every entry must be a recognised canonical level — anything
            // else is rejected, never silently dropped (dropping would hide
            // operator intent). Empty-after-cleaning is only valid as null
            // (clear), not as [].
            const usable = value.filter(
                (entry) => typeof entry === "string" ? entry.trim() !== "" : entry !== null && entry !== undefined
            );
            if (canonical.length !== usable.length) return { ok: false };
            return { ok: true, value: canonical.length > 0 ? canonical : null };
        }
        default: {
            // Free-text common fields: non-empty strings only.
            if (typeof value !== "string" || value.trim() === "") return { ok: false };
            return { ok: true, value: value.trim() };
        }
    }
};

const recordManualEdit = (examDoc, field, updatedBy, note) => {
    if (!Array.isArray(examDoc.manualEdits)) examDoc.manualEdits = [];
    examDoc.manualEdits.push({
        field,
        source: "MANUAL",
        updatedBy: typeof updatedBy === "string" && updatedBy.trim() ? updatedBy.trim() : null,
        note: typeof note === "string" && note.trim() ? note.trim() : null,
        updatedAt: new Date(),
    });
    if (examDoc.origin !== "MANUAL") examDoc.origin = "MIXED";
};

const applyManualEligibility = (examDoc, { field, value, updatedBy = null, note = null } = {}) => {
    if (!examDoc || typeof examDoc !== "object") {
        throw new Error("applyManualEligibility: an exam document is required");
    }
    const slot = splitField(field);
    if (!slot) {
        throw new Error(
            `applyManualEligibility: unknown field '${field}' (use a common eligibility field or the custom-eligibility helpers)`
        );
    }
    const canonicalField = slot.area === "eligibility" ? `eligibility.${slot.name}` : slot.name;
    const normalized = normalizeManualValue(slot.name, value);
    if (!normalized.ok) {
        throw new Error(
            `applyManualEligibility: invalid value for '${canonicalField}' (use null to clear back to "no confirmed value")`
        );
    }
    if (slot.area === "eligibility") {
        if (!examDoc.eligibility || typeof examDoc.eligibility !== "object") examDoc.eligibility = {};
        examDoc.eligibility[slot.name] = normalized.value;
    } else {
        examDoc[slot.name] = normalized.value;
    }
    // Cross-field sanity for the age window (checked here, not silently fixed).
    const min = examDoc.minimumAge ?? null;
    const max = examDoc.maximumAge ?? null;
    if (min !== null && max !== null && max < min) {
        throw new Error("applyManualEligibility: maximumAge must be >= minimumAge");
    }
    // Cross-field sanity for the education window: a known maximum must not
    // rank below a known minimum (checked, not silently fixed).
    const { getEducationRank } = require("../utils/educationLevels");
    const minEduRank = getEducationRank(examDoc.minimumEducationLevel ?? null);
    const maxEduRank = getEducationRank(examDoc.maximumEducationLevel ?? null);
    if (minEduRank !== null && maxEduRank !== null && maxEduRank < minEduRank) {
        throw new Error("applyManualEligibility: maximumEducationLevel must rank at or above minimumEducationLevel");
    }
    recordManualEdit(examDoc, canonicalField, updatedBy, note);
    return examDoc;
};

const validateCustomEntry = ({ key, label, value, status = "CONFIRMED" } = {}) => {
    if (typeof key !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(key.trim())) {
        throw new Error("custom eligibility key must match /^[a-z][a-zA-Z0-9]*$/");
    }
    if (typeof label !== "string" || !label.trim()) {
        throw new Error("custom eligibility label is required");
    }
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("custom eligibility value is required");
    }
    if (!MANUAL_CUSTOM_STATUSES.includes(status)) {
        throw new Error(`custom eligibility status must be one of: ${MANUAL_CUSTOM_STATUSES.join(", ")}`);
    }
    return { key: key.trim(), label: label.trim(), value: value.trim(), status };
};

const ensureCustomArray = (examDoc) => {
    if (!Array.isArray(examDoc.customEligibility)) examDoc.customEligibility = [];
    return examDoc.customEligibility;
};

const addCustomEligibility = (
    examDoc,
    { key, label, value, status = "CONFIRMED", notes = null, updatedBy = null } = {}
) => {
    if (!examDoc || typeof examDoc !== "object") {
        throw new Error("addCustomEligibility: an exam document is required");
    }
    const entry = validateCustomEntry({ key, label, value, status });
    const list = ensureCustomArray(examDoc);
    if (list.some((existing) => existing.key === entry.key)) {
        throw new Error(`custom eligibility key '${entry.key}' already exists (update it instead)`);
    }
    list.push({
        ...entry,
        source: "MANUAL",
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
        updatedBy: typeof updatedBy === "string" && updatedBy.trim() ? updatedBy.trim() : null,
    });
    recordManualEdit(examDoc, `custom:${entry.key}`, updatedBy, notes);
    return examDoc;
};

const updateCustomEligibility = (
    examDoc,
    key,
    { label, value, status, notes, updatedBy = null } = {}
) => {
    if (!examDoc || typeof examDoc !== "object") {
        throw new Error("updateCustomEligibility: an exam document is required");
    }
    const list = ensureCustomArray(examDoc);
    const entry = list.find((existing) => existing.key === key);
    if (!entry) throw new Error(`custom eligibility key '${key}' not found`);
    if (label !== undefined) {
        if (typeof label !== "string" || !label.trim()) throw new Error("custom eligibility label is required");
        entry.label = label.trim();
    }
    if (value !== undefined) {
        if (typeof value !== "string" || !value.trim()) throw new Error("custom eligibility value is required");
        entry.value = value.trim();
    }
    if (status !== undefined) {
        if (!MANUAL_CUSTOM_STATUSES.includes(status)) {
            throw new Error(`custom eligibility status must be one of: ${MANUAL_CUSTOM_STATUSES.join(", ")}`);
        }
        entry.status = status;
    }
    if (notes !== undefined) entry.notes = typeof notes === "string" && notes.trim() ? notes.trim() : null;
    if (updatedBy !== undefined) {
        entry.updatedBy = typeof updatedBy === "string" && updatedBy.trim() ? updatedBy.trim() : null;
    }
    recordManualEdit(examDoc, `custom:${key}`, updatedBy, notes);
    return examDoc;
};

const removeCustomEligibility = (examDoc, key, { updatedBy = null, note = null } = {}) => {
    if (!examDoc || typeof examDoc !== "object") {
        throw new Error("removeCustomEligibility: an exam document is required");
    }
    const list = ensureCustomArray(examDoc);
    const index = list.findIndex((existing) => existing.key === key);
    if (index === -1) throw new Error(`custom eligibility key '${key}' not found`);
    list.splice(index, 1);
    recordManualEdit(examDoc, `custom:${key}:removed`, updatedBy, note);
    return examDoc;
};

const getFieldProvenance = (examDoc, field) => {
    if (!examDoc || typeof examDoc !== "object") return null;
    const edits = Array.isArray(examDoc.manualEdits) ? examDoc.manualEdits : [];
    const hit = edits.find((edit) => edit.field === field);
    if (hit) return "MANUAL";
    return examDoc.origin || null;
};

module.exports = {
    MANUAL_TOP_LEVEL_FIELDS,
    MANUAL_ELIGIBILITY_FIELDS,
    MANUAL_CUSTOM_STATUSES,
    applyManualEligibility,
    addCustomEligibility,
    updateCustomEligibility,
    removeCustomEligibility,
    getFieldProvenance,
};
