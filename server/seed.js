const mongoose = require("mongoose");
const dotenv = require("dotenv");

const Exam = require("./models/Exam");
const exams = require("./data/exams");

dotenv.config();

// =============================================================================
// IDEMPOTENT DEMO SEED — server/seed.js
// =============================================================================
// WHAT: Upserts the curated demo exam dataset by unique `name` — safe to run
//   repeatedly against a development database.
// SAFETY CONTRACT (non-negotiable):
//   - NEVER wipes the collection, NEVER touches users.
//   - NEVER creates duplicates (unique index on `name` + upsert).
//   - NEVER silently overwrites manually verified eligibility: records with
//     origin MANUAL/MIXED (human-touched) only get MISSING new education
//     fields backfilled; human values are preserved and reported.
//   - SEED-origin records are refreshed from the dataset, except their
//     manualEdits/customEligibility/origin audit trail is preserved as-is.
//   - Legacy records missing the new education fields are backfilled by the
//     same upsert (SEED-origin) or missing-field fill (MANUAL/MIXED).
//   - All entries are schema-validated BEFORE any write; a validation failure
//     aborts with no writes.
// USAGE:
//   node seed.js [--dry-run]   (dry-run prints planned actions, writes nothing)
//   Always point MONGO_URI at an isolated test/development database.
// =============================================================================

const DRY_RUN = process.argv.includes("--dry-run");

// Seed-owned static fields: everything the dataset curates. Audit/provenance
// arrays and origin are deliberately NOT in this list (see contract above).
const seedPayloadOf = (entry) => {
    const {
        name,
        fullForm,
        streams,
        minimumEducationLevel,
        maximumEducationLevel,
        noUpperEducationLimit,
        alternativeQualifications,
        minimumAge,
        maximumAge,
        registrationStartDate,
        registrationEndDate,
        officialWebsite,
        description,
        eligibility,
        subjects,
        redditLinks,
        quoraLinks,
        careerType,
        examType,
    } = entry;
    return {
        name,
        fullForm,
        streams,
        minimumEducationLevel,
        maximumEducationLevel,
        noUpperEducationLimit,
        alternativeQualifications,
        minimumAge,
        maximumAge,
        registrationStartDate,
        registrationEndDate,
        officialWebsite,
        description,
        eligibility,
        subjects,
        redditLinks,
        quoraLinks,
        careerType,
        examType,
    };
};

const seedDatabase = async ({ dryRun = DRY_RUN, mongoUri = process.env.MONGO_URI } = {}) => {
    const summary = { inserted: 0, updatedSeed: 0, backfilledManual: 0, skipped: 0 };
    try {
        if (!mongoUri) {
            throw new Error("seed: MONGO_URI is required (use an isolated test/development database)");
        }
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(mongoUri);
        }
        await Exam.collection.createIndex({ name: 1 }, { unique: true });

        // Fail fast: validate every entry before writing anything.
        for (const entry of exams) {
            const err = new Exam(entry).validateSync();
            if (err) {
                throw new Error(`seed: dataset entry "${entry.name}" is invalid: ${err.message}`);
            }
        }

        for (const entry of exams) {
            const payload = seedPayloadOf(entry);
            // eslint-disable-next-line no-await-in-loop
            const existing = await Exam.findOne({ name: entry.name });
            if (!existing) {
                if (!dryRun) {
                    // eslint-disable-next-line no-await-in-loop
                    await Exam.create({ ...payload, origin: "SEED" });
                }
                summary.inserted += 1;
                continue;
            }
            const origin = existing.origin || "SEED";
            if (origin === "MANUAL" || origin === "MIXED") {
                // Human-touched: backfill ONLY missing new education fields.
                const fill = {};
                for (const field of [
                    "minimumEducationLevel",
                    "maximumEducationLevel",
                    "noUpperEducationLimit",
                    "alternativeQualifications",
                ]) {
                    if (existing[field] === undefined || existing[field] === null) {
                        fill[field] = payload[field] ?? null;
                    }
                }
                if (Object.keys(fill).length > 0) {
                    if (!dryRun) {
                        // eslint-disable-next-line no-await-in-loop
                        await Exam.updateOne({ _id: existing._id }, { $set: fill });
                    }
                    summary.backfilledManual += 1;
                } else {
                    summary.skipped += 1;
                }
                continue;
            }
            if (!dryRun) {
                // eslint-disable-next-line no-await-in-loop
                await Exam.updateOne({ _id: existing._id }, { $set: payload });
            }
            summary.updatedSeed += 1;
        }

        console.log(
            `seed ${dryRun ? "(dry-run) " : ""}complete: ` +
            `${summary.inserted} inserted, ${summary.updatedSeed} refreshed, ` +
            `${summary.backfilledManual} manual-preserved (backfilled), ${summary.skipped} skipped`
        );
        return summary;
    } catch (error) {
        console.log(error);
        throw error;
    }
};

// CLI entry: connect, seed, disconnect, exit. Required as a module (tests)
// it only exports without side effects.
if (require.main === module) {
    seedDatabase()
        .then(async () => {
            try {
                await mongoose.disconnect();
            } catch {
                // ignore disconnect errors during shutdown
            }
            process.exit(0);
        })
        .catch(async () => {
            try {
                await mongoose.disconnect();
            } catch {
                // ignore disconnect errors during failure shutdown
            }
            process.exit(1);
        });
}

module.exports = { seedDatabase, seedPayloadOf };
