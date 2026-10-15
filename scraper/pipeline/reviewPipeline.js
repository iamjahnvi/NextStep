// =============================================================================
// scraper/pipeline/reviewPipeline.js
// =============================================================================
// WHAT: Draft review + safe promotion service — the safety boundary between
//   machine extraction and trusted data:
//     saveDraft (persist Phase 5 output as DRAFT)
//       → reviewDraft (validate fields + evidence, no state change)
//       → adjudicateDraft (operator resolves ONE unknown axis, stays DRAFT)
//       → promoteDraft (DRAFT → VERIFIED, only when valid)
//        | rejectDraft (DRAFT → REJECTED with a reason)
//   A future publish step (verified staging → NextStep app) is intentionally
//   NOT implemented here; publishVerifiedDrafts is a separated placeholder
//   that refuses to run until that boundary is designed.
// SAFEGUARDS (defense against accidental production writes):
//   - This module never requires server/models/Exam.js, server/data/exams.js
//     or any seed script — staging models only.
//   - Every operation asserts the passed model backs the
//     `scraper_editiondrafts` collection and refuses anything else (notably
//     the production `exams` collection).
//   - Promotion never touches RawDocuments (no model access at all) and never
//     writes anywhere except the draft's own staging document.
// PROMOTION RULES (simple, explicit):
//   - Only DRAFT records can be promoted or rejected; VERIFIED/REJECTED are
//     terminal (double-promotion and post-rejection promotion both fail).
//   - The edition must pass ExamEditionSchema at promotion time; failures
//     return the validation issues, never a silent fill.
//   - Evidence (edition.sources) must be attached (an array — possibly empty
//     for honestly-UNKNOWN drafts; UNKNOWN is neither auto-valid nor
//     auto-invalid, the schema decides).
//   - saveDraft always stores status DRAFT — extraction output can never
//     arrive pre-VERIFIED.
// CONTRACT: all functions take the staging draft model
//   (getExamEditionDraftModel(connection)) explicitly — no hidden connections.
// =============================================================================

const {
  EDITION_DRAFT_COLLECTION,
  ADJUDICATION_DECISIONS,
  getExamEditionDraftModel,
} = require("../models/examEditionDraft");
const {
  validateExam,
  validateExamEdition,
  validateEvidence,
} = require("../validators/examValidator");

// Explicit anti-production-write guard. Any caller mistake that hands this
// service a production/demo model fails loudly instead of writing.
function assertStagingDraftModel(EditionDraft) {
  if (!EditionDraft || !EditionDraft.collection) {
    throw new Error("reviewPipeline: a draft model is required");
  }
  if (EditionDraft.collection.name !== EDITION_DRAFT_COLLECTION) {
    throw new Error(
      `reviewPipeline: refusing to operate on collection "${EditionDraft.collection.name}" ` +
        `(staging drafts live in "${EDITION_DRAFT_COLLECTION}")`
    );
  }
}

function toPlain(draft) {
  return draft && typeof draft.toObject === "function"
    ? draft.toObject()
    : draft;
}

function examOf(draft) {
  const plain = toPlain(draft);
  return plain && plain.exam !== undefined ? plain.exam : plain;
}

function editionOf(draft) {
  const plain = toPlain(draft);
  if (plain && plain.edition !== undefined) return plain.edition;
  return plain;
}

// reviewDraft(draft) -> { valid, examIssues, editionIssues, evidenceIssues }.
// Pure review: validates fields + every attached evidence entry, changes no
// state. Missing/UNKNOWN fields are left to the schema — reported as-is.
function reviewDraft(draft) {
  const examIssues = [];
  const editionIssues = [];
  const evidenceIssues = [];

  const examCheck = validateExam(examOf(draft));
  if (!examCheck.success) examIssues.push(...examCheck.error.issues);

  const editionCheck = validateExamEdition(editionOf(draft));
  if (!editionCheck.success) editionIssues.push(...editionCheck.error.issues);

  const edition = editionOf(draft);
  const sources = edition && edition.sources;
  if (sources === undefined || sources === null) {
    evidenceIssues.push({ path: ["sources"], message: "evidence must remain attached" });
  } else if (!Array.isArray(sources)) {
    evidenceIssues.push({ path: ["sources"], message: "evidence must be an array" });
  } else {
    sources.forEach((source, index) => {
      const check = validateEvidence(source);
      if (!check.success) {
        evidenceIssues.push({ index, issues: check.error.issues });
      }
    });
  }

  return {
    valid:
      examIssues.length === 0 &&
      editionIssues.length === 0 &&
      evidenceIssues.length === 0,
    examIssues,
    editionIssues,
    evidenceIssues,
  };
}

