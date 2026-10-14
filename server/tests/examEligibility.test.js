// =============================================================================
// server/tests/examEligibility.test.js
// =============================================================================
// WHAT: Flexible-eligibility redesign coverage for the NextStep backend.
// WHY: Nullable streams/subjects/education must validate, recommend safely,
//   stay seed-compatible, and never become invented values. Manual edits must
//   stay distinguishable from scraper/seed data.
// DB: none. Schema validation via validateSync() and pure helper calls only.
// RUN: npm test (node --test tests/)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const Exam = require("../models/Exam");
const seedExams = require("../data/exams");
const {
    examMatchesStream,
    examMatchesEducation,
    examMatchesAge,
    examMatchesPercentage,
    userMatchesExamSubjects,
    isEligibleForExam,
    filterEligibleExams,
} = require("../utils/eligibility");
const {
    applyManualEligibility,
    addCustomEligibility,
    updateCustomEligibility,
    removeCustomEligibility,
    getFieldProvenance,
} = require("../services/examEligibilityService");

const baseExam = (overrides = {}) => ({
    name: "Null Test Exam",
    fullForm: "Null Test Examination",
    streams: ["Science"],
    subjects: ["Physics"],
    minimumEducationLevel: "12",
    registrationStartDate: new Date("2026-01-15"),
    registrationEndDate: new Date("2026-02-20"),
    officialWebsite: "https://example.com/exam",
    ...overrides,
});

const scienceGraduate = {
    educationLevel: "Graduate",
    stream: "Science",
    percentage: 80,
    subjects: ["Physics"],
};

describe("flexible eligibility — nullable schema", () => {
    it("2. exam with null streams is valid", () => {
        const doc = new Exam(baseExam({ streams: null }));
        assert.equal(doc.validateSync(), undefined);
        assert.equal(doc.streams, null);
    });

    it("3. exam with null subjects is valid", () => {
        const doc = new Exam(baseExam({ subjects: null }));
        assert.equal(doc.validateSync(), undefined);
        assert.equal(doc.subjects, null);
    });

    it("4. exam with both null (+ null education/ages) is valid", () => {
        const doc = new Exam(
            baseExam({
                streams: null,
                subjects: null,
                minimumEducationLevel: null,
                minimumAge: null,
                maximumAge: null,
                eligibility: { minimumPercentage: null },
            })
        );
        assert.equal(doc.validateSync(), undefined);
    });

    it("5. null minimumAge is valid; maximumAge bounds validate", () => {
        assert.equal(new Exam(baseExam({ minimumAge: null })).validateSync(), undefined);
        const ok = new Exam(baseExam({ minimumAge: 17, maximumAge: 25 }));
        assert.equal(ok.validateSync(), undefined);
    });

    it("6. null minimumPercentage is valid", () => {
        const doc = new Exam(baseExam({ eligibility: { minimumPercentage: null } }));
        assert.equal(doc.validateSync(), undefined);
    });

    it("rejects duplicate customEligibility keys", () => {
        const doc = new Exam(
            baseExam({
                customEligibility: [
                    { key: "license", label: "License", value: "X" },
                    { key: "license", label: "License 2", value: "Y" },
                ],
            })
        );
        assert.ok(doc.validateSync());
    });

    it("15. no location field exists on the schema", () => {
        const paths = Object.keys(Exam.schema.paths);
        assert.ok(!paths.some((p) => /location/i.test(p)), `unexpected location path: ${paths}`);
        const doc = new Exam(baseExam({ location: "Delhi" }));
        assert.equal(doc.location, undefined);
    });

    it("14. careerType/examType null behavior unchanged (optional, enum-guarded)", () => {
        assert.equal(new Exam(baseExam({ careerType: null, examType: null })).validateSync(), undefined);
        assert.equal(new Exam(baseExam({})).validateSync(), undefined);
        assert.ok(new Exam(baseExam({ careerType: "NOPE" })).validateSync());
    });
});

