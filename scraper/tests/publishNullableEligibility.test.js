// =============================================================================
// scraper/tests/publishNullableEligibility.test.js
// =============================================================================
// WHAT: Flexible-eligibility publish-boundary coverage — the scraper can
//   publish legitimate exams (e.g. degree-level GATE) without inventing
//   streams/subjects, while core identity validation stays strict.
// WHY: Nullable streams/subjects must flow through as null; required fields
//   (name/fullForm/education/dates/website) must still reject; UNKNOWN must
//   never become a guessed value; the boundary must never touch drafts.
// DB: isolated mongodb-memory-server ONLY. Production never connected.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { mapDraftToExamPayload } = require("../publish/examMapper");
const { validatePublishRequest } = require("../publish/publishValidator");
const { buildPublishPayloadFromDraft } = require("../publish/publishService");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { saveDraft, promoteDraft, adjudicateDraft } = require("../pipeline/reviewPipeline");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

function validExam(overrides = {}) {
  return {
    slug: "nullable-test-exam",
    name: "Nullable Test Exam",
    fullForm: "Nullable Test Examination",
    conductingBody: "Nullable Test Board",
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
    ...overrides,
  };
}

function validEvidence(overrides = {}) {
  return {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/bulletin.html",
    docType: "HTML",
    retrievedAt: new Date("2026-01-02T00:00:00Z"),
    section: "information-bulletin",
    page: null,
    excerpt: "Registration Start Date: 15 January 2026.",
    confidence: "HIGH",
    extractor: "registrationDates.v1",
    ...overrides,
  };
}

// GATE-shaped edition: Graduate education (adjudicable), everything else
// UNKNOWN — the exact shape the real GATE audit produced. The upper side is
// deliberately NOT completed here: extraction cannot evidence it, so the
// draft stays staged until an operator completes it (see verifiedGateDraftId;
// the uncompleted shape must NOT publish — staged for review instead).
function gateShapedEdition(overrides = {}) {
  return {
    examSlug: "nullable-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      education: { minLevel: "Graduate", maxLevel: null, upperOpen: null, alternativeLevels: null, appearingAllowed: null, status: "KNOWN", evidence: validEvidence() },
      stream: { allowed: null, status: "UNKNOWN", evidence: null },
      subjects: { requiredAny: null, status: "UNKNOWN", evidence: null },
      percentage: { min: null, status: "UNKNOWN", evidence: null },
      age: { min: null, max: null, asOfDate: null, status: "UNKNOWN", evidence: null },
    },
    sources: [validEvidence()],
    status: "DRAFT",
    ...overrides,
  };
}