// saveDraft(EditionDraft, { exam, edition, rawDocuments }) -> saved DRAFT.
// Validates first (a broken draft is never persisted); status is always
// forced to DRAFT — callers cannot smuggle in VERIFIED.
async function saveDraft(EditionDraft, { exam, edition, rawDocuments = [] } = {}) {
  assertStagingDraftModel(EditionDraft);
  if (!exam || !edition) {
    throw new Error("reviewPipeline: exam and edition are required");
  }
  const review = reviewDraft({ exam, edition });
  if (!review.valid) {
    throw new Error(
      "reviewPipeline: refusing to save an invalid draft — " +
        JSON.stringify(
          {
            exam: review.examIssues,
            edition: review.editionIssues,
            evidence: review.evidenceIssues,
          },
          null,
          2
        )
    );
  }
  const created = await EditionDraft.create({
    examSlug: edition.examSlug,
    year: edition.year,
    cycle: edition.cycle,
    exam,
    edition,
    status: "DRAFT",
    rawDocuments: Array.isArray(rawDocuments) ? rawDocuments : [],
    decidedAt: null,
    decidedBy: null,
    rejectReason: null,
  });
  return created;
}

async function getDraft(EditionDraft, id) {
  assertStagingDraftModel(EditionDraft);
  return EditionDraft.findById(id);
}

async function listDrafts(EditionDraft, filter = {}) {
  assertStagingDraftModel(EditionDraft);
  const query = {};
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.examSlug !== undefined) query.examSlug = filter.examSlug;
  return EditionDraft.find(query).sort({ createdAt: -1 });
}

// promoteDraft(EditionDraft, id, { decidedBy }) -> VERIFIED document.
// Only DRAFT → VERIFIED; re-validates at promotion time so data that became
// invalid (or was inserted around the service) can never slip through.
async function promoteDraft(EditionDraft, id, options = {}) {
  assertStagingDraftModel(EditionDraft);
  const draft = await EditionDraft.findById(id);
  if (!draft) throw new Error("reviewPipeline: draft not found");
  if (draft.status !== "DRAFT") {
    throw new Error(
      `reviewPipeline: only DRAFT records can be promoted (status is ${draft.status})`
    );
  }
  const review = reviewDraft(draft);
  if (!review.valid) {
    throw new Error(
      "reviewPipeline: invalid draft cannot become VERIFIED — " +
        JSON.stringify(
          {
            exam: review.examIssues,
            edition: review.editionIssues,
            evidence: review.evidenceIssues,
          },
          null,
          2
        )
    );
  }
  draft.status = "VERIFIED";
  draft.decidedAt = new Date();
  draft.decidedBy = options.decidedBy || null;
  await draft.save();
  return draft;
}

// rejectDraft(EditionDraft, id, { reason, decidedBy }) -> REJECTED document.
async function rejectDraft(EditionDraft, id, options = {}) {
  assertStagingDraftModel(EditionDraft);
  const draft = await EditionDraft.findById(id);
  if (!draft) throw new Error("reviewPipeline: draft not found");
  if (draft.status !== "DRAFT") {
    throw new Error(
      `reviewPipeline: only DRAFT records can be rejected (status is ${draft.status})`
    );
  }
  draft.status = "REJECTED";
  draft.decidedAt = new Date();
  draft.decidedBy = options.decidedBy || null;
  draft.rejectReason = options.reason || null;
  await draft.save();
  return draft;
}

