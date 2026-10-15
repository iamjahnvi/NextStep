// =============================================================================
// scraper/publish/examMapper.js
// =============================================================================
// WHAT: Maps a VERIFIED ExamEdition staging draft into the NextStep Exam
//   representation (field shape mirrors server/models/Exam.js — the scraper
//   keeps a local mapping and never imports server code).
// WHY: The publish boundary must be explicit: one function, one direction,
//   no invented values. Anything the draft does not evidence stays null so
//   the validator (publishValidator.js) can reject unpublishable payloads
//   instead of shipping guesses.
// MAPPING (draft → NextStep Exam field):
//   exam.name                  → name
//   exam.fullForm              → fullForm
//   (not extracted)            → description: null
//   eligibility.age.min        → minimumAge (KNOWN only, else null)
//   eligibility.age.max        → maximumAge (KNOWN only, else null)
//   eligibility.education      → minimumEducationLevel (KNOWN minLevel, else null)
//   eligibility.education      → maximumEducationLevel (KNOWN maxLevel, else null)
//   eligibility.education      → noUpperEducationLimit (KNOWN upperOpen, else null)
//   eligibility.education      → alternativeQualifications (KNOWN alternativeLevels, else null)
//   eligibility.stream.allowed → streams (KNOWN only, else null)
//   eligibility.subjects       → subjects (KNOWN requiredAny, else null)
//   eligibility.percentage.min → eligibility.minimumPercentage (KNOWN, else null)
//   edition.registration       → registrationStartDate / registrationEndDate
//   exam.officialWebsite       → officialWebsite
//   (fixed)                    → careerType: null, examType: null (unclassified)
//   (fixed)                    → origin: "SCRAPER" (publish-path stamp; the
//     Exam schema default is SEED, so without this every scraper-published
//     record would misreport its provenance)
//   (never)                    → NO month field (derived app-side from dates)
//   Draft-only data (year, cycle, evidence, raw refs) does NOT go into the
//   exam shape — it is returned separately as `provenance` for identity.
// CONTRACT:
//   mapDraftToExamPayload(draft) -> { exam, provenance } (in-memory only).
//     draft: staging draft object with { _id, exam, edition, status,
//            rawDocuments }. Status is NOT checked here (the validator and
//            service enforce VERIFIED) so mapping stays a pure function.
//     provenance: { draftId, examSlug, year, cycle, sourceDocuments, evidence }.
// =============================================================================

function knownValue(axis, pick) {
  if (!axis || axis.status !== "KNOWN") return null;
  return pick(axis);
}

function mapDraftToExamPayload(draft) {
  if (!draft || typeof draft !== "object") {
    throw new Error("examMapper: a draft object is required");
  }
  const exam = draft.exam;
  const edition = draft.edition;
  if (!exam || !edition) {
    throw new Error("examMapper: draft must contain exam and edition");
  }
  const eligibility = edition.eligibility || {};
  const registration = edition.registration || {};

  const payload = {
    name: exam.name ?? null,
    fullForm: exam.fullForm ?? null,
    description: null,
    minimumAge: knownValue(eligibility.age, (axis) => axis.min ?? null),
    maximumAge: knownValue(eligibility.age, (axis) => axis.max ?? null),
    minimumEducationLevel: knownValue(
      eligibility.education,
      (axis) => axis.minLevel ?? null
    ),
    maximumEducationLevel: knownValue(
      eligibility.education,
      (axis) => axis.maxLevel ?? null
    ),
    noUpperEducationLimit: knownValue(
      eligibility.education,
      (axis) => axis.upperOpen ?? null
    ),
    alternativeQualifications: knownValue(eligibility.education, (axis) =>
      Array.isArray(axis.alternativeLevels) && axis.alternativeLevels.length > 0
        ? [...axis.alternativeLevels]
        : null
    ),
    streams: knownValue(eligibility.stream, (axis) =>
      Array.isArray(axis.allowed) ? [...axis.allowed] : null
    ),
    subjects: knownValue(eligibility.subjects, (axis) =>
      Array.isArray(axis.requiredAny) ? [...axis.requiredAny] : null
    ),
    eligibility: {
      minimumPercentage: knownValue(
        eligibility.percentage,
        (axis) => axis.min ?? null
      ),
    },
    registrationStartDate: registration.startDate ?? null,
    registrationEndDate: registration.endDate ?? null,
    officialWebsite: exam.officialWebsite ?? null,
    careerType: null,
    examType: null,
    origin: "SCRAPER",
  };

  const provenance = {
    draftId: draft._id ? String(draft._id) : null,
    examSlug: edition.examSlug ?? exam.slug ?? null,
    year: edition.year ?? null,
    cycle: edition.cycle ?? null,
    sourceDocuments: Array.isArray(draft.rawDocuments)
      ? draft.rawDocuments.map((ref) => ({
          documentId: ref.documentId ? String(ref.documentId) : null,
          url: ref.url ?? null,
          checksum: ref.checksum ?? null,
          label: ref.label ?? null,
        }))
      : [],
    evidence: Array.isArray(edition.sources) ? [...edition.sources] : [],
  };

  return { exam: payload, provenance };
}

module.exports = {
  mapDraftToExamPayload,
};
