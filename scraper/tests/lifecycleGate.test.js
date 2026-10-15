// =============================================================================
// scraper/tests/lifecycleGate.test.js
// =============================================================================
// WHAT: Phase 16 integration validation — the complete lifecycle on the GATE
//   2026 adapter: official-shape source → ingestion → extraction (multi-
//   category education → UNKNOWN + evidence) → saveDraft → adjudicateDraft
//   CONFIRM → review → VERIFIED → publish CLI dry-run → confirmed publish →
//   receipt + idempotency verification.
// WHY: Proves the phases compose end-to-end without behavior changes: no new
//   extractors, axes, schemas, or publish logic — only the existing generic
//   pipeline, review service, and CLI, wired in lifecycle order.
// SOURCE: local HTTP server reproducing the official site's STRUCTURE
//   (landing links, eligibility paragraphs, schedule <table>) with synthetic
//   content — the established fixture approach, no live fetch, no bypass.
// DB: isolated mongodb-memory-server ONLY. The publish CLI child process gets
//   the throwaway URI via --mongo-uri; production is never connected.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("fs");
const mongoose = require("mongoose");
const http = require("http");
const path = require("path");

const gateAdapter = require("../registry/exams/gate-2026");
const { runIngestionPipeline } = require("../pipeline/ingestionPipeline");
const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const {
  saveDraft,
  getDraft,
  reviewDraft,
  promoteDraft,
  adjudicateDraft,
} = require("../pipeline/reviewPipeline");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const CLI = path.join(__dirname, "..", "cli", "publish.js");
const SCOPED_CWD = path.join(__dirname, "..");

const ELIGIBILITY_HTML =
  "<html><head><title>GATE 2026 Eligibility</title></head><body>" +
  "<h1>Eligibility Criteria</h1>" +
  "<p>Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.</p>" +
  "<p>Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.</p>" +
  "<p>A minimum of 75% marks in aggregate is required for general category candidates seeking admission this year.</p>" +
  "<p>Eligible candidates arrive with Physics, Chemistry and Mathematics as core subjects of study.</p>" +
  "<p>Minimum age is 17 years. Applicants must be from the Science stream to be considered eligible for counselling.</p>" +
  "</body></html>";

const DATES_HTML =
  "<html><head><title>GATE 2026 Dates</title></head><body>" +
  "<h1>Important Dates</h1>" +
  "<table><tr><td>Opening of online application</td><td>August 28, 2025</td></tr>" +
  "<tr><td>Closing Date of online application</td><td>October 07, 2025</td></tr></table>" +
  "</body></html>";