// Canonical education levels, aligned with server/utils/educationLevels.js.
// Local copy on purpose: the scraper never imports server code (see header).
// Only canonical values are adjudicable — free-text input is rejected, never
// normalized into existence.
const CANONICAL_EDUCATION_LEVELS = [
  "8",
  "9",
  "10",
  "11",
  "12",
  "Diploma",
  "Graduate",
  "Post-Graduate",
  "Doctorate",
];

function normalizeAdjudicatedEducationLevel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const classMatch = trimmed.match(/^class\s+(\d{1,2})$/i);
  if (classMatch) {
    const level = classMatch[1];
    return CANONICAL_EDUCATION_LEVELS.includes(level) ? level : null;
  }
  const romanClassMatch = trimmed.match(/^class\s+(xii|xi|x)$/i);
  if (romanClassMatch) {
    return { x: "10", xi: "11", xii: "12" }[
      romanClassMatch[1].toLowerCase()
    ];
  }
  const lower = trimmed.toLowerCase().replace(/\./g, "");
  if (lower === "senior secondary" || lower === "senior-secondary") {
    return "12";
  }
  if (lower === "graduation" || lower === "graduate" || lower === "ug") {
    return "Graduate";
  }
  if (
    lower === "post-graduate" ||
    lower === "postgraduate" ||
    lower === "post graduate" ||
    lower === "pg"
  ) {
    return "Post-Graduate";
  }
  if (lower === "phd" || lower === "doctorate") return "Doctorate";
  if (lower === "diploma" || lower === "polytechnic") return "Diploma";
  const exact = CANONICAL_EDUCATION_LEVELS.find(
    (level) => level.toLowerCase() === lower
  );
  return exact || null;
}

// Structured education adjudication: { min?, max?, upperOpen?, alternatives? }.
// Each present key is normalized independently; anything unrecognized rejects
// the WHOLE value (never a partial confirmation). Returns the merged spec or
// null. A JSON object string (CLI --value) is accepted and parsed.
function normalizeAdjudicatedEducation(value) {
  let input = value;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      try {
        input = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      // Legacy scalar: one canonical minimum level.
      const level = normalizeAdjudicatedEducationLevel(input);
      return level === null ? null : { min: level };
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length === 0) return null;
  if (keys.some((k) => !["min", "max", "upperOpen", "alternatives"].includes(k))) {
    return null;
  }
  const spec = {};
  if (input.min !== undefined && input.min !== null) {
    const level = normalizeAdjudicatedEducationLevel(input.min);
    if (level === null) return null;
    spec.min = level;
  }
  if (input.max !== undefined && input.max !== null) {
    const level = normalizeAdjudicatedEducationLevel(input.max);
    if (level === null) return null;
    spec.max = level;
  }
  if (input.upperOpen !== undefined && input.upperOpen !== null) {
    if (typeof input.upperOpen !== "boolean") return null;
    spec.upperOpen = input.upperOpen;
  }
  if (input.alternatives !== undefined && input.alternatives !== null) {
    if (!Array.isArray(input.alternatives) || input.alternatives.length === 0) return null;
    const canonical = [];
    for (const entry of input.alternatives) {
      const level = normalizeAdjudicatedEducationLevel(entry);
      if (level === null) return null;
      if (!canonical.includes(level)) canonical.push(level);
    }
    spec.alternatives = canonical;
  }
  return Object.keys(spec).length > 0 ? spec : null;
}

const EDUCATION_RANK = {
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  Diploma: 13,
  Graduate: 15,
  "Post-Graduate": 16,
  Doctorate: 17,
};

