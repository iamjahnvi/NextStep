// =============================================================================
// server/tests/educationEligibility.test.js
// =============================================================================
// WHAT: Bidirectional education-eligibility contract for NextStep.
// WHY: Minimum-only matching let graduates match school-only exams, and
//   unknown bounds silently qualified everyone. Every exam must enforce its
//   range in BOTH directions; unknown/contradictory data must exclude
//   conservatively (never silently qualify).
// HOW: (1) table-driven matrix over the REAL service (isEligibleForExam /
//   examMatchesEducation / describeEducationEligibility) with synthetic
//   fixtures per category (clearly labeled SYNTHETIC — never presented as
//   official rules); (2) spot checks against the REAL reviewed seed dataset;
//   (3) the REAL recommend/discover controller path on an isolated database;
//   (4) seed idempotency/safety against an isolated database.
// RUN: npm test (node --test tests/)
// =============================================================================

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Exam = require("../models/Exam");
const seedExams = require("../data/exams");
const {
    examMatchesEducation,
    describeEducationEligibility,
    normalizeAlternativeQualifications,
    isEligibleForExam,
    filterEligibleExams,
} = require("../utils/eligibility");
const { getEducationRank } = require("../utils/educationLevels");
const { seedDatabase } = require("../seed");
const { recommendExams, discoverExams } = require("../controllers/examController");

// -----------------------------------------------------------------------------
// SYNTHETIC fixtures (edge-case matrix only). All other axes neutralized
// (null streams/subjects/ages/percentage) so ONLY education decides.
// -----------------------------------------------------------------------------
const NEUTRAL = {
    streams: null,
    subjects: null,
    minimumAge: null,
    maximumAge: null,
    eligibility: { minimumPercentage: null },
};

const syntheticExam = (name, education) => ({
    name,
    fullForm: `${name} Synthetic Fixture`,
    registrationStartDate: new Date("2026-01-15"),
    registrationEndDate: new Date("2026-02-20"),
    officialWebsite: "https://example.com/exam",
    ...NEUTRAL,
    ...education,
});

