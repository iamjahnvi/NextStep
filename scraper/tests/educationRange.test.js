// =============================================================================
// scraper/tests/educationRange.test.js
// =============================================================================
// WHAT: Bidirectional education maturity for the scraper — ranges, explicit
//   upper openness, alternative pathways, contradictions, and the publish gate.
// WHY: Extraction previously produced minimum-only KNOWN bars (maxLevel was
//   always null), so published records could not enforce eligibility in both
//   directions. A missing maximum must never silently mean "everyone eligible".
// DB: adjudication section uses isolated mongodb-memory-server ONLY.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { extractEligibility } = require("../extractors/eligibility");
const {
  validateExamEdition,
  buildUnknownEligibility,
} = require("../validators/examValidator");
const { mapDraftToExamPayload } = require("../publish/examMapper");
const { validatePublishRequest } = require("../publish/publishValidator");
const {
  normalizeAdjudicatedEducation,
  confirmEducationValue,
} = require("../pipeline/reviewPipeline");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin",
  docType: "HTML",
  retrievedAt: new Date("2026-01-01T00:00:00Z"),
  section: "bulletin",
};

describe("education extraction — ranges, openness, alternatives", () => {
  it("extracts an explicit Class X-to-Y range as a KNOWN bounded pair", () => {
    for (const text of [
      "Students of Class 8 to 10 are eligible to apply for the scholarship.",
      "The test is open to students from Class 8 to Class 10 of recognized schools.",
      "Eligibility: classes 8-12 may appear for the qualifier.",
    ]) {
      const eligibility = extractEligibility(text, CTX);
      assert.equal(eligibility.education.status, "KNOWN", text);
    }
    const eligibility = extractEligibility(
      "Students of Class 8 to 10 are eligible to apply for the scholarship.",
      CTX
    );
    assert.equal(eligibility.education.minLevel, "8");
    assert.equal(eligibility.education.maxLevel, "10");
    assert.equal(eligibility.education.upperOpen, null);
  });

  it("does not mistake two separate categories for a range", () => {
    const eligibility = extractEligibility(
      "Class X passed candidates may apply for the foundation course. Class XII completion is required for the main post.",
      CTX
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.equal(eligibility.education.maxLevel, null);
  });

  it("flags reversed ranges as NEEDS_VERIFICATION, never KNOWN", () => {
    const eligibility = extractEligibility(
      "Candidates from Class 12 to 8 are eligible to apply.",
      CTX
    );
    assert.equal(eligibility.education.status, "NEEDS_VERIFICATION");
    assert.equal(eligibility.education.minLevel, null);
    assert.equal(eligibility.education.maxLevel, null);
    assert.ok(eligibility.education.evidence);
  });

  it("extracts explicit no-upper-cap phrasing as upperOpen:true", () => {
    const eligibility = extractEligibility(
      "Candidates must have passed Class 12 from a recognized board. There is no upper limit on educational qualifications; higher qualifications may also apply.",
      CTX
    );
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "12");
    assert.equal(eligibility.education.maxLevel, null);
    assert.equal(eligibility.education.upperOpen, true);
  });

  it("never reads an AGE cap as an education upper opening", () => {
    const eligibility = extractEligibility(
      "Candidates must have passed Class 12. The upper age limit is 25 years.",
      CTX
    );
    assert.equal(eligibility.education.minLevel, "12");
    assert.equal(eligibility.education.upperOpen, null);
  });

  it("extracts diploma entry pathways as alternatives, keeping the floor", () => {
    const eligibility = extractEligibility(
      "Candidates must hold a Bachelor's degree in Engineering. Diploma holders may also apply for the lateral entry scheme.",
      CTX
    );
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "Graduate");
    assert.deepEqual(eligibility.education.alternativeLevels, ["Diploma"]);
  });

  it("leaves degree-level 'or' alternatives UNKNOWN for human review", () => {
    const eligibility = extractEligibility(
      [
        "Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.",
        "Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.",
      ].join(" "),
      CTX
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.equal(eligibility.education.alternativeLevels, null);
  });

  it("extracts the Class 9 level", () => {
    const eligibility = extractEligibility(
      "Students must have passed Class 9 from a recognized school to be eligible.",
      CTX
    );
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "9");
  });
});

