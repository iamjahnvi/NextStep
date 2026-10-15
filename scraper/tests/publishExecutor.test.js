// =============================================================================
// scraper/tests/publishExecutor.test.js
// =============================================================================
// WHAT: Phase 8 tests — manual production publish executor with dry-run as
//   the default and an explicit confirm gate for the single idempotent upsert.
// WHY: Proves publishing can never happen accidentally, never duplicates,
//   never touches unrelated/demo records, and refuses swapped targets.
// DB: isolated mongodb-memory-server ONLY. The "production" Exam target is a
//   stand-in model on the throwaway database using the real collection name
//   ("exams") — the real production database is never connected.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const {
  saveDraft,
  promoteDraft,
  rejectDraft,
} = require("../pipeline/reviewPipeline");
const {
  buildPublishIdentity,
  dryRunPublish,
  publishVerifiedDraft,
} = require("../publish/publishExecutor");
const {
  startIsolatedDb,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

// Production stand-in: same collection name ("exams") and same required
// surface as server/models/Exam.js, on the isolated test database only.
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
  return connection.model("StandInExam", schema, "exams");
}

function validExam() {
  return {
    slug: "phase8-test-exam",
    name: "Phase8 Test Exam",
    fullForm: "Phase Eight Test Examination",
    conductingBody: "Phase Eight Test Board",
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
  };
}

function validEvidence() {
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
  };
}

function fullEdition(overrides = {}) {
  return {
    examSlug: "phase8-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      education: {
        minLevel: "12",
        maxLevel: null,
        // Completed upper semantics (operator-confirmed): required by the
        // publish gate — extraction-shaped drafts stay staged for review.
        upperOpen: true,
        alternativeLevels: null,
        appearingAllowed: null,
        status: "KNOWN",
        evidence: validEvidence(),
      },
      stream: {
        allowed: ["Science"],
        status: "KNOWN",
        evidence: validEvidence(),
      },
      subjects: {
        requiredAny: ["Physics", "Chemistry", "Mathematics"],
        status: "KNOWN",
        evidence: validEvidence(),
      },
      percentage: { min: 75, status: "KNOWN", evidence: validEvidence() },
      age: {
        min: 17,
        max: null,
        asOfDate: null,
        status: "KNOWN",
        evidence: validEvidence(),
      },
    },
    sources: [validEvidence()],
    status: "DRAFT",
    ...overrides,
  };
}

function demoExam(seed) {
  return {
    name: `Demo Exam ${seed}`,
    fullForm: `Demo Examination ${seed}`,
    streams: ["General (all streams)"],
    minimumEducationLevel: "12",
    registrationStartDate: new Date("2025-01-01T00:00:00Z"),
    registrationEndDate: new Date("2025-02-01T00:00:00Z"),
    officialWebsite: `http://127.0.0.1/demo-${seed}`,
    subjects: ["Mathematics"],
  };
}

