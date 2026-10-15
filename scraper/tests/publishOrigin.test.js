// =============================================================================
// scraper/tests/publishOrigin.test.js
// =============================================================================
// WHAT: Provenance-stamp regression — records crossing the publish boundary
//   carry origin "SCRAPER" (the Exam schema default is SEED, which would
//   otherwise mislabel scraper-created records). Identity/dedup, null
//   classifications, and the no-location/no-month rules are unchanged.
// DB: isolated mongodb-memory-server ONLY. Production never connected.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { mapDraftToExamPayload } = require("../publish/examMapper");
const { validatePublishRequest } = require("../publish/publishValidator");
const { buildPublishPayloadFromDraft } = require("../publish/publishService");
const { dryRunPublish, publishVerifiedDraft } = require("../publish/publishExecutor");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const { saveDraft, promoteDraft } = require("../pipeline/reviewPipeline");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

function validExam(overrides = {}) {
  return {
    slug: "origin-test-exam",
    name: "Origin Test Exam",
    fullForm: "Origin Test Examination",
    conductingBody: "Origin Test Board",
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

function fullEdition(overrides = {}) {
  return {
    examSlug: "origin-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      education: { minLevel: "12", maxLevel: null, upperOpen: true, alternativeLevels: null, appearingAllowed: null, status: "KNOWN", evidence: validEvidence() },
      stream: { allowed: ["Science"], status: "KNOWN", evidence: validEvidence() },
      subjects: { requiredAny: ["Physics"], status: "KNOWN", evidence: validEvidence() },
      percentage: { min: null, status: "UNKNOWN", evidence: null },
      age: { min: null, max: null, asOfDate: null, status: "UNKNOWN", evidence: null },
    },
    sources: [validEvidence()],
    status: "DRAFT",
    ...overrides,
  };
}

// Stand-in production Exam WITH the real origin field (unlike older
// stand-ins that predate it) on the real collection name.
function getOriginAwareExamModel(connection) {
  const schema = new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      fullForm: { type: String, required: true, trim: true },
      streams: { type: [String], default: null },
      minimumEducationLevel: { type: String, default: null, trim: true },
      minimumAge: { type: Number, default: null },
      maximumAge: { type: Number, default: null },
      registrationStartDate: { type: Date, required: true },
      registrationEndDate: { type: Date, required: true },
      officialWebsite: { type: String, required: true, trim: true },
      description: { type: String, trim: true },
      eligibility: { minimumPercentage: Number },
      subjects: { type: [String], default: null },
      careerType: { type: String, default: null },
      examType: { type: String, default: null },
      origin: { type: String, enum: ["SEED", "SCRAPER", "MANUAL", "MIXED"], default: "SEED" },
    },
    { timestamps: true, strict: true }
  );
  return connection.model("OriginExam", schema, "exams");
}

describe("publish boundary — origin SCRAPER stamp", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let Receipt;
  let Exam;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("publish_origin"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
    Receipt = getPublishReceiptModel(connection);
    Exam = getOriginAwareExamModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "publish origin tests must not leak connections");
  });

  async function verifiedDraftId(tag) {
    const slug = `origin-${tag}`;
    const saved = await saveDraft(EditionDraft, {
      exam: validExam({ slug, name: `Origin ${tag}` }),
      edition: fullEdition({ examSlug: slug }),
    });
    const verified = await promoteDraft(EditionDraft, saved._id);
    return verified._id;
  }

  it("1. publish payload contains origin SCRAPER", async () => {
    const id = await verifiedDraftId("t1");
    const { exam } = buildPublishPayloadFromDraft(await EditionDraft.findById(id));
    assert.equal(exam.origin, "SCRAPER");
  });

  it("2. validation accepts the SCRAPER stamp and rejects a forged one", async () => {
    const id = await verifiedDraftId("t2");
    const draft = await EditionDraft.findById(id).lean();
    const { exam } = mapDraftToExamPayload(draft);
    assert.equal(validatePublishRequest({ draft, payload: exam }).ok, true);
    assert.equal(
      validatePublishRequest({ draft, payload: { ...exam, origin: "SEED" } }).ok,
      false
    );
    const { origin: _dropped, ...rest } = exam;
    assert.equal(validatePublishRequest({ draft, payload: rest }).ok, false);
  });

  it("5. identity/dedup unchanged: republish resolves, single record", async () => {
    const id = await verifiedDraftId("t5");
    const draftId = String(id);
    const first = await publishVerifiedDraft(EditionDraft, {
      Receipt, ExamModel: Exam, draftId, confirmPublish: true, publishedBy: "origin-test",
    });
    assert.equal(first.action, "created");
    assert.equal(await Exam.countDocuments({}), 1);
    const stored = await Exam.findById(first.examId).lean();
    assert.equal(stored.origin, "SCRAPER");
    const second = await publishVerifiedDraft(EditionDraft, {
      Receipt, ExamModel: Exam, draftId, confirmPublish: true,
    });
    assert.equal(second.action, "already-published");
    assert.equal(second.examId, first.examId);
    assert.equal(await Exam.countDocuments({}), 1);
  });

  it("6/7. careerType/examType null; no location/month", async () => {
    const id = await verifiedDraftId("t6");
    const { exam } = buildPublishPayloadFromDraft(await EditionDraft.findById(id));
    assert.equal(exam.careerType, null);
    assert.equal(exam.examType, null);
    assert.ok(!("month" in exam));
    assert.ok(!("location" in exam));
  });

  it("dry-run reports the stamp with zero writes", async () => {
    const id = await verifiedDraftId("t7");
    const before = { exams: await Exam.countDocuments({}), receipts: await Receipt.countDocuments({}) };
    const dry = await dryRunPublish(EditionDraft, { Receipt, draftId: String(id) });
    assert.equal(dry.exam.origin, "SCRAPER");
    assert.equal(dry.target, "exams");
    assert.deepEqual(
      { exams: await Exam.countDocuments({}), receipts: await Receipt.countDocuments({}) },
      before
    );
  });
});