describe("education draft validation — canonical, non-contradictory", () => {
  const baseEdition = () => ({
    examSlug: "edu-range-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: buildUnknownEligibility(),
    sources: [
      {
        sourceUrl: "http://127.0.0.1/",
        documentUrl: null,
        docType: "HTML",
        retrievedAt: new Date("2026-01-02T00:00:00Z"),
        section: null,
        page: null,
        excerpt: null,
        confidence: "HIGH",
        extractor: null,
      },
    ],
    status: "DRAFT",
  });

  it("accepts KNOWN ranges, open uppers, and alternatives-only floors", () => {
    for (const education of [
      { minLevel: "8", maxLevel: "10", upperOpen: null, alternativeLevels: null, appearingAllowed: null, status: "KNOWN", evidence: null },
      { minLevel: "Graduate", maxLevel: null, upperOpen: true, alternativeLevels: null, appearingAllowed: null, status: "KNOWN", evidence: null },
      { minLevel: null, maxLevel: null, upperOpen: null, alternativeLevels: ["Diploma"], appearingAllowed: null, status: "KNOWN", evidence: null },
    ]) {
      const edition = { ...baseEdition(), eligibility: { ...buildUnknownEligibility(), education } };
      assert.equal(validateExamEdition(edition).success, true, JSON.stringify(education));
    }
  });

  it("rejects contradictory ranges and non-canonical levels", () => {
    const contradictory = {
      minLevel: "Graduate", maxLevel: "12", upperOpen: null, alternativeLevels: null,
      appearingAllowed: null, status: "KNOWN", evidence: null,
    };
    const edition = { ...baseEdition(), eligibility: { ...buildUnknownEligibility(), education: contradictory } };
    assert.equal(validateExamEdition(edition).success, false);

    const exotic = {
      minLevel: "Kindergarten", maxLevel: null, upperOpen: null, alternativeLevels: null,
      appearingAllowed: null, status: "KNOWN", evidence: null,
    };
    const edition2 = { ...baseEdition(), eligibility: { ...buildUnknownEligibility(), education: exotic } };
    assert.equal(validateExamEdition(edition2).success, false);
  });
});

describe("education adjudication — structured completion", () => {
  it("normalizes scalars, objects, and JSON strings; rejects the rest", () => {
    // Raw normalizer returns a merge spec; the adjudication contract preserves
    // the legacy scalar round-trip for audit records (covered in the operator
    // path tests below).
    assert.deepEqual(normalizeAdjudicatedEducation("Graduate"), { min: "Graduate" });
    assert.equal(normalizeAdjudicatedEducation("Astrophysics"), null);
    assert.deepEqual(normalizeAdjudicatedEducation({ upperOpen: true }), { upperOpen: true });
    assert.deepEqual(normalizeAdjudicatedEducation('{"max":"12"}'), { max: "12" });
    assert.equal(normalizeAdjudicatedEducation({ max: "Kindergarten" }), null);
    assert.equal(normalizeAdjudicatedEducation({ upperOpen: "yes" }), null);
    assert.equal(normalizeAdjudicatedEducation({}), null);
    assert.equal(normalizeAdjudicatedEducation({ unknown: 1 }), null);
    assert.equal(normalizeAdjudicatedEducation(null), null);
    assert.deepEqual(
      normalizeAdjudicatedEducation({ min: "Graduate", alternatives: ["Diploma", "diploma"] }),
      { min: "Graduate", alternatives: ["Diploma"] }
    );
  });

  it("merges completions, recomputes status, blocks contradictions and floor-less caps", () => {
    const current = {
      minLevel: "12", maxLevel: null, upperOpen: null, alternativeLevels: null,
      appearingAllowed: null, status: "KNOWN", evidence: null,
    };
    const completed = confirmEducationValue(current, { upperOpen: true });
    assert.equal(completed.status, "KNOWN");
    assert.equal(completed.minLevel, "12");
    assert.equal(completed.upperOpen, true);

    assert.throws(
      () => confirmEducationValue(current, { max: "10" }),
      /must rank at or above min/
    );
    assert.throws(
      () => confirmEducationValue({ ...current, minLevel: null }, { max: "12" }),
      /needs a minimum level or alternative pathways/
    );
  });
});