const FIXTURES = {
    class8Only: syntheticExam("SYN Class 8 Only", {
        minimumEducationLevel: "8", maximumEducationLevel: "8",
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    class8to10: syntheticExam("SYN Class 8-10", {
        minimumEducationLevel: "8", maximumEducationLevel: "10",
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    class10Only: syntheticExam("SYN Class 10 Only", {
        minimumEducationLevel: "10", maximumEducationLevel: "10",
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    class12Cap: syntheticExam("SYN Capped At 12", {
        minimumEducationLevel: "8", maximumEducationLevel: "12",
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    bachelorMin: syntheticExam("SYN Bachelor Minimum", {
        minimumEducationLevel: "Graduate", maximumEducationLevel: null,
        noUpperEducationLimit: true, alternativeQualifications: null,
    }),
    masterMin: syntheticExam("SYN Master Minimum", {
        minimumEducationLevel: "Post-Graduate", maximumEducationLevel: null,
        noUpperEducationLimit: true, alternativeQualifications: null,
    }),
    openSchoolMin: syntheticExam("SYN Open School Minimum", {
        minimumEducationLevel: "12", maximumEducationLevel: null,
        noUpperEducationLimit: true, alternativeQualifications: null,
    }),
    unknownAll: syntheticExam("SYN Unknown All", {
        minimumEducationLevel: null, maximumEducationLevel: null,
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    unknownUpper: syntheticExam("SYN Unknown Upper", {
        minimumEducationLevel: "12", maximumEducationLevel: null,
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    alternativeDiploma: syntheticExam("SYN Diploma Pathway", {
        minimumEducationLevel: "Graduate", maximumEducationLevel: null,
        noUpperEducationLimit: true, alternativeQualifications: ["Diploma"],
    }),
    contradictory: syntheticExam("SYN Contradictory", {
        minimumEducationLevel: "Graduate", maximumEducationLevel: "12",
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    malformed: syntheticExam("SYN Malformed", {
        minimumEducationLevel: "Kindergarten", maximumEducationLevel: null,
        noUpperEducationLimit: null, alternativeQualifications: null,
    }),
    legacyMissing: {
        // Pre-model document: minimum only, new fields absent entirely.
        name: "SYN Legacy",
        fullForm: "SYN Legacy Fixture",
        registrationStartDate: new Date("2026-01-15"),
        registrationEndDate: new Date("2026-02-20"),
        officialWebsite: "https://example.com/exam",
        ...NEUTRAL,
        minimumEducationLevel: "12",
    },
};

// Complete profiles per student level (other axes neutral-to-passing).
const studentProfile = (educationLevel) => ({
    educationLevel,
    stream: "Science",
    percentage: 80,
    subjects: ["Physics"],
    dateOfBirth: new Date("2000-01-01"),
});

const LEVELS = ["8", "9", "10", "11", "12", "Diploma", "Graduate", "Post-Graduate", "Doctorate"];

const eligibleNames = (exams, level) =>
    filterEligibleExams(exams, studentProfile(level)).map((e) => e.name);

describe("education model — canonical levels and states", () => {
    it("Diploma ranks between Class 12 and Graduate", () => {
        assert.ok(getEducationRank("12") < getEducationRank("Diploma"));
        assert.ok(getEducationRank("Diploma") < getEducationRank("Graduate"));
        assert.equal(getEducationRank("polytechnic"), getEducationRank("Diploma"));
    });

    it("describeEducationEligibility classifies BOUNDED / OPEN / UNKNOWN / CONTRADICTORY", () => {
        assert.equal(describeEducationEligibility(FIXTURES.class8Only).state, "BOUNDED");
        assert.equal(describeEducationEligibility(FIXTURES.class8to10).state, "BOUNDED");
        assert.equal(describeEducationEligibility(FIXTURES.bachelorMin).state, "OPEN");
        assert.equal(describeEducationEligibility(FIXTURES.unknownAll).state, "UNKNOWN");
        assert.equal(describeEducationEligibility(FIXTURES.unknownUpper).state, "UNKNOWN");
        assert.equal(describeEducationEligibility(FIXTURES.contradictory).state, "CONTRADICTORY");
        assert.equal(describeEducationEligibility(FIXTURES.malformed).state, "UNKNOWN");
        assert.equal(describeEducationEligibility(FIXTURES.legacyMissing).state, "UNKNOWN");
        assert.equal(describeEducationEligibility(null).state, "UNKNOWN");
    });

    it("alternative pathways normalize to canonical levels only", () => {
        assert.deepEqual(normalizeAlternativeQualifications(["Diploma", "diploma", "Narnia"]), ["Diploma"]);
        assert.deepEqual(normalizeAlternativeQualifications(null), []);
        assert.deepEqual(normalizeAlternativeQualifications("Graduate"), ["Graduate"]);
    });

    it("schema rejects malformed levels and contradictory ranges", () => {
        assert.ok(new Exam(FIXTURES.malformed).validateSync());
        assert.ok(new Exam(FIXTURES.contradictory).validateSync());
        assert.equal(new Exam(FIXTURES.class8to10).validateSync(), undefined);
    });
});

describe("bidirectional matrix — synthetic fixtures via the real service", () => {
    const all = Object.values(FIXTURES);

    it("Class 8 matches only its own band and open school floors it meets", () => {
        const names = eligibleNames(all, "8");
        assert.ok(names.includes("SYN Class 8 Only"));
        assert.ok(names.includes("SYN Class 8-10"));
        assert.ok(!names.includes("SYN Class 10 Only"));
        assert.ok(names.includes("SYN Capped At 12"));
        assert.ok(!names.includes("SYN Bachelor Minimum"));
        assert.ok(!names.includes("SYN Master Minimum"));
        assert.ok(!names.includes("SYN Open School Minimum"));
        assert.ok(!names.includes("SYN Unknown All"));
        assert.ok(!names.includes("SYN Unknown Upper"));
        assert.ok(!names.includes("SYN Diploma Pathway"));
        assert.ok(!names.includes("SYN Contradictory"));
        assert.ok(!names.includes("SYN Malformed"));
        assert.ok(!names.includes("SYN Legacy"));
    });

    it("Classes 8-10 band: boundaries in, neighbours out", () => {
        for (const level of ["8", "9", "10"]) {
            assert.ok(
                eligibleNames(all, level).includes("SYN Class 8-10"),
                `${level} should match 8-10`
            );
        }
        for (const level of ["11", "12", "Diploma", "Graduate", "Post-Graduate", "Doctorate"]) {
            assert.ok(
                !eligibleNames(all, level).includes("SYN Class 8-10"),
                `${level} must not match 8-10`
            );
        }
    });

    it("Class 8-only never matches Class 9+", () => {
        assert.ok(eligibleNames(all, "8").includes("SYN Class 8 Only"));
        for (const level of ["9", "10", "11", "12", "Diploma", "Graduate", "Post-Graduate", "Doctorate"]) {
            assert.ok(
                !eligibleNames(all, level).includes("SYN Class 8 Only"),
                `${level} must not match 8-only`
            );
        }
    });

    it("graduates cannot match school-capped exams; postgraduates neither", () => {
        for (const level of ["Graduate", "Post-Graduate", "Doctorate"]) {
            const names = eligibleNames(all, level);
            assert.ok(!names.includes("SYN Class 8 Only"), `${level} vs 8-only`);
            assert.ok(!names.includes("SYN Class 8-10"), `${level} vs 8-10`);
            assert.ok(!names.includes("SYN Class 10 Only"), `${level} vs 10-only`);
            assert.ok(!names.includes("SYN Capped At 12"), `${level} vs 12-cap`);
        }
    });

    it("Class 12 cannot match degree minima; graduates cannot match master minima", () => {
        assert.ok(!eligibleNames(all, "12").includes("SYN Bachelor Minimum"));
        assert.ok(!eligibleNames(all, "12").includes("SYN Master Minimum"));
        assert.ok(!eligibleNames(all, "Graduate").includes("SYN Master Minimum"));
        assert.ok(eligibleNames(all, "Graduate").includes("SYN Bachelor Minimum"));
        assert.ok(eligibleNames(all, "Post-Graduate").includes("SYN Master Minimum"));
        assert.ok(eligibleNames(all, "Post-Graduate").includes("SYN Bachelor Minimum"));
        assert.ok(eligibleNames(all, "Doctorate").includes("SYN Master Minimum"));
    });

    it("higher-qualified students keep open school-minimum exams", () => {
        for (const level of ["12", "Diploma", "Graduate", "Post-Graduate", "Doctorate"]) {
            assert.ok(
                eligibleNames(all, level).includes("SYN Open School Minimum"),
                `${level} keeps open 12-min exam`
            );
        }
        assert.ok(!eligibleNames(all, "11").includes("SYN Open School Minimum"));
    });

    it("alternative pathways admit the listed level below the minimum — and nothing else", () => {
        assert.ok(eligibleNames(all, "Diploma").includes("SYN Diploma Pathway"));
        assert.ok(!eligibleNames(all, "12").includes("SYN Diploma Pathway"));
        assert.ok(!eligibleNames(all, "10").includes("SYN Diploma Pathway"));
        assert.ok(eligibleNames(all, "Post-Graduate").includes("SYN Diploma Pathway"));
        // Alternatives never override an explicit cap.
        const cappedAlt = syntheticExam("SYN Capped Alt", {
            minimumEducationLevel: "Graduate", maximumEducationLevel: "Graduate",
            noUpperEducationLimit: null, alternativeQualifications: ["Diploma"],
        });
        assert.equal(
            isEligibleForExam(cappedAlt, studentProfile("Post-Graduate")),
            false,
            "cap still excludes above-max even with alternatives present"
        );
        assert.equal(isEligibleForExam(cappedAlt, studentProfile("Diploma")), true);
    });

    it("unknown/contradictory/malformed/legacy never silently qualify anyone", () => {
        for (const level of LEVELS) {
            const names = eligibleNames(all, level);
            assert.ok(!names.includes("SYN Unknown All"), `${level} vs unknown`);
            assert.ok(!names.includes("SYN Unknown Upper"), `${level} vs unknown-upper`);
            assert.ok(!names.includes("SYN Contradictory"), `${level} vs contradictory`);
            assert.ok(!names.includes("SYN Malformed"), `${level} vs malformed`);
            assert.ok(!names.includes("SYN Legacy"), `${level} vs legacy-missing`);
        }
    });

    it("missing or unrecognized student levels are handled conservatively", () => {
        for (const bad of [undefined, null, "", "Kindergarten", "Class 13"]) {
            assert.equal(
                isEligibleForExam(FIXTURES.openSchoolMin, studentProfile(bad)),
                false,
                `student level ${JSON.stringify(bad)} must not match`
            );
        }
    });
});

describe("real seed records — reviewed education behavior", () => {
    const byName = (name) => seedExams.find((e) => e.name === name);
    const gradScience = studentProfile("Graduate");
    const class8Science = { ...studentProfile("8"), dateOfBirth: new Date("2013-01-01") };

    it("Class 8 never receives IIT JAM (verified: bachelor's required, no age cap)", () => {
        const jam = byName("IIT JAM");
        assert.equal(jam.minimumEducationLevel, "Graduate");
        assert.equal(jam.noUpperEducationLimit, true);
        assert.equal(isEligibleForExam(jam, class8Science), false);
    });

    it("IIT JAM matches an eligible graduate on the real record", () => {
        const jam = byName("IIT JAM");
        assert.equal(
            isEligibleForExam(jam, { ...gradScience, percentage: 60, subjects: ["Physics"] }),
            true
        );
    });

    it("UGC NET requires a master's (verified) — graduates excluded, postgraduates in", () => {
        const net = byName("UGC NET");
        assert.equal(net.minimumEducationLevel, "Post-Graduate");
        assert.equal(isEligibleForExam(net, { ...gradScience, percentage: 60 }), false);
        assert.equal(
            isEligibleForExam(net, { ...studentProfile("Post-Graduate"), percentage: 60 }),
            true
        );
    });

    it("school-only scholarships exclude graduates (verified bounds)", () => {
        assert.deepEqual(
            [byName("NTSE").maximumEducationLevel, byName("NMMS").maximumEducationLevel],
            ["10", "8"]
        );
        // NTSE names Mathematics in its subjects, so the profile carries it
        // (subject gating is orthogonal to the education band under test).
        const class10Maths = { ...studentProfile("10"), percentage: 60, subjects: ["Mathematics"] };
        assert.equal(isEligibleForExam(byName("NTSE"), class10Maths), true);
        assert.equal(isEligibleForExam(byName("NTSE"), gradScience), false);
        assert.equal(isEligibleForExam(byName("NMMS"), { ...class8Science, percentage: 60 }), true);
        assert.equal(isEligibleForExam(byName("NMMS"), studentProfile("9")), false);
        assert.equal(isEligibleForExam(byName("NMMS"), gradScience), false);
    });

    it("RMO-INMO band 8-12 (verified) admits the band, rejects outsiders", () => {
        const rmo = byName("RMO-INMO");
        assert.equal(rmo.minimumEducationLevel, "8");
        assert.equal(rmo.maximumEducationLevel, "12");
        // RMO names Mathematics in its subjects — carried so only the
        // education band decides here.
        for (const level of ["8", "9", "10", "11", "12"]) {
            assert.equal(
                isEligibleForExam(rmo, { ...studentProfile(level), subjects: ["Mathematics"] }),
                true,
                `${level} should match RMO-INMO`
            );
        }
        assert.equal(isEligibleForExam(rmo, gradScience), false);
    });

    it("every seed record carries explicit upper semantics (no silent unknown)", () => {
        const bad = seedExams.filter(
            (e) => describeEducationEligibility(e).state === "UNKNOWN"
        );
        assert.deepEqual(bad.map((e) => e.name), []);
        const contradictory = seedExams.filter(
            (e) => describeEducationEligibility(e).state === "CONTRADICTORY"
        );
        assert.deepEqual(contradictory.map((e) => e.name), []);
    });
});

describe("education combines with all other mandatory criteria", () => {
    const gated = syntheticExam("SYN Combined", {
        minimumEducationLevel: "8",
        maximumEducationLevel: "12",
        noUpperEducationLimit: null,
        alternativeQualifications: null,
        streams: ["Science"],
        subjects: ["Physics"],
        minimumAge: 17,
        maximumAge: 25,
        eligibility: { minimumPercentage: 50 },
    });
    const base = {
        educationLevel: "12",
        stream: "Science",
        percentage: 80,
        subjects: ["Physics"],
        dateOfBirth: new Date("2004-01-01"),
    };
    const ageOn = (dob) => ({ ...base, dateOfBirth: dob });

    it("passes only when every mandatory requirement passes", () => {
        assert.equal(isEligibleForExam(gated, base), true);
        assert.equal(isEligibleForExam(gated, { ...base, stream: "Commerce" }), false);
        assert.equal(isEligibleForExam(gated, { ...base, percentage: 40 }), false);
        assert.equal(
            isEligibleForExam(gated, ageOn(new Date("2015-01-01"))),
            false,
            "under-age excluded despite education passing"
        );
        assert.equal(
            isEligibleForExam(gated, ageOn(new Date("1990-01-01"))),
            false,
            "over-age excluded despite education passing"
        );
        assert.equal(
            isEligibleForExam(gated, { ...base, subjects: ["History"] }),
            false,
            "subject mismatch excluded despite education passing"
        );
        assert.equal(
            isEligibleForExam(gated, { ...base, educationLevel: "Graduate" }),
            false,
            "above-cap excluded despite everything else passing"
        );
    });
});

// -----------------------------------------------------------------------------
// Real controller path (recommend + discover) on an isolated database.
// -----------------------------------------------------------------------------
let mongo;
const mockRes = () => {
    const res = {};
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    return res;
};

const seedApiFixtures = async () => {
    await Exam.deleteMany({});
    await Exam.insertMany([
        FIXTURES.class8Only,
        FIXTURES.class12Cap,
        FIXTURES.bachelorMin,
        FIXTURES.openSchoolMin,
        FIXTURES.unknownUpper,
    ]);
};

describe("real API path — recommend and discover agree", () => {
    before(async () => {
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri());
    });

    after(async () => {
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
    });

    beforeEach(seedApiFixtures);

    it("recommend: Class 8 gets band exams, never degree exams or unknowns", async () => {
        const res = mockRes();
        await recommendExams({ user: { profile: studentProfile("8") } }, res);
        assert.equal(res.statusCode, 200);
        const names = res.body.data.map((e) => e.name);
        assert.ok(names.includes("SYN Class 8 Only"));
        assert.ok(names.includes("SYN Capped At 12"));
        assert.ok(!names.includes("SYN Bachelor Minimum"));
        assert.ok(!names.includes("SYN Unknown Upper"));
        assert.ok(!names.includes("SYN Open School Minimum"));
    });

    it("recommend: graduates keep open exams, lose capped ones", async () => {
        const res = mockRes();
        await recommendExams({ user: { profile: studentProfile("Graduate") } }, res);
        assert.equal(res.statusCode, 200);
        const names = res.body.data.map((e) => e.name);
        assert.ok(names.includes("SYN Bachelor Minimum"));
        assert.ok(names.includes("SYN Open School Minimum"));
        assert.ok(!names.includes("SYN Class 8 Only"));
        assert.ok(!names.includes("SYN Capped At 12"));
        assert.ok(!names.includes("SYN Unknown Upper"));
    });

    it("discover (complete profile) applies the same eligibility set", async () => {
        const req = { user: { profile: studentProfile("Graduate") }, query: {} };
        const res = mockRes();
        await discoverExams(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.personalized, true);
        const names = res.body.data.map((e) => e.name);
        assert.ok(names.includes("SYN Bachelor Minimum"));
        assert.ok(!names.includes("SYN Capped At 12"));
    });
});

describe("seed safety — idempotent, non-destructive, manual-preserving", () => {
    before(async () => {
        if (mongoose.connection.readyState === 0) {
            mongo = await MongoMemoryServer.create();
            await mongoose.connect(mongo.getUri());
        }
    });

    after(async () => {
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
        mongo = null;
    });

    beforeEach(async () => {
        await Exam.deleteMany({});
    });

    it("dry-run writes nothing", async () => {
        const summary = await seedDatabase({ dryRun: true });
        assert.equal(summary.inserted, 50);
        assert.equal(await Exam.countDocuments(), 0);
    });

    it("repeated seeding creates no duplicates and refreshes seed records", async () => {
        const first = await seedDatabase({ dryRun: false });
        assert.equal(first.inserted, 50);
        assert.equal(await Exam.countDocuments(), 50);
        const second = await seedDatabase({ dryRun: false });
        assert.equal(second.inserted, 0);
        assert.equal(second.updatedSeed, 50);
        assert.equal(await Exam.countDocuments(), 50);
        // Reviewed values landed (spot check incl. the verified UGC NET fix).
        const net = await Exam.findOne({ name: "UGC NET" });
        assert.equal(net.minimumEducationLevel, "Post-Graduate");
        assert.equal(net.noUpperEducationLimit, true);
        const jam = await Exam.findOne({ name: "IIT JAM" });
        assert.equal(jam.minimumEducationLevel, "Graduate");
    });

    it("manual corrections are never silently overwritten", async () => {
        await seedDatabase({ dryRun: false });
        await Exam.updateOne(
            { name: "NTSE" },
            {
                $set: {
                    maximumEducationLevel: "12",
                    origin: "MIXED",
                },
                $push: {
                    manualEdits: {
                        field: "maximumEducationLevel",
                        source: "MANUAL",
                        updatedBy: "operator@example.com",
                        note: "operator correction",
                    },
                },
            }
        );
        const summary = await seedDatabase({ dryRun: false });
        assert.equal(summary.backfilledManual, 1);
        const ntse = await Exam.findOne({ name: "NTSE" });
        assert.equal(ntse.maximumEducationLevel, "12");
        assert.equal(ntse.origin, "MIXED");
        assert.equal(ntse.manualEdits.length, 1);
    });

    it("legacy records missing the new fields are backfilled, users untouched", async () => {
        // Raw insert: legacy shape with superseded keys no current schema
        // path accepts (Mongoose strict mode would drop them on create).
        await Exam.collection.insertOne({
            name: "NTSE",
            fullForm: "National Talent Search Examination",
            educationLevel: "10",
            lastVerifiedAt: new Date("2026-10-01"),
            minimumEducationLevel: "10",
            registrationStartDate: new Date("2026-08-01"),
            registrationEndDate: new Date("2026-09-15"),
            officialWebsite: "https://ncert.nic.in/national-talent-examination.php",
            origin: "SEED",
        });
        const summary = await seedDatabase({ dryRun: false });
        assert.equal(summary.updatedSeed, 1);
        assert.equal(summary.inserted, 49);
        const ntse = await Exam.findOne({ name: "NTSE" });
        assert.equal(ntse.maximumEducationLevel, "10");
        // Superseded legacy keys are removed (driver-level unset — Mongoose
        // strict mode silently drops non-schema paths from updates).
        const raw = await Exam.collection.findOne({ name: "NTSE" });
        assert.equal("educationLevel" in raw, false);
        assert.equal("lastVerifiedAt" in raw, false);
        assert.equal(await Exam.countDocuments(), 50);
    });
});
