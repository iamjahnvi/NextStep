// =============================================================================
// scraper/tests/publishIntegration.test.js
// =============================================================================
// WHAT: STEP 10 tests — one Step 9 draft across the EXISTING publish boundary
//   (validator → service → executor → mapper): dry-run safety, explicit
//   confirmation, single-record publish, field-by-field verification,
//   idempotent republish, rejection paths, and the no-batch boundary.
// WHY: Prove the final UNKNOWN → PUBLISHED hop once, loudly, and reversibly —
//   dry-run first with zero writes, one explicit confirm, then proof the
//   stored record matches the validated draft.
// DB: isolated mongodb-memory-server ONLY. The "production" Exam target is a
//   stand-in model on the throwaway database using the real collection name
//   ("exams") — production is never connected (MONGO_URI unset).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const { saveDraft, promoteDraft } = require("../pipeline/reviewPipeline");
const { dryRunSingleDraft, publishSingleDraft } = require("../pipeline/publishIntegration");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

function getStandInExamModel(connection) {
  const schema = new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      fullForm: { type: String, required: true, trim: true },
      streams: { type: [String], required: true },
      minimumEducationLevel: { type: String, required: true, trim: true },
      minimumAge: { type: Number },
      registrationStartDate: { type: Date, required: true },
      registrationEndDate: { type: Date, required: true },
      officialWebsite: { type: String, required: true, trim: true },
      description: { type: String, trim: true },
      eligibility: { minimumPercentage: Number },
      subjects: { type: [String], required: true },
      careerType: { type: String, default: null },
      examType: { type: String, default: null },
    },
    { timestamps: true, strict: true }
  );
  return connection.model("Step10Exam", schema, "exams");
}

function validExam(overrides = {}) {
  return {
    slug: "step10-test-exam",
    name: "Step10 Test Exam",
    fullForm: "Step Ten Test Examination",
    conductingBody: "Step Ten Test Board",
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
    examSlug: "step10-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      education: { minLevel: "12", maxLevel: null, upperOpen: true, alternativeLevels: null, appearingAllowed: null, status: "KNOWN", evidence: validEvidence() },
      stream: { allowed: ["Science"], status: "KNOWN", evidence: validEvidence() },
      subjects: { requiredAny: ["Physics", "Chemistry", "Mathematics"], status: "KNOWN", evidence: validEvidence() },
      percentage: { min: 75, status: "KNOWN", evidence: validEvidence() },
      age: { min: 17, max: null, asOfDate: null, status: "KNOWN", evidence: validEvidence() },
    },
    sources: [validEvidence()],
    status: "DRAFT",
    ...overrides,
  };
}