describe("education publish gate — explicit upper or staged", () => {
  const exam = (overrides = {}) => ({
    name: "Range Gate Exam",
    fullForm: "Range Gate Examination",
    description: null,
    minimumAge: null,
    maximumAge: null,
    minimumEducationLevel: "8",
    maximumEducationLevel: "10",
    noUpperEducationLimit: null,
    alternativeQualifications: null,
    streams: null,
    subjects: null,
    eligibility: { minimumPercentage: null },
    registrationStartDate: new Date("2026-01-15T00:00:00Z"),
    registrationEndDate: new Date("2026-02-20T00:00:00Z"),
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
    origin: "SCRAPER",
    ...overrides,
  });
  const draft = { status: "VERIFIED", edition: { sources: [] } };

  it("publishes bounded ranges, open uppers, and alternative pathways", () => {
    assert.equal(validatePublishRequest({ draft, payload: exam() }).ok, true);
    assert.equal(
      validatePublishRequest({
        draft,
        payload: exam({ maximumEducationLevel: null, noUpperEducationLimit: true }),
      }).ok,
      true
    );
    assert.equal(
      validatePublishRequest({
        draft,
        payload: exam({
          minimumEducationLevel: "Graduate",
          maximumEducationLevel: null,
          noUpperEducationLimit: true,
          alternativeQualifications: ["Diploma"],
        }),
      }).ok,
      true
    );
  });

  it("rejects unknown uppers, contradictions, and exotic levels", () => {
    assert.equal(
      validatePublishRequest({
        draft,
        payload: exam({ maximumEducationLevel: null, noUpperEducationLimit: null }),
      }).ok,
      false
    );
    assert.equal(
      validatePublishRequest({
        draft,
        payload: exam({ minimumEducationLevel: "Graduate", maximumEducationLevel: "12", noUpperEducationLimit: null }),
      }).ok,
      false
    );
    assert.equal(
      validatePublishRequest({
        draft,
        payload: exam({ alternativeQualifications: ["Kindergarten"] }),
      }).ok,
      false
    );
  });

  it("mapper carries max/upperOpen/alternatives KNOWN-only", () => {
    const { exam: mapped } = mapDraftToExamPayload({
      exam: { name: "M", fullForm: "M", officialWebsite: "http://127.0.0.1/" },
      edition: {
        eligibility: {
          education: {
            minLevel: "8", maxLevel: "10", upperOpen: null,
            alternativeLevels: ["Diploma"], status: "KNOWN",
          },
        },
        registration: {},
      },
    });
    assert.equal(mapped.maximumEducationLevel, "10");
    assert.equal(mapped.noUpperEducationLimit, null);
    assert.deepEqual(mapped.alternativeQualifications, ["Diploma"]);

    const { exam: unknown } = mapDraftToExamPayload({
      exam: { name: "M", fullForm: "M", officialWebsite: "http://127.0.0.1/" },
      edition: {
        eligibility: {
          education: {
            minLevel: null, maxLevel: null, upperOpen: null,
            alternativeLevels: null, status: "UNKNOWN",
          },
        },
        registration: {},
      },
    });
    assert.equal(unknown.maximumEducationLevel, null);
    assert.equal(unknown.noUpperEducationLimit, null);
    assert.equal(unknown.alternativeQualifications, null);
  });
});

describe("education completion on KNOWN axes (operator path)", () => {
  const {
    getExamEditionDraftModel,
  } = require("../models/examEditionDraft");
  const {
    saveDraft,
    getDraft,
    adjudicateDraft,
  } = require("../pipeline/reviewPipeline");
  const {
    startIsolatedDb,
    connectRawDocuments,
    closeIsolatedDb,
  } = require("./helpers/isolatedDb");

  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;

  const exam = () => ({
    slug: "edu-range-exam",
    name: "Edu Range Exam",
    fullForm: "Edu Range Examination",
    conductingBody: "Edu Range Board",
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
  });

  const knownMinEdition = () => ({
    examSlug: "edu-range-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      ...buildUnknownEligibility(),
      education: {
        minLevel: "Graduate",
        maxLevel: null,
        upperOpen: null,
        alternativeLevels: null,
        appearingAllowed: null,
        status: "KNOWN",
        evidence: null,
      },
    },
    sources: [],
    status: "DRAFT",
  });

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("edu_range_completion"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
  });

  it("structured completion fills the upper side of a KNOWN axis", async () => {
    const saved = await saveDraft(EditionDraft, { exam: exam(), edition: knownMinEdition() });
    const updated = await adjudicateDraft(EditionDraft, saved._id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: { upperOpen: true },
      decidedBy: "operator-upper",
      note: "No official cap evidenced",
    });
    assert.equal(updated.edition.eligibility.education.status, "KNOWN");
    assert.equal(updated.edition.eligibility.education.minLevel, "Graduate");
    assert.equal(updated.edition.eligibility.education.upperOpen, true);
    assert.equal(updated.adjudications.length, 1);
  });

  it("scalar re-decisions and floor changes on KNOWN axes throw", async () => {
    const saved = await saveDraft(EditionDraft, { exam: exam(), edition: knownMinEdition() });
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, saved._id, {
          axis: "education",
          decision: "CONFIRM_VALUE",
          value: "Post-Graduate",
          decidedBy: "operator-1",
        }),
      /not UNKNOWN/
    );
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, saved._id, {
          axis: "education",
          decision: "CONFIRM_VALUE",
          value: { min: "Post-Graduate", upperOpen: true },
          decidedBy: "operator-1",
        }),
      /preserves the confirmed minimum/
    );
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, saved._id, {
          axis: "education",
          decision: "CONFIRM_VALUE",
          value: { max: "12" },
          decidedBy: "operator-1",
        }),
      /must rank at or above min/
    );
    assert.deepEqual((await getDraft(EditionDraft, saved._id)).adjudications, []);
  });
});
