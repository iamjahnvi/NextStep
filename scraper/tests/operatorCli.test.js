// =============================================================================
// scraper/tests/operatorCli.test.js
// =============================================================================
// WHAT: Phase 9 tests — operator CLI delegates to the Phase 8 executor with
//   a dry-run default and an explicit --confirm gate.
// WHY: Proves the only new capability (manual CLI publish) cannot write
//   accidentally: defaults describe, confirm writes exactly once, failures
//   exit non-zero with no side effects.
// DB: isolated mongodb-memory-server ONLY. The CLI child process receives the
//   throwaway URI via --mongo-uri; the real production database is never
//   connected (MONGO_URI is unset for the suite).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const { saveDraft, promoteDraft } = require("../pipeline/reviewPipeline");
const { parseArgs, resolveMongoUri } = require("../cli/publish");
const {
  startIsolatedDb,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const CLI = path.join(__dirname, "..", "cli", "publish.js");
const SCOPED_CWD = path.join(__dirname, "..");

function validExam() {
  return {
    slug: "phase9-test-exam",
    name: "Phase9 Test Exam",
    fullForm: "Phase Nine Test Examination",
    conductingBody: "Phase Nine Test Board",
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

function fullEdition(cycle = "2026") {
  return {
    examSlug: "phase9-test-exam",
    year: 2026,
    cycle,
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      education: {
        minLevel: "12",
        maxLevel: null,
        // Completed upper semantics (operator-confirmed): the publish gate
        // requires an explicit upper side — extraction-shaped drafts stay
        // staged for review instead of publishing.
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
  };
}

describe("Phase 9 — operator CLI (manual publish, dry-run default)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let Receipt;
  let Exam;
  let savedMongoUri;
  let savedScraperUri;

  function runCli(args, envOverrides = {}) {
    const env = { ...process.env, ...envOverrides };
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
    ({ mongod, mongoUri } = await startIsolatedDb("phase9_cli"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    EditionDraft = getExamEditionDraftModel(connection);
    Receipt = getPublishReceiptModel(connection);
    // The CLI wires the real server Exam model; here we observe the same
    // "exams" collection through an isolated stand-in on the throwaway DB.
    Exam = connection.model(
      "CliStandInExam",
      new mongoose.Schema({ name: String }, { strict: false }),
      "exams"
    );
    await Exam.create({ name: "Pre-existing Demo Exam" });
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    if (savedScraperUri !== undefined)
      process.env.SCRAPER_MONGO_URI = savedScraperUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function verifiedDraftId(cycle = "2026") {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: fullEdition(cycle),
    });
    const promoted = await promoteDraft(EditionDraft, saved._id);
    return String(promoted._id);
  }

  it("defaults to dry-run and writes nothing", async () => {
    const id = await verifiedDraftId("2026-cli-a");
    const examsBefore = await Exam.countDocuments({});
    const receiptsBefore = await Receipt.countDocuments({});

    const { code, stdout } = await runCli(cliArgs(["--draft", id]));
    assert.equal(code, 0);
    assert.match(stdout, /DRY RUN/);
    assert.match(stdout, /defaulting to dry-run/);
    assert.match(stdout, /Phase9 Test Exam/);
    assert.match(stdout, /phase9-test-exam:2026:2026-cli-a/);
    assert.equal(await Exam.countDocuments({}), examsBefore);
    assert.equal(await Receipt.countDocuments({}), receiptsBefore);
  });

  it("--dry-run describes without writing", async () => {
    const id = await verifiedDraftId("2026-cli-b");
    const { code, stdout } = await runCli(
      cliArgs(["--draft", id, "--dry-run"])
    );
    assert.equal(code, 0);
    assert.match(stdout, /DRY RUN/);
    assert.equal(
      (await Exam.find({ name: "Phase9 Test Exam" }).lean()).length,
      0
    );
  });

  it("--confirm publishes once with a receipt", async () => {
    const id = await verifiedDraftId("2026-cli-c");
    const { code, stdout } = await runCli(
      cliArgs(["--draft", id, "--confirm", "--by", "operator-1"])
    );
    assert.equal(code, 0);
    assert.match(stdout, /PUBLISHED/);
    assert.match(stdout, /production exam _id/);

    const published = await Exam.find({ name: "Phase9 Test Exam" }).lean();
    assert.equal(published.length, 1);
    assert.equal(published[0].minimumEducationLevel, "12");
    assert.equal(published[0].careerType, null);
    assert.ok(!("month" in published[0]));
    assert.equal(
      await Receipt.countDocuments({
        identity: "phase9-test-exam:2026:2026-cli-c",
      }),
      1
    );

    // Republish converges: no duplicate, explicit already-published output.
    const again = await runCli(cliArgs(["--draft", id, "--confirm"]));
    assert.equal(again.code, 0);
    assert.match(again.stdout, /ALREADY PUBLISHED/);
    assert.equal(
      (await Exam.find({ name: "Phase9 Test Exam" }).lean()).length,
      1
    );
  });

  it("refuses non-VERIFIED drafts without writing", async () => {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: fullEdition("2026-cli-d"),
    });
    const examsBefore = await Exam.countDocuments({});
    const { code, stderr } = await runCli(
      cliArgs(["--draft", String(saved._id), "--confirm"])
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /DRAFT/);
    assert.equal(await Exam.countDocuments({}), examsBefore);
  });

  it("rejects usage errors without side effects", async () => {
    const examsBefore = await Exam.countDocuments({});
    const noDraft = await runCli(cliArgs([]));
    assert.notEqual(noDraft.code, 0);
    assert.match(noDraft.stderr, /--draft/);

    const id = await verifiedDraftId("2026-cli-e");
    const both = await runCli(cliArgs(["--draft", id, "--dry-run", "--confirm"]));
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /either/);
    assert.equal(await Exam.countDocuments({}), examsBefore);
  });

  it("requires a URI when none is configured", async () => {
    const id = await verifiedDraftId("2026-cli-f");
    const env = { ...process.env };
    delete env.MONGO_URI;
    delete env.SCRAPER_MONGO_URI;
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, "--draft", id],
        { cwd: SCOPED_CWD, env, timeout: 120000 },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code || 1 : 0, stdout, stderr });
        }
      );
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MongoDB URI/);
  });

  it("arg parsing and URI resolution are pure and conventional", () => {
    assert.deepEqual(parseArgs(["--draft", "abc", "--confirm", "--by", "op"]), {
      draftId: "abc",
      dryRun: false,
      confirm: true,
      by: "op",
      mongoUri: null,
      help: false,
      adjudicateId: null,
      axis: null,
      decision: null,
      value: null,
      note: null,
      driftReport: null,
      showAdjudications: null,
    });
    assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
    assert.equal(
      resolveMongoUri("flag-uri", { MONGO_URI: "env-uri" }),
      "flag-uri"
    );
    assert.equal(
      resolveMongoUri(null, { SCRAPER_MONGO_URI: "s", MONGO_URI: "m" }),
      "s"
    );
    assert.equal(resolveMongoUri(null, { MONGO_URI: "m" }), "m");
    assert.throws(() => resolveMongoUri(null, {}), /MongoDB URI/);
  });

  it("CLI delegates to the executor and touches no other systems", () => {
    const code = fs.readFileSync(CLI, "utf8");
    assert.ok(/publishExecutor/.test(code), "must reuse Phase 8 executor");
    assert.ok(!/require\(["'][^"']*server\/(data|seed)/.test(code));
    assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(!/\.save\(|insertMany|updateOne|deleteOne|deleteMany|dropDatabase/.test(executable));
  });

  it("demo records survive CLI runs untouched", async () => {
    const demos = await Exam.find({ name: "Pre-existing Demo Exam" }).lean();
    assert.equal(demos.length, 1);
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
