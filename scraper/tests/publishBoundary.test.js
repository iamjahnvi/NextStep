// =============================================================================
// scraper/tests/publishBoundary.test.js
// =============================================================================
// WHAT: Phase 7 tests — VERIFIED staging draft → VALIDATED NextStep publish
//   payload, in memory only. No production Exam write exists anywhere here.
// WHY: Proves the integration boundary maps known NextStep fields, preserves
//   identity/evidence, rejects everything unpublishable, and cannot reach
//   production/demo storage.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const {
  saveDraft,
  promoteDraft,
  rejectDraft,
} = require("../pipeline/reviewPipeline");
const { mapDraftToExamPayload } = require("../publish/examMapper");
const { validatePublishRequest } = require("../publish/publishValidator");
const {
  buildPublishPayload,
  buildPublishPayloadFromDraft,
} = require("../publish/publishService");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

function validExam() {
  return {
    slug: "phase7-test-exam",
    name: "Phase7 Test Exam",
    fullForm: "Phase Seven Test Examination",
    conductingBody: "Phase Seven Test Board",
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

function knownEligibility() {
  return {
    education: {
      minLevel: "12",
      maxLevel: null,
      // Completed upper semantics (operator-confirmed): the publish gate
      // requires an explicit upper side — see the staged-draft rejection test.
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
  };
}

function fullEdition() {
  return {
    examSlug: "phase7-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: knownEligibility(),
    sources: [validEvidence()],
    status: "DRAFT",
  };
}

describe("Phase 7 — publish boundary (VERIFIED draft → payload, no writes)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase7_publish"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function verifiedDraftId(edition = fullEdition()) {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition,
    });
    const promoted = await promoteDraft(EditionDraft, saved._id);
    return promoted._id;
  }

  it("1+7. VERIFIED draft maps to a valid NextStep payload", async () => {
    const id = await verifiedDraftId();
    const { exam, provenance } = await buildPublishPayload(EditionDraft, id);

    assert.equal(exam.name, "Phase7 Test Exam");
    assert.equal(exam.fullForm, "Phase Seven Test Examination");
    assert.equal(exam.description, null);
    assert.equal(exam.minimumAge, 17);
    assert.equal(exam.minimumEducationLevel, "12");
    assert.deepEqual(exam.streams, ["Science"]);
    assert.deepEqual(exam.subjects, ["Physics", "Chemistry", "Mathematics"]);
    assert.equal(exam.eligibility.minimumPercentage, 75);
    assert.equal(
      new Date(exam.registrationStartDate).toISOString(),
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(
      new Date(exam.registrationEndDate).toISOString(),
      "2026-02-20T00:00:00.000Z"
    );
    assert.equal(exam.officialWebsite, "http://127.0.0.1/");

    const check = validatePublishRequest({
      draft: await EditionDraft.findById(id).lean(),
      payload: mapDraftToExamPayload(
        await EditionDraft.findById(id).lean()
      ).exam,
    });
    assert.equal(check.ok, true);
  });

  it("2+3. DRAFT and REJECTED drafts are rejected", async () => {
    const draft = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: fullEdition(),
    });
    await assert.rejects(() => buildPublishPayload(EditionDraft, draft._id), /DRAFT/);

    const rejected = await rejectDraft(EditionDraft, draft._id, { reason: "recheck" });
    assert.equal(rejected.status, "REJECTED");
    await assert.rejects(
      () => buildPublishPayload(EditionDraft, draft._id),
      /REJECTED/
    );
  });

  it("4. invalid VERIFIED draft is rejected (unknown essentials stay unpublishable)", async () => {
    const broken = await EditionDraft.create({
      examSlug: "phase7-test-exam",
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
    await assert.rejects(() => buildPublishPayload(EditionDraft, broken._id), /rejected/i);

    const plain = await EditionDraft.findById(broken._id).lean();
    const check = validatePublishRequest({
      draft: plain,
      payload: mapDraftToExamPayload(plain).exam,
    });
    assert.equal(check.ok, false);
    assert.ok(check.issues.exam);
  });

  it("5+6. careerType/examType stay null and no month appears", async () => {
    const id = await verifiedDraftId();
    const { exam } = await buildPublishPayload(EditionDraft, id);
    assert.equal(exam.careerType, null);
    assert.equal(exam.examType, null);
    assert.ok(!("month" in exam));
  });

  it("8. source/evidence identity is preserved", async () => {
    const rawRef = {
      documentId: new mongoose.Types.ObjectId(),
      url: "http://127.0.0.1/bulletin.html",
      checksum:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      label: "information-bulletin",
    };
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: fullEdition(),
      rawDocuments: [rawRef],
    });
    const promoted = await promoteDraft(EditionDraft, saved._id);
    const { provenance } = buildPublishPayloadFromDraft(promoted.toObject());

    assert.equal(provenance.draftId, String(saved._id));
    assert.equal(provenance.examSlug, "phase7-test-exam");
    assert.equal(provenance.year, 2026);
    assert.equal(provenance.cycle, "2026");
    assert.equal(provenance.sourceDocuments.length, 1);
    assert.equal(provenance.sourceDocuments[0].url, rawRef.url);
    assert.equal(provenance.sourceDocuments[0].checksum, rawRef.checksum);
    assert.equal(provenance.evidence.length, 1);
    assert.equal(
      provenance.evidence[0].documentUrl,
      "http://127.0.0.1/bulletin.html"
    );
  });

  it("9. no production Exam write occurs", async () => {
    const names = connection.modelNames();
    assert.ok(!names.includes("Exam"));
    for (const name of names) {
      assert.ok(connection.model(name).collection.name.startsWith("scraper_"));
    }

    for (const relative of [
      "publish/examMapper.js",
      "publish/publishValidator.js",
      "publish/publishService.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'][^"']*server\//.test(code), `${relative}: no server imports`);
      // Strip line comments so documentation mentioning forbidden calls
      // cannot trip the scan; only executable statements count.
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(!/\b(save|create|insertMany|updateOne|findOneAndUpdate|replaceOne|deleteOne|deleteMany)\s*\(/.test(
        executable.replace(/\.safeParse\s*\(/g, "")
      ), `${relative}: no database writes`);
      assert.ok(!/mongoose\.model\(["']Exam["']/.test(code));
      assert.ok(!/server\/data\/exams/.test(code) || /never/i.test(code));
      assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    }

    const countBefore = await EditionDraft.countDocuments({});
    const id = await verifiedDraftId();
    await buildPublishPayload(EditionDraft, id);
    assert.equal(await EditionDraft.countDocuments({}), countBefore + 1);
  });

  it("unknown values are preserved as null, never invented", async () => {
    const id = await verifiedDraftId();
    const draft = await EditionDraft.findById(id).lean();
    // Mapper level: UNKNOWN stays null, never invented (mapping is pure, so
    // no validation gate interferes with this assertion).
    const { exam } = mapDraftToExamPayload({
      ...draft,
      edition: {
        ...draft.edition,
        eligibility: {
          ...draft.edition.eligibility,
          stream: { allowed: null, status: "UNKNOWN", evidence: null },
        },
      },
    });
    assert.equal(exam.streams, null);
  });

  it("leaves no temporary/download artifacts in the repo", () => {
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