describe("Phase 16 — full lifecycle on GATE 2026 (isolated, no live fetch)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let Receipt;
  let Exam;
  let server;
  let baseUrl;
  let savedMongoUri;
  let savedScraperUri;

  function adapter() {
    return {
      ...gateAdapter,
      officialWebsite: `${baseUrl}/`,
      startUrls: [`${baseUrl}/`],
      // Test-only vocabulary: the synthetic fixture exercises stream/subject
      // extraction, and the publish stage requires those axes KNOWN. The real
      // GATE adapter intentionally carries empty vocabularies.
      subjectVocabulary: [
        { canonical: "Physics", match: ["physics"] },
        { canonical: "Chemistry", match: ["chemistry"] },
        { canonical: "Mathematics", match: ["mathematics", "maths", "math"] },
      ],
      streamVocabulary: [{ canonical: "Science", match: ["science stream"] }],
    };
  }

  function runCli(args) {
    const env = { ...process.env };
    delete env.MONGO_URI;
    delete env.SCRAPER_MONGO_URI;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, ...args],
        { cwd: SCOPED_CWD, env, timeout: 120000 },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code || 1 : 0, stdout, stderr });
        }
      );
    });
  }

  function cliArgs(extra) {
    return [...extra, "--mongo-uri", mongoUri];
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    savedScraperUri = process.env.SCRAPER_MONGO_URI;
    delete process.env.MONGO_URI;
    delete process.env.SCRAPER_MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase16_lifecycle"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
    Receipt = getPublishReceiptModel(connection);
    Exam = connection.model(
      "LifecycleStandInExam",
      new mongoose.Schema({ name: String }, { strict: false }),
      "exams"
    );
    await Exam.create([
      { name: "Lifecycle Demo Exam A" },
      { name: "Lifecycle Unrelated Exam" },
    ]);

    server = http.createServer((req, res) => {
      if (req.url === "/eligibility-criteria.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ELIGIBILITY_HTML);
      } else if (req.url === "/important-dates.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(DATES_HTML);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><head><title>GATE 2026</title></head><body>" +
            '<a href="/eligibility-criteria.html">Eligibility Criteria</a>' +
            '<a href="/important-dates.html">Important Dates</a>' +
            "</body></html>"
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    if (savedScraperUri !== undefined)
      process.env.SCRAPER_MONGO_URI = savedScraperUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  it("ingest → extract → UNKNOWN+evidence → adjudicate → VERIFIED → dry-run → publish → receipt", async () => {
    const demoBefore = JSON.parse(
      JSON.stringify(
        await Exam.find({ name: /Lifecycle/ }).sort({ name: 1 }).lean()
      )
    );

    // 1–2. Ingest + extract with the unmodified generic pipeline.
    const ingestion = await runIngestionPipeline(adapter(), { mongoUri });
    assert.equal(ingestion.discovered, 2);
    assert.equal(ingestion.stored, 2);

    const extraction = await runExtractionPipeline(adapter(), {
      mongoUri,
      year: 2026,
      cycle: "2026",
    });
    assert.ok(extraction.validation.editionOk);

    // 3. Multi-category education: UNKNOWN, null, evidence preserved.
    const edu = extraction.edition.eligibility.education;
    assert.equal(edu.status, "UNKNOWN");
    assert.equal(edu.minLevel, null);
    assert.ok(edu.evidence);
    assert.match(edu.evidence.excerpt, /\[Graduate\]/);
    assert.match(edu.evidence.excerpt, /\[Post-Graduate\]/);

    // 4. Save the draft.
    const staged = await saveDraft(EditionDraft, {
      exam: extraction.exam,
      edition: extraction.edition,
    });
    assert.equal(staged.status, "DRAFT");
    const originalEvidence = JSON.parse(JSON.stringify(edu.evidence));

    // 5–6. Adjudicate CONFIRM: KNOWN, evidence byte-identical, audit, DRAFT.
    const adjudicated = await adjudicateDraft(EditionDraft, staged._id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "lifecycle-operator",
      note: "UG track confirmed",
    });
    assert.equal(adjudicated.edition.eligibility.education.status, "KNOWN");
    assert.equal(adjudicated.edition.eligibility.education.minLevel, "Graduate");
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(adjudicated.edition.eligibility.education.evidence)
      ),
      originalEvidence
    );
    assert.equal(adjudicated.adjudications.length, 1);
    assert.equal(adjudicated.adjudications[0].decidedBy, "lifecycle-operator");
    assert.equal(adjudicated.status, "DRAFT");

    // 6b. Complete the upper side on the KNOWN axis (structured completion
    // preserving the floor): extraction cannot evidence a cap or its
    // absence, and the publish gate requires it explicit.
    const completed = await adjudicateDraft(EditionDraft, staged._id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: { upperOpen: true },
      decidedBy: "lifecycle-operator",
      note: "No official upper qualification cap evidenced",
    });
    assert.equal(completed.edition.eligibility.education.status, "KNOWN");
    assert.equal(completed.edition.eligibility.education.minLevel, "Graduate");
    assert.equal(completed.edition.eligibility.education.upperOpen, true);
    assert.equal(completed.adjudications.length, 2);

    // 7–8. Review validation, then promote.
    assert.equal(reviewDraft(completed).valid, true);
    const verified = await promoteDraft(EditionDraft, staged._id);
    assert.equal(verified.status, "VERIFIED");

    // 9–10. Publish CLI dry-run: valid, correct identity/target, no write.
    const dry = await runCli(cliArgs(["--draft", String(staged._id)]));
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /DRY RUN/);
    assert.match(dry.stdout, /gate-2026:2026:2026/);
    assert.match(dry.stdout, /would-create/);
    assert.match(dry.stdout, /"wrote": false/);
    assert.equal(await Exam.countDocuments({ name: "GATE 2026" }), 0);
    assert.equal(await Receipt.countDocuments({}), 0);

    // 11–12. Confirmed publish (isolated DB): one Exam + one receipt.
    const pub = await runCli(
      cliArgs(["--draft", String(staged._id), "--confirm", "--by", "lifecycle-operator"])
    );
    assert.equal(pub.code, 0);
    assert.match(pub.stdout, /PUBLISHED/);
    const published = await Exam.find({ name: "GATE 2026" }).lean();
    assert.equal(published.length, 1);
    assert.equal(published[0].minimumEducationLevel, "Graduate");
    assert.equal(published[0].noUpperEducationLimit, true);
    const receipts = await Receipt.find({}).lean();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].identity, "gate-2026:2026:2026");
    assert.equal(String(receipts[0].draftId), String(staged._id));
    assert.equal(String(receipts[0].examId), String(published[0]._id));

    // 13. Republish converges without duplicates.
    const again = await runCli(
      cliArgs(["--draft", String(staged._id), "--confirm"])
    );
    assert.equal(again.code, 0);
    assert.match(again.stdout, /ALREADY PUBLISHED/);
    assert.equal((await Exam.find({ name: "GATE 2026" }).lean()).length, 1);
    assert.equal((await Receipt.find({}).lean()).length, 1);

    // 14. Seeded records byte-identical.
    const demoAfter = JSON.parse(
      JSON.stringify(
        await Exam.find({ name: /Lifecycle/ }).sort({ name: 1 }).lean()
      )
    );
    assert.deepEqual(demoAfter, demoBefore);
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