describe("publish boundary — nullable eligibility (no invented values)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("publish_nullable"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "publish boundary must not leak connections");
  });

  async function verifiedGateDraftId() {
    const saved = await saveDraft(EditionDraft, { exam: validExam(), edition: gateShapedEdition() });
    // Real workflow: extraction evidences the floor; the operator completes
    // the upper side (no official cap for GATE) before promotion/publish.
    await adjudicateDraft(EditionDraft, saved._id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: { upperOpen: true },
      decidedBy: "operator-upper",
      note: "No official upper qualification cap evidenced",
    });
    const verified = await promoteDraft(EditionDraft, saved._id);
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.edition.eligibility.education.upperOpen, true);
    return verified._id;
  }

  it("12a. extraction-shaped KNOWN-min/unknown-upper drafts do NOT publish (staged for review)", async () => {
    const saved = await saveDraft(EditionDraft, { exam: validExam(), edition: gateShapedEdition() });
    const verified = await promoteDraft(EditionDraft, saved._id);
    const { exam } = mapDraftToExamPayload(verified);
    assert.equal(exam.minimumEducationLevel, "Graduate");
    assert.equal(exam.maximumEducationLevel, null);
    assert.equal(exam.noUpperEducationLimit, null);
    const result = validatePublishRequest({ draft: verified, payload: exam });
    assert.equal(result.ok, false);
    assert.ok(
      JSON.stringify(result.issues).includes("upper education restriction must be explicit")
    );
    // The service layer refuses too — no auto-publish from extraction alone.
    assert.throws(() => buildPublishPayloadFromDraft(verified));
  });

  it("12. GATE-shaped VERIFIED draft publishes without streams/subjects", async () => {
    const id = await verifiedGateDraftId();
    const { exam, provenance } = buildPublishPayloadFromDraft(await EditionDraft.findById(id));
    assert.equal(exam.minimumEducationLevel, "Graduate");
    // Operator-completed upper side flows through explicitly.
    assert.equal(exam.maximumEducationLevel, null);
    assert.equal(exam.noUpperEducationLimit, true);
    assert.equal(exam.streams, null);
    assert.equal(exam.subjects, null);
    assert.equal(exam.minimumAge, null);
    assert.equal(exam.maximumAge, null);
    assert.equal(exam.eligibility.minimumPercentage, null);
    assert.equal(exam.careerType, null);
    assert.equal(exam.examType, null);
    assert.ok(!("month" in exam));
    assert.ok(!("location" in exam));
    assert.ok(provenance);
  });

  it("12. mapper passes age.max through; UNKNOWN stays null", () => {
    const draft = {
      exam: validExam(),
      edition: gateShapedEdition({
        eligibility: {
          ...gateShapedEdition().eligibility,
          age: { min: 17, max: 25, asOfDate: null, status: "KNOWN", evidence: validEvidence() },
        },
      }),
    };
    const { exam } = mapDraftToExamPayload(draft);
    assert.equal(exam.minimumAge, 17);
    assert.equal(exam.maximumAge, 25);
  });

  it("12. validator accepts null streams/subjects but rejects [] and ['']", () => {
    // Completed shape (operator-confirmed upper): the extraction-shaped draft
    // without explicit upper semantics is rejected by design (see test 12a).
    const completed = {
      ...gateShapedEdition(),
      eligibility: {
        ...gateShapedEdition().eligibility,
        education: {
          ...gateShapedEdition().eligibility.education,
          upperOpen: true,
        },
      },
    };
    const base = mapDraftToExamPayload({ exam: validExam(), edition: completed }).exam;
    const draft = { status: "VERIFIED", edition: completed };
    assert.equal(validatePublishRequest({ draft, payload: base }).ok, true);
    assert.equal(
      validatePublishRequest({ draft, payload: { ...base, streams: [] } }).ok,
      false
    );
    assert.equal(
      validatePublishRequest({ draft, payload: { ...base, subjects: [""] } }).ok,
      false
    );
  });

  it("12. required identity still rejects (name/education/dates/website)", async () => {
    const id = await verifiedGateDraftId();
    const draft = await EditionDraft.findById(id).lean();
    const { exam } = mapDraftToExamPayload(draft);
    assert.equal(validatePublishRequest({ draft, payload: { ...exam, name: "" } }).ok, false);
    assert.equal(
      validatePublishRequest({ draft, payload: { ...exam, registrationStartDate: null } }).ok,
      false
    );
    assert.equal(
      validatePublishRequest({ draft, payload: { ...exam, officialWebsite: "not-a-url" } }).ok,
      false
    );
    // Null education is still unpublishable — adjudicate first, never guess.
    assert.equal(
      validatePublishRequest({ draft, payload: { ...exam, minimumEducationLevel: null } }).ok,
      false
    );
    // maximumAge below minimumAge rejects.
    assert.equal(
      validatePublishRequest({ draft, payload: { ...exam, minimumAge: 25, maximumAge: 17 } }).ok,
      false
    );
  });

  it("12. custom eligibility validates structurally (unique keys, closed enums)", async () => {
    const id = await verifiedGateDraftId();
    const draft = await EditionDraft.findById(id).lean();
    const { exam } = mapDraftToExamPayload(draft);
    const good = {
      ...exam,
      customEligibility: [
        { key: "license", label: "Professional registration", value: "Valid NMC registration", source: "MANUAL" },
      ],
    };
    assert.equal(validatePublishRequest({ draft, payload: good }).ok, true);
    const dup = {
      ...exam,
      customEligibility: [
        { key: "license", label: "A", value: "x" },
        { key: "license", label: "B", value: "y" },
      ],
    };
    assert.equal(validatePublishRequest({ draft, payload: dup }).ok, false);
  });

  it("13. UNKNOWN is never converted into an invented value", () => {
    const { exam } = mapDraftToExamPayload({ exam: validExam(), edition: gateShapedEdition() });
    assert.equal(exam.streams, null);
    assert.equal(exam.subjects, null);
    assert.notDeepEqual(exam.streams, []);
    assert.ok(!exam.streams?.includes?.("Science"));
  });

  it("14/15. careerType/examType stay null; no month/location keys", async () => {
    const id = await verifiedGateDraftId();
    const { exam } = buildPublishPayloadFromDraft(await EditionDraft.findById(id));
    assert.equal(exam.careerType, null);
    assert.equal(exam.examType, null);
    assert.ok(!("month" in exam));
    assert.ok(!("location" in exam));
  });

  it("17. payload build never mutates the draft (status/decidedBy untouched)", async () => {
    const id = await verifiedGateDraftId();
    const before = await EditionDraft.findById(id).lean();
    buildPublishPayloadFromDraft(await EditionDraft.findById(id));
    const after = await EditionDraft.findById(id).lean();
    assert.equal(after.status, before.status);
    assert.equal(after.decidedBy, before.decidedBy);
    assert.deepEqual(after.edition, before.edition);
  });
});