// Merges a normalized education spec into the current axis value, recomputing
// KNOWN/UNKNOWN. Throws on contradictions (max below min) or floor-less
// results (a cap alone evidences no entry floor) instead of storing them.
function confirmEducationValue(current, spec) {
  const merged = {
    minLevel: spec.min !== undefined ? spec.min : (current.minLevel ?? null),
    maxLevel: spec.max !== undefined ? spec.max : (current.maxLevel ?? null),
    upperOpen:
      spec.upperOpen !== undefined
        ? spec.upperOpen
        : (current.upperOpen === undefined ? null : current.upperOpen),
    alternativeLevels:
      spec.alternatives !== undefined
        ? spec.alternatives
        : (current.alternativeLevels === undefined ? null : current.alternativeLevels),
    appearingAllowed:
      current.appearingAllowed === undefined ? null : current.appearingAllowed,
  };
  const minRank = merged.minLevel === null ? null : EDUCATION_RANK[merged.minLevel];
  const maxRank = merged.maxLevel === null ? null : EDUCATION_RANK[merged.maxLevel];
  if (minRank != null && maxRank != null && maxRank < minRank) {
    throw new Error(
      "reviewPipeline: education max must rank at or above min (contradictory confirmation rejected)"
    );
  }
  const hasFloor =
    merged.minLevel !== null ||
    (Array.isArray(merged.alternativeLevels) && merged.alternativeLevels.length > 0);
  if (!hasFloor) {
    throw new Error(
      "reviewPipeline: education confirmation needs a minimum level or alternative pathways (a cap alone is not entry evidence)"
    );
  }
  return {
    ...merged,
    status: "KNOWN",
    evidence: current.evidence || null,
  };
}

// Percentage: a finite number in [0, 100]. Numeric strings (optionally with
// a trailing %) are normalized, never invented — anything else is rejected.
function normalizeAdjudicatedPercentage(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

// Age: a plain object with at least one of min/max as a non-negative
// integer (numbers or all-digit strings). asOfDate is never operator-set —
// it stays exactly as extracted. Anything else is rejected.
function normalizeAdjudicatedAge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((k) => k !== "min" && k !== "max")) {
    return null;
  }
  const coerce = (v) => {
    if (typeof v === "number") {
      return Number.isInteger(v) && v >= 0 ? v : null;
    }
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      return Number(v.trim());
    }
    return null;
  };
  const out = { min: null, max: null };
  let found = false;
  for (const key of ["min", "max"]) {
    if (value[key] === undefined || value[key] === null) continue;
    const coerced = coerce(value[key]);
    if (coerced === null) return null;
    out[key] = coerced;
    found = true;
  }
  return found ? out : null;
}

// Stream/subject lists: a non-empty string (wrapped) or an array of
// non-empty strings (trimmed, deduped). Empty or non-string content is
// rejected — absence of evidence stays UNKNOWN, never an empty claim.
function normalizeAdjudicatedStringList(value) {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return null;
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
}

// Axes an operator may adjudicate. Each entry carries its own explicit value
// contract below — never a silent default. Axes absent here (anything not
// listed) stay non-adjudicable: the canonical model cannot represent an
// operator value for them safely.
const ADJUDICATION_CONTRACTS = {
  education: {
    hint:
      "a canonical education level " +
      `(${CANONICAL_EDUCATION_LEVELS.join(", ")}) or a JSON object ` +
      `{"min","max","upperOpen","alternatives"} with canonical values`,
    normalize: (value) => {
      // Legacy scalar ("Graduate") and structured objects share one entry
      // point; the CLI passes strings through untouched (see operator test).
      const spec = normalizeAdjudicatedEducation(value);
      if (spec === null) return null;
      // Preserve the legacy scalar round-trip for audit records.
      if (typeof value === "string" && !value.trim().startsWith("{") && spec.min && Object.keys(spec).length === 1) {
        return spec.min;
      }
      return spec;
    },
    confirm: (current, canonical) => {
      const spec =
        typeof canonical === "string" ? { min: canonical } : canonical;
      return confirmEducationValue(current, spec);
    },
    keep: (current) => ({
      minLevel: null,
      maxLevel: null,
      upperOpen: null,
      alternativeLevels: null,
      appearingAllowed:
        current.appearingAllowed === undefined
          ? null
          : current.appearingAllowed,
      status: "UNKNOWN",
      evidence: current.evidence || null,
    }),
  },
  percentage: {
    hint: "a percentage between 0 and 100",
    normalize: (value) => normalizeAdjudicatedPercentage(value),
    confirm: (current, canonical) => ({
      min: canonical,
      status: "KNOWN",
      evidence: current.evidence || null,
    }),
    keep: (current) => ({
      min: null,
      status: "UNKNOWN",
      evidence: current.evidence || null,
    }),
  },
  age: {
    hint: "an object with at least one of { min, max } as a non-negative integer",
    normalize: (value) => normalizeAdjudicatedAge(value),
    confirm: (current, canonical) => ({
      min: canonical.min,
      max: canonical.max,
      asOfDate: current.asOfDate === undefined ? null : current.asOfDate,
      status: "KNOWN",
      evidence: current.evidence || null,
    }),
    keep: (current) => ({
      min: null,
      max: null,
      asOfDate: current.asOfDate === undefined ? null : current.asOfDate,
      status: "UNKNOWN",
      evidence: current.evidence || null,
    }),
  },
  stream: {
    hint: "a non-empty string or array of non-empty strings",
    normalize: (value) => normalizeAdjudicatedStringList(value),
    confirm: (current, canonical) => ({
      allowed: canonical,
      status: "KNOWN",
      evidence: current.evidence || null,
    }),
    keep: (current) => ({
      allowed: null,
      status: "UNKNOWN",
      evidence: current.evidence || null,
    }),
  },
  subjects: {
    hint: "a non-empty string or array of non-empty strings",
    normalize: (value) => normalizeAdjudicatedStringList(value),
    confirm: (current, canonical) => ({
      requiredAny: canonical,
      status: "KNOWN",
      evidence: current.evidence || null,
    }),
    keep: (current) => ({
      requiredAny: null,
      status: "UNKNOWN",
      evidence: current.evidence || null,
    }),
  },
};