describe("flexible eligibility — null-safe recommendation", () => {
    it("7. null streams never exclude (both user streams pass)", () => {
        assert.equal(examMatchesStream(null, "Science"), true);
        assert.equal(examMatchesStream([], "Commerce"), true);
        assert.equal(examMatchesStream(undefined, "Arts/Humanities"), true);
    });

    it("existing stream matching still works", () => {
        assert.equal(examMatchesStream(["Science"], "Science"), true);
        assert.equal(examMatchesStream(["Science"], "Commerce"), false);
        assert.equal(examMatchesStream(["General (all streams)"], "Commerce"), true);
    });

    it("8. null subjects never exclude; matching still works", () => {
        assert.equal(userMatchesExamSubjects(["Physics"], { streams: null, subjects: null }), true);
        assert.equal(
            userMatchesExamSubjects(["Physics"], { streams: ["Science"], subjects: ["Physics"] }),
            true
        );
        assert.equal(
            userMatchesExamSubjects(["History"], { streams: ["Science"], subjects: ["Physics"] }),
            false
        );
    });

    it("null education bar never excludes; ranked checks still work", () => {
        assert.equal(examMatchesEducation(null, "10"), true);
        assert.equal(examMatchesEducation("12", "Graduate"), true);
        assert.equal(examMatchesEducation("Graduate", "12"), false);
    });

    it("null age bounds never exclude; maximumAge gates above-max users", () => {
        assert.equal(examMatchesAge({ minimumAge: null, maximumAge: null }, null), true);
        assert.equal(examMatchesAge({ minimumAge: 17, maximumAge: 25 }, 30), false);
        assert.equal(examMatchesAge({ minimumAge: 17, maximumAge: 25 }, 20), true);
        assert.equal(examMatchesAge({ minimumAge: 17 }, null), false);
    });

    it("null percentage never excludes", () => {
        assert.equal(examMatchesPercentage({ eligibility: { minimumPercentage: null } }, 10), true);
        assert.equal(examMatchesPercentage({ eligibility: { minimumPercentage: 50 } }, 40), false);
    });

    it("GATE-shaped exam (all-null eligibility) matches a graduate profile", () => {
        const gateLike = {
            streams: null,
            subjects: null,
            minimumEducationLevel: "Graduate",
            // Explicit upper semantics are required: without them the exam
            // is UNKNOWN-upper and must not silently qualify (see the
            // bidirectional education contract in utils/eligibility.js).
            maximumEducationLevel: null,
            noUpperEducationLimit: true,
            minimumAge: null,
            maximumAge: null,
            eligibility: { minimumPercentage: null },
        };
        assert.equal(isEligibleForExam(gateLike, scienceGraduate), true);
        // Same exam with unknown upper restriction: conservative exclusion.
        const gateUnknownUpper = { ...gateLike, noUpperEducationLimit: null };
        assert.equal(isEligibleForExam(gateUnknownUpper, scienceGraduate), false);
    });
});

