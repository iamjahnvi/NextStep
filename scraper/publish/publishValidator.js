// =============================================================================
// scraper/publish/publishValidator.js
// =============================================================================
// WHAT: Validates a mapped publish payload against the NextStep Exam
//   requirements (mirrored from server/models/Exam.js — local zod schema, no
//   server imports) plus the publish gate (draft must be VERIFIED).
// WHY: Core identity stays strict (name/fullForm/website/dates/education):
//   a VERIFIED draft with UNKNOWN essentials (null dates, null education) is
//   still unpublishable — the validator rejects it with useful errors instead
//   of letting nulls reach production. But streams/subjects/age/percentage
//   are NULLABLE by product decision (flexible-eligibility redesign): exams
//   such as degree-level GATE carry no school-stream/subject gating, and null
//   ("no confirmed requirement") must flow through instead of forcing invented
//   values. Nullable is not weaker — invented values are what it prevents.
// REJECTS:
//   - non-VERIFIED drafts (DRAFT, REJECTED, missing status)
//   - malformed required fields (empty name/fullForm/website, null education,
//     empty-when-present streams/subjects arrays)
//   - invalid dates (unparseable, or end before start)
//   - invalid education/eligibility values (unknown level, percentage outside
//     0–100, negative age)
//   - any `month` key or other unrecognized exam key (.strict())
// CONTRACT:
//   validatePublishRequest({ draft, payload })
//     -> { ok: true, value } | { ok: false, issues: { status?, exam?, evidence? } }.
//   Never throws on invalid data (only on missing arguments) — the service
//   turns issues into a clear error.
// =============================================================================

const { z } = require("zod");
const { validateEvidence } = require("../validators/examValidator");

// Canonical levels mirror server/utils/educationLevels.js ALLOWED_EDUCATION_LEVELS.
const PUBLISH_EDUCATION_LEVELS = [
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

const PUBLISH_EDUCATION_RANK = {
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

// NOTE: required dates deliberately avoid z.coerce.date() — coercion turns
// null into the Unix epoch (new Date(null)), which would let missing dates
// slip through as 1970-01-01. This type accepts real Dates and non-empty
// parseable strings only.
const RequiredDate = z
  .union([
    z.date(),
    z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(new Date(s).getTime()), {
        message: "invalid date",
      }),
  ])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

// One controlled custom criterion (mirrors server/models/Exam.js — local
// copy, no server imports). Structured only: key/label/value required,
// status/source from closed sets, free-text notes allowed. Displayable
// without participating in any automated logic.
const PublishCustomEligibilitySchema = z
  .object({
    key: z.string().min(1).regex(/^[a-z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    value: z.string().min(1),
    status: z.enum(["CONFIRMED", "NEEDS_VERIFICATION", "NOT_APPLICABLE"]).optional(),
    source: z.enum(["SEED", "SCRAPER", "MANUAL"]).optional(),
    notes: z.string().nullable().optional(),
    updatedBy: z.string().nullable().optional(),
  })
  .strict();

const PublishExamSchema = z
  .object({
    name: z.string().min(1),
    fullForm: z.string().min(1),
    description: z.string().nullable().optional(),
    minimumAge: z.number().int().min(0).nullable().optional(),
    maximumAge: z.number().int().min(0).nullable().optional(),
    minimumEducationLevel: z.enum(PUBLISH_EDUCATION_LEVELS),
    // Upper education semantics must be EXPLICIT: a known cap, or an explicit
    // "no cap" flag. A missing maximum without noUpperEducationLimit:true is
    // UNKNOWN (not "everyone eligible") and unpublishable — the draft stays
    // staged for operator review instead of shipping guesses.
    maximumEducationLevel: z.enum(PUBLISH_EDUCATION_LEVELS).nullable().optional(),
    noUpperEducationLimit: z.boolean().nullable().optional(),
    alternativeQualifications: z.array(z.enum(PUBLISH_EDUCATION_LEVELS)).nullable().optional(),
    // Nullable by product decision: null = "no confirmed requirement"
    // (e.g. degree-level exams with no school-stream/subject gating).
    // A PRESENT array must still be non-empty with non-empty entries —
    // null passes, [] and [""] do not.
    streams: z.array(z.string().min(1)).min(1).nullable().optional(),
    subjects: z.array(z.string().min(1)).min(1).nullable().optional(),
    eligibility: z
      .object({
        minimumPercentage: z.number().min(0).max(100).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    customEligibility: z
      .array(PublishCustomEligibilitySchema)
      .optional()
      .refine(
        (entries) =>
          !entries || new Set(entries.map((entry) => entry.key)).size === entries.length,
        { message: "customEligibility keys must be unique" }
      ),
    registrationStartDate: RequiredDate,
    registrationEndDate: RequiredDate,
    officialWebsite: z.url(),
    // Unclassified by product decision — null only (never a guessed value).
    careerType: z.null(),
    examType: z.null(),
    // Publish-path stamp (examMapper sets this): a record crossing this
    // boundary is scraper-created, never seed-created. Required as a literal
    // so the stamp cannot be dropped or forged to another origin here.
    origin: z.literal("SCRAPER"),
    // NOTE: no `month`, no `location` by design (.strict() rejects them).
  })
  .strict()
  .refine(
    (exam) => exam.registrationEndDate >= exam.registrationStartDate,
    { message: "registrationEndDate must be >= registrationStartDate" }
  )
  .refine(
    (exam) =>
      exam.maximumAge == null ||
      exam.minimumAge == null ||
      exam.maximumAge >= exam.minimumAge,
    { message: "maximumAge must be >= minimumAge when both are present" }
  )
  .refine(
    (exam) =>
      exam.maximumEducationLevel != null || exam.noUpperEducationLimit === true,
    {
      message:
        "upper education restriction must be explicit: maximumEducationLevel or noUpperEducationLimit:true",
    }
  )
  .refine(
    (exam) =>
      exam.maximumEducationLevel == null ||
      exam.minimumEducationLevel == null ||
      PUBLISH_EDUCATION_RANK[exam.maximumEducationLevel] >=
        PUBLISH_EDUCATION_RANK[exam.minimumEducationLevel],
    { message: "maximumEducationLevel must rank at or above minimumEducationLevel" }
  );

function validatePublishRequest({ draft, payload } = {}) {
  if (!draft || !payload) {
    throw new Error("publishValidator: draft and payload are required");
  }
  const issues = {};

  if (draft.status !== "VERIFIED") {
    issues.status = [
      {
        message: `only VERIFIED drafts are publishable (status is ${draft.status ?? "missing"})`,
      },
    ];
  }

  const parsed = PublishExamSchema.safeParse(payload);
  if (!parsed.success) {
    issues.exam = parsed.error.issues;
  }

  const evidence = draft.edition && draft.edition.sources;
  if (!Array.isArray(evidence)) {
    issues.evidence = [{ message: "evidence must remain attached" }];
  } else {
    const bad = [];
    evidence.forEach((source, index) => {
      if (!validateEvidence(source).success) bad.push(index);
    });
    if (bad.length > 0) {
      issues.evidence = [{ message: `invalid evidence entries at indexes ${bad.join(", ")}` }];
    }
  }

  if (Object.keys(issues).length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: parsed.data };
}

module.exports = {
  PUBLISH_EDUCATION_LEVELS,
  PublishExamSchema,
  validatePublishRequest,
};