const ADJUDICABLE_AXES = Object.keys(ADJUDICATION_CONTRACTS);

// adjudicateDraft(EditionDraft, id, { axis, decision, value, decidedBy, note })
//   -> updated DRAFT document. Operator resolution of ONE unknown axis
//     (education, percentage, age, stream, subjects):
//     CONFIRM_VALUE : axis must be UNKNOWN; value must satisfy that axis's
//                     contract; the axis becomes KNOWN with the ORIGINAL
//                     extraction evidence preserved byte-identical.
//     KEEP_UNKNOWN  : value must be absent; the axis stays null/UNKNOWN and
//                     only the audit record is added.
//   Education COMPLETION (the one exception): a KNOWN education axis accepts
//     CONFIRM_VALUE with a STRUCTURED value (object or JSON string) that
//     preserves the confirmed minimum (spec.min absent, or equal to the
//     current minLevel) to complete upperOpen/maxLevel/alternativeLevels —
//     the upper semantics extraction cannot evidence. Floors are never
//     re-decided through this path (scalar values on KNOWN axes still throw);
//     contradictions still throw. This is what unblocks publishing for
//     KNOWN-min drafts whose upper side extraction left unknown.
//   Rules: DRAFT only (VERIFIED/REJECTED are immutable); decidedBy required;
//   status never transitions here (no auto-promotion); unrelated fields are
//   never touched; the mutated draft re-validates before anything is saved.
async function adjudicateDraft(EditionDraft, id, options = {}) {
  assertStagingDraftModel(EditionDraft);
  const { axis, decision, value, decidedBy, note } = options || {};

  if (!ADJUDICABLE_AXES.includes(axis)) {
    throw new Error(
      `reviewPipeline: axis "${axis}" is not adjudicable (supported: ${ADJUDICABLE_AXES.join(", ")})`
    );
  }
  const contract = ADJUDICATION_CONTRACTS[axis];
  if (!ADJUDICATION_DECISIONS.includes(decision)) {
    throw new Error(
      `reviewPipeline: decision must be one of ${ADJUDICATION_DECISIONS.join(" | ")}`
    );
  }
  if (typeof decidedBy !== "string" || !decidedBy.trim()) {
    throw new Error("reviewPipeline: decidedBy (operator) is required");
  }

  const draft = await EditionDraft.findById(id);
  if (!draft) throw new Error("reviewPipeline: draft not found");
  if (draft.status !== "DRAFT") {
    throw new Error(
      `reviewPipeline: only DRAFT records can be adjudicated (status is ${draft.status})`
    );
  }

  const plain = toPlain(draft);
  const current = plain.edition && plain.edition.eligibility &&
    plain.edition.eligibility[axis];
  // Education completion (see header): a KNOWN education axis may receive a
  // structured CONFIRM_VALUE that preserves its minimum to complete the
  // upper side. Everything else still requires UNKNOWN.
  const looksStructured =
    value !== undefined &&
    value !== null &&
    (typeof value === "object" ||
      (typeof value === "string" && value.trim().startsWith("{")));
  const educationCompletion =
    axis === "education" &&
    decision === "CONFIRM_VALUE" &&
    looksStructured &&
    current &&
    current.status === "KNOWN";
  if (!educationCompletion) {
    if (!current || current.status !== "UNKNOWN") {
      throw new Error(
        `reviewPipeline: axis "${axis}" is not UNKNOWN (status is ${current ? current.status : "missing"})`
      );
    }
  }

  let confirmedValue = null;
  if (decision === "CONFIRM_VALUE") {
    confirmedValue = contract.normalize(value);
    if (confirmedValue === null) {
      throw new Error(
        `reviewPipeline: CONFIRM_VALUE requires ${contract.hint}`
      );
    }
    if (educationCompletion) {
      // Completion preserves the confirmed floor: a structured value may
      // only fill gaps (absent min) or restate the same minimum — never
      // re-decide it, and never as a bare scalar.
      if (typeof confirmedValue === "string") {
        throw new Error(
          "reviewPipeline: completing a KNOWN education axis needs a structured value " +
            '(e.g. {"upperOpen":true}); scalars cannot re-decide a confirmed minimum'
        );
      }
      if (
        confirmedValue.min !== undefined &&
        current.minLevel != null &&
        confirmedValue.min !== current.minLevel
      ) {
        throw new Error(
          `reviewPipeline: completion preserves the confirmed minimum (${current.minLevel}); ` +
            "to correct a floor, reject and re-extract instead"
        );
      }
    }
  } else if (value !== undefined && value !== null) {
    throw new Error("reviewPipeline: KEEP_UNKNOWN takes no value");
  }

  const updatedAxis =
    decision === "CONFIRM_VALUE"
      ? contract.confirm(current, confirmedValue)
      : contract.keep(current);

  const updatedEdition = {
    ...plain.edition,
    eligibility: { ...plain.edition.eligibility, [axis]: updatedAxis },
  };
  const review = reviewDraft({ exam: plain.exam, edition: updatedEdition });
  if (!review.valid) {
    throw new Error(
      "reviewPipeline: adjudicated draft is invalid — " +
        JSON.stringify(
          {
            exam: review.examIssues,
            edition: review.editionIssues,
            evidence: review.evidenceIssues,
          },
          null,
          2
        )
    );
  }

  draft.edition = updatedEdition;
  draft.markModified("edition");
  draft.adjudications.push({
    axis,
    decision,
    value: decision === "CONFIRM_VALUE" ? confirmedValue : null,
    decidedBy: decidedBy.trim(),
    decidedAt: new Date(),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  });
  await draft.save();
  return draft;
}

// FUTURE BOUNDARY (placeholder, NOT implemented): publishing verified staging
// drafts into the NextStep application. Deliberately refuses to run so no
// caller can mistake staging review for a production write.
async function publishVerifiedDrafts() {
  throw new Error(
    "reviewPipeline: publish boundary not implemented — verified drafts stay " +
      "in scraper staging until the controlled publish/integration step is designed"
  );
}

module.exports = {
  assertStagingDraftModel,
  reviewDraft,
  saveDraft,
  getDraft,
  listDrafts,
  promoteDraft,
  rejectDraft,
  adjudicateDraft,
  normalizeAdjudicatedEducationLevel,
  normalizeAdjudicatedEducation,
  confirmEducationValue,
  normalizeAdjudicatedPercentage,
  normalizeAdjudicatedAge,
  normalizeAdjudicatedStringList,
  ADJUDICATION_CONTRACTS,
  ADJUDICABLE_AXES,
  publishVerifiedDrafts,
  getExamEditionDraftModel,
};