describe("flexible eligibility — seed compatibility", () => {
    it("9. all 50 seeded exams validate under the new schema", () => {
        assert.equal(seedExams.length, 50);
        const failures = [];
        for (const entry of seedExams) {
            const err = new Exam(entry).validateSync();
            if (err) failures.push(`${entry.name}: ${err.message}`);
        }
        assert.deepEqual(failures, []);
    });

    it("9. seeded values survive intact (no null coercion)", () => {
        const ntse = new Exam(seedExams.find((e) => e.name === "NTSE")).toObject();
        assert.deepEqual(ntse.streams, ["General (all streams)"]);
        assert.equal(ntse.minimumEducationLevel, "10");
        const neet = new Exam(seedExams.find((e) => e.name === "NEET UG")).toObject();
        assert.equal(neet.minimumAge, 17);
        assert.equal(neet.eligibility.minimumPercentage, 50);
    });

    it("9. seeded recommendation behavior unchanged (spot check)", () => {
        const before = filterEligibleExams(seedExams, {
            educationLevel: "Graduate",
            stream: "Science",
            percentage: 80,
            age: 20,
            subjects: ["Physics", "Chemistry", "Mathematics", "Biology"],
        });
        const names = before.map((e) => e.name);
        assert.ok(names.includes("JEE Main"));
        assert.ok(names.includes("NEET UG"));
        assert.ok(!names.includes("CLAT UG"));
    });

    it("16. seed.js is idempotent and non-destructive (upsert by name, no wipe)", () => {
        const fs = require("fs");
        const path = require("path");
        const code = fs.readFileSync(path.join(__dirname, "..", "seed.js"), "utf8");
        // Destructive patterns must be gone.
        assert.ok(!/deleteMany/.test(code));
        assert.ok(!/insertMany/.test(code));
        // Safety contract markers must be present.
        assert.ok(/findOne\(\{\s*name/.test(code));
        assert.ok(/updateOne/.test(code));
        assert.ok(/createIndex\(\{\s*name:\s*1\s*\}.*unique/.test(code));
        assert.ok(/MANUAL/.test(code) && /MIXED/.test(code));
    });
});

describe("flexible eligibility — manual edits & custom criteria", () => {
    it("10. custom eligibility can be stored and read", () => {
        const doc = new Exam(
            baseExam({
                customEligibility: [
                    { key: "license", label: "Professional registration", value: "Valid MCI registration" },
                ],
            })
        );
        assert.equal(doc.validateSync(), undefined);
        assert.equal(doc.customEligibility[0].source, "MANUAL");
    });

    it("11. manual corrections stamp MANUAL provenance and stay distinguishable", () => {
        const doc = new Exam(baseExam({ streams: null }));
        applyManualEligibility(doc, {
            field: "streams",
            value: ["Science"],
            updatedBy: "operator@example.com",
            note: "Confirmed on official bulletin",
        });
        assert.deepEqual(doc.streams, ["Science"]);
        assert.equal(doc.origin, "MIXED");
        assert.equal(doc.manualEdits.length, 1);
        assert.equal(doc.manualEdits[0].source, "MANUAL");
        assert.equal(doc.manualEdits[0].updatedBy, "operator@example.com");
        assert.equal(getFieldProvenance(doc, "streams"), "MANUAL");
        // Unedited fields report the record origin (now MIXED after the human
        // touch) — still distinguishable from the MANUAL edit above.
        assert.equal(getFieldProvenance(doc, "subjects"), "MIXED");
    });

    it("11. null clears a field back without inventing", () => {
        const doc = new Exam(baseExam({}));
        applyManualEligibility(doc, { field: "subjects", value: null, updatedBy: "op" });
        assert.equal(doc.subjects, null);
    });

    it("11. manual edits reject unknown fields and bad values", () => {
        const doc = new Exam(baseExam({}));
        assert.throws(() => applyManualEligibility(doc, { field: "location", value: "Delhi" }), /unknown field/);
        assert.throws(() => applyManualEligibility(doc, { field: "streams", value: [""] }), /invalid value/);
        assert.throws(
            () => applyManualEligibility(doc, { field: "minimumEducationLevel", value: "Kindergarten" }),
            /invalid value/
        );
        assert.throws(
            () => applyManualEligibility(doc, { field: "eligibility.minimumPercentage", value: 150 }),
            /invalid value/
        );
    });

    it("10/11. custom add/update/remove with audit trail", () => {
        const doc = new Exam(baseExam({}));
        addCustomEligibility(doc, { key: "license", label: "Registration", value: "MCI", updatedBy: "op" });
        assert.equal(doc.customEligibility.length, 1);
        assert.throws(
            () => addCustomEligibility(doc, { key: "license", label: "Dup", value: "X" }),
            /already exists/
        );
        assert.throws(() => addCustomEligibility(doc, { key: "Bad Key!", label: "L", value: "V" }), /key must match/);
        updateCustomEligibility(doc, "license", { value: "NMC" });
        assert.equal(doc.customEligibility[0].value, "NMC");
        removeCustomEligibility(doc, "license", { updatedBy: "op" });
        assert.equal(doc.customEligibility.length, 0);
        assert.ok(doc.manualEdits.length >= 3);
        assert.equal(doc.origin, "MIXED");
    });

    it("3. seed records keep origin SEED; SCRAPER records flip to MIXED on manual edit", () => {
        const seedDoc = new Exam(seedExams[0]);
        assert.equal(seedDoc.origin, "SEED");
        const scraperDoc = new Exam(baseExam({ origin: "SCRAPER", streams: null }));
        assert.equal(scraperDoc.validateSync(), undefined);
        applyManualEligibility(scraperDoc, { field: "streams", value: ["Science"], updatedBy: "op" });
        assert.equal(scraperDoc.origin, "MIXED");
        assert.equal(getFieldProvenance(scraperDoc, "streams"), "MANUAL");
    });

    it("13. unknown values are never converted into invented values", () => {
        // Null stays null through matching and manual paths.
        assert.equal(examMatchesStream(null, "Science"), true);
        const doc = new Exam(baseExam({ streams: null, subjects: null }));
        assert.equal(doc.streams, null);
        assert.equal(doc.subjects, null);
        assert.notDeepEqual(doc.streams, []);
    });
});