describe("Phase 8 — publishExecutor (manual publish, dry-run default)", () => {
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
    ({ mongod, mongoUri } = await startIsolatedDb("phase8_executor"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
    Receipt = getPublishReceiptModel(connection);
    Exam = getStandInExamModel(connection);
    // Pre-existing records the executor must never disturb.
    await Exam.create([demoExam("A"), demoExam("B")]);
    await Exam.create({
      ...demoExam("unrelated"),
      name: "Unrelated Other Exam",
      officialWebsite: "http://127.0.0.1/other",
    });
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function verifiedDraft(edition = fullEdition()) {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition,
    });
    return promoteDraft(EditionDraft, saved._id);
  }

  function untouchedSnapshot() {
    return Exam.find({ name: { $ne: "Phase8 Test Exam" } })
      .sort({ name: 1 })
      .lean();
  }

  it("1+2. default execution is a dry-run with zero writes", async () => {
    const draft = await verifiedDraft();
    const examsBefore = await Exam.countDocuments({});
    const receiptsBefore = await Receipt.countDocuments({});

    const result = await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: draft._id,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.wrote, false);
    assert.equal(result.action, "would-create");
    assert.equal(result.identity, "phase8-test-exam:2026:2026");
    assert.equal(result.target, "exams");
    assert.ok(result.exam);
    assert.ok(result.provenance);
    assert.deepEqual(result.validation, { ok: true });
    assert.equal(result.draftId, String(draft._id));
    assert.equal(result.exam.name, "Phase8 Test Exam");

    assert.equal(await Exam.countDocuments({}), examsBefore);
    assert.equal(await Receipt.countDocuments({}), receiptsBefore);

    const direct = await dryRunPublish(EditionDraft, {
      Receipt,
      draftId: draft._id,
    });
    assert.equal(direct.dryRun, true);
    assert.equal(direct.wrote, false);
  });

  it("3. non-VERIFIED drafts cannot publish", async () => {
    const draft = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: fullEdition(),
    });
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Exam,
          draftId: draft._id,
          confirmPublish: true,
        }),
      /DRAFT/
    );
    await assert.rejects(
      () => dryRunPublish(EditionDraft, { Receipt, draftId: draft._id }),
      /DRAFT/
    );

    await rejectDraft(EditionDraft, draft._id, { reason: "stale" });
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Exam,
          draftId: draft._id,
          confirmPublish: true,
        }),
      /REJECTED/
    );
  });

  it("4. invalid payloads cannot publish", async () => {
    const broken = await EditionDraft.create({
      examSlug: "phase8-test-exam",
      year: 2026,
      cycle: "2026",
      exam: validExam(),
      edition: {
        ...fullEdition(),
        registration: { startDate: null, endDate: null },
      },
      status: "VERIFIED",
      rawDocuments: [],
    });
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Exam,
          draftId: broken._id,
          confirmPublish: true,
        }),
      /rejected/i
    );
    assert.equal(await Receipt.countDocuments({ identity: "phase8-test-exam:2026:2026" }), 0);
  });

  it("5+6. confirmPublish creates once; republish does not duplicate", async () => {
    const draft = await verifiedDraft(
      fullEdition({ cycle: "2026-p8" })
    );
    const identity = buildPublishIdentity(draft);
    assert.equal(identity, "phase8-test-exam:2026:2026-p8");

    const first = await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: draft._id,
      confirmPublish: true,
      publishedBy: "operator-1",
    });
    assert.equal(first.dryRun, false);
    assert.equal(first.wrote, true);
    assert.equal(first.action, "created");
    assert.ok(first.examId);

    assert.equal(
      await Exam.countDocuments({ name: "Phase8 Test Exam" }),
      1
    );
    const stored = await Exam.findById(first.examId).lean();
    assert.equal(stored.minimumEducationLevel, "12");
    assert.deepEqual(stored.streams, ["Science"]);

    const second = await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: draft._id,
      confirmPublish: true,
    });
    assert.equal(second.action, "already-published");
    assert.equal(second.wrote, false);
    assert.equal(second.examId, first.examId);
    assert.equal(
      await Exam.countDocuments({ name: "Phase8 Test Exam" }),
      1
    );
  });

  it("7+8. unrelated and demo records remain untouched", async () => {
    const before = await untouchedSnapshot();
    const draft = await verifiedDraft(fullEdition({ cycle: "2026-p8b" }));
    await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: draft._id,
      confirmPublish: true,
    });
    const after = await untouchedSnapshot();
    assert.deepEqual(
      after.map((d) => ({ ...d, _id: String(d._id) })),
      before.map((d) => ({ ...d, _id: String(d._id) }))
    );
    assert.equal(
      (await Exam.find({ name: /Demo Exam/ }).lean()).length,
      2
    );
  });

  it("9. identity conflict fails safely", async () => {
    const first = await verifiedDraft(fullEdition({ cycle: "2026-p8c" }));
    await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: first._id,
      confirmPublish: true,
    });
    // A different draft for the same edition must never overwrite.
    const rival = await verifiedDraft(
      fullEdition({
        cycle: "2026-p8c",
        registration: {
          startDate: new Date("2026-01-16T00:00:00Z"),
          endDate: new Date("2026-02-21T00:00:00Z"),
        },
      })
    );
    assert.notEqual(String(rival._id), String(first._id));
    const publishedBefore = await Exam.countDocuments({
      officialWebsite: "http://127.0.0.1/",
    });
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Exam,
          draftId: rival._id,
          confirmPublish: true,
        }),
      /identity conflict/
    );
    assert.equal(
      await Exam.countDocuments({ officialWebsite: "http://127.0.0.1/" }),
      publishedBefore
    );
  });

  it("10. staging and production targets cannot be swapped", async () => {
    const draft = await verifiedDraft(fullEdition({ cycle: "2026-p8d" }));
    // Staging model as production target.
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: EditionDraft,
          draftId: draft._id,
          confirmPublish: true,
        }),
      /must be exactly "exams"/
    );
    // Arbitrary collection as production target.
    const Other = connection.model(
      "StandInOther",
      new mongoose.Schema({ name: String }),
      "things"
    );
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Other,
          draftId: draft._id,
          confirmPublish: true,
        }),
      /must be exactly "exams"/
    );
    // Wrong receipt collection.
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt: EditionDraft,
          ExamModel: Exam,
          draftId: draft._id,
          confirmPublish: true,
        }),
      /receipts live in/
    );
    // Unknown draft.
    await assert.rejects(
      () =>
        publishVerifiedDraft(EditionDraft, {
          Receipt,
          ExamModel: Exam,
          draftId: new mongoose.Types.ObjectId(),
          confirmPublish: true,
        }),
      /not found/
    );
  });

  it("11+12. careerType/examType stay null and no month is introduced", async () => {
    const draft = await verifiedDraft(fullEdition({ cycle: "2026-p8e" }));
    const result = await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel: Exam,
      draftId: draft._id,
      confirmPublish: true,
    });
    const stored = await Exam.findById(result.examId).lean();
    assert.equal(stored.careerType, null);
    assert.equal(stored.examType, null);
    assert.ok(!("month" in stored));
  });

  it("executor sources reference no production wiring or schedulers", () => {
    for (const relative of [
      "models/publishReceipt.js",
      "publish/publishExecutor.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'][^"']*server\//.test(code), `${relative}: no server imports`);
      // Forbid actual connection strings/credentials (mentioning the MONGO_URI
      // convention in docs is fine — only executable secrets count).
      assert.ok(!/mongodb(\+srv)?:\/\/\S*@/.test(code), `${relative}: no credentials`);
      assert.ok(!/["']mongodb(\+srv)?:\/\//.test(code), `${relative}: no hardcoded connection strings`);
      assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    }
    const executor = fs.readFileSync(
      path.join(__dirname, "..", "publish/publishExecutor.js"),
      "utf8"
    );
    const executable = executor.replace(/\/\/.*$/gm, "");
    assert.ok(!/deleteMany|dropDatabase|drop\(\)/.test(executable));
  });

  it("13. leaves no temporary/download artifacts in the repo", () => {
    const repoRoot = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith(".tmp") ||
          /^(download|temp).*\.pdf$/i.test(entry.name)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