describe("STEP 10 — single-draft publish integration", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let Receipt;
  let Exam;
  let savedMongoUri;

  // Unique identity per publishing test: the executor's idempotency guard
  // would otherwise (correctly) refuse a second draft on one identity.
  async function verifiedDraftId(tag, overrides = {}) {
    const slug = `step10-${tag}`;
    const staged = await saveDraft(EditionDraft, {
      exam: validExam({ slug, name: `Step10 ${tag}`, fullForm: `Step Ten ${tag} Examination` }),
      edition: fullEdition({ examSlug: slug, ...overrides }),
    });
    const verified = await promoteDraft(EditionDraft, staged._id);
    assert.equal(verified.status, "VERIFIED");
    return { draftId: String(verified._id), slug, identity: `${slug}:2026:2026` };
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step10_publish"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
    Receipt = getPublishReceiptModel(connection);
    Exam = getStandInExamModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "publish integration must not leak connections");
  });

  it("1. valid draft passes validation with its identity", async () => {
    const { draftId, identity } = await verifiedDraftId("t1");
    const dry = await dryRunSingleDraft({ EditionDraft, Receipt }, draftId);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.identity, identity);
    assert.deepEqual(dry.validation, { ok: true });
    assert.equal(dry.exam.name, "Step10 t1");
    assert.ok(dry.provenance);
  });

  it("2. dry-run exposes the payload and writes nothing", async () => {
    const { draftId } = await verifiedDraftId("t2");
    const before = { exams: await Exam.countDocuments({}), receipts: await Receipt.countDocuments({}) };
    const dry = await dryRunSingleDraft({ EditionDraft, Receipt }, draftId);
    assert.equal(dry.wouldPublish, true);
    assert.equal(dry.writes, 0);
    assert.equal(dry.publishedRecordsCreated, 0);
    assert.deepEqual(
      { exams: await Exam.countDocuments({}), receipts: await Receipt.countDocuments({}) },
      before
    );
    const draft = await EditionDraft.findById(draftId);
    assert.equal(draft.status, "VERIFIED");
    const again = await dryRunSingleDraft({ EditionDraft, Receipt }, draftId);
    assert.equal(JSON.stringify(again.exam), JSON.stringify(dry.exam));
    assert.equal(again.identity, dry.identity);
  });

  it("3. missing confirmation refuses publishing", async () => {
    const { draftId } = await verifiedDraftId("t3");
    await assert.rejects(publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, draftId), /explicit confirmation/);
    await assert.rejects(
      publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, draftId, { confirm: false }),
      /explicit confirmation/
    );
    assert.equal(await Exam.countDocuments({}), 0);
  });

  it("4. invalid drafts are rejected with nothing published", async () => {
    const staged = await saveDraft(EditionDraft, { exam: validExam(), edition: fullEdition() });
    const rejected = await publishSingleDraft(
      { EditionDraft, Receipt, ExamModel: Exam },
      String(staged._id),
      { confirm: true }
    );
    assert.equal(rejected.publishSucceeded, false);
    assert.equal(rejected.stage, "PUBLISH_REJECTED");
    assert.match(rejected.error, /VERIFIED/);
    assert.equal(await Exam.countDocuments({}), 0);
  });

  it("5. missing provenance is rejected", async () => {
    const bypassed = await EditionDraft.create({
      examSlug: "step10-test-exam",
      year: 2026,
      cycle: "2026",
      exam: validExam(),
      edition: { ...fullEdition(), sources: undefined, status: "VERIFIED" },
      status: "VERIFIED",
      rawDocuments: [],
      decidedAt: new Date(),
      decidedBy: "step10-test",
      rejectReason: null,
    });
    const rejected = await publishSingleDraft(
      { EditionDraft, Receipt, ExamModel: Exam },
      String(bypassed._id),
      { confirm: true }
    );
    assert.equal(rejected.publishSucceeded, false);
    assert.equal(rejected.stage, "PUBLISH_REJECTED");
    assert.match(rejected.error, /evidence/);
    assert.equal(await Exam.countDocuments({}), 0);
  });

  it("6. exactly one draft is accepted — never batches", async () => {
    const { draftId } = await verifiedDraftId("t6");
    await assert.rejects(dryRunSingleDraft({ EditionDraft, Receipt }, [draftId]), /exactly one/);
    await assert.rejects(
      publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, [draftId], { confirm: true }),
      /exactly one/
    );
    await assert.rejects(dryRunSingleDraft({ EditionDraft, Receipt }, null), /exactly one/);
    assert.equal(await Exam.countDocuments({}), 0);
  });

  it("7. confirm publishes exactly one record and verifies it", async () => {
    const { draftId } = await verifiedDraftId("t7");
    const before = await Exam.countDocuments({});
    const out = await publishSingleDraft(
      { EditionDraft, Receipt, ExamModel: Exam },
      draftId,
      { confirm: true, publishedBy: "step10-operator" }
    );
    assert.equal(out.publishSucceeded, true);
    assert.equal(out.action, "created");
    assert.equal(out.wrote, true);
    assert.ok(out.publishedId);
    assert.equal(out.verificationPassed, true);
    assert.deepEqual(out.mismatches, []);
    assert.equal(await Exam.countDocuments({}), before + 1);

    const stored = await Exam.findById(out.publishedId).lean();
    assert.equal(stored.name, "Step10 t7");
    assert.equal(stored.fullForm, "Step Ten t7 Examination");
    assert.equal(stored.minimumEducationLevel, "12");
    assert.deepEqual(stored.streams, ["Science"]);
    assert.deepEqual(stored.subjects, ["Physics", "Chemistry", "Mathematics"]);
    assert.equal(new Date(stored.registrationStartDate).toISOString(), "2026-01-15T00:00:00.000Z");
    assert.equal(new Date(stored.registrationEndDate).toISOString(), "2026-02-20T00:00:00.000Z");
    assert.equal(stored.officialWebsite, "http://127.0.0.1/");
  });

  it("8. duplicate publish is absorbed by existing guards", async () => {
    const { draftId } = await verifiedDraftId("t8");
    const first = await publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, draftId, { confirm: true });
    assert.equal(first.action, "created");
    const count = await Exam.countDocuments({});
    const second = await publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, draftId, { confirm: true });
    assert.equal(second.publishSucceeded, true);
    assert.equal(second.action, "already-published");
    assert.equal(second.wrote, false);
    assert.equal(second.publishedId, first.publishedId);
    assert.equal(await Exam.countDocuments({}), count);
  });

  it("9. unrelated drafts are untouched and unpublishable identities stay clean", async () => {
    const other = await saveDraft(
      EditionDraft,
      { exam: validExam({ slug: "step10-other", name: "Step10 Other", fullForm: "Step Ten Other Examination" }), edition: fullEdition({ examSlug: "step10-other" }) }
    );
    const before = await Exam.countDocuments({});
    const { draftId } = await verifiedDraftId("t9");
    await publishSingleDraft({ EditionDraft, Receipt, ExamModel: Exam }, draftId, { confirm: true });
    assert.equal((await EditionDraft.findById(other._id)).status, "DRAFT");
    assert.equal(await Exam.countDocuments({}), before + 1);
  });

  it("10. integration adds no second publisher and names no exams", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "pipeline", "publishIntegration.js"), "utf8");
    const executable = code
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/ExamModel\.create|Exam\.create|\.insertMany|\.updateOne|\.updateMany|\.deleteOne|\.deleteMany/.test(executable), "orchestration performs no writes itself");
    assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), "no exam names");
  });
});
