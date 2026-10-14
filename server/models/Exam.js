const mongoose = require("mongoose");
// imported mongoose

const {
    CAREER_TYPES,
    EXAM_TYPES,
} = require("../utils/discovery");
// Single source of truth for discovery enums/validators — canonical values
// are defined once in utils/discovery.js, never re-typed here.

const {
    normalizeEducationLevel,
    getEducationRank,
} = require("../utils/educationLevels");
// Canonical education levels live in utils/educationLevels.js (single source
// of truth shared with matching logic) — never re-typed here.

// Where a piece of eligibility data came from. SEED = original hand-curated
// dataset, SCRAPER = published from a scraper staging draft, MANUAL = added
// or corrected by a human operator. MIXED = scraper/seed record later touched
// by a manual edit (see manualEdits below). Never inferred — set only by the
// code path that actually wrote the value.
const ELIGIBILITY_SOURCES = ["SEED", "SCRAPER", "MANUAL"];

// Lifecycle of one custom criterion. NEEDS_VERIFICATION = stored but awaiting
// a human check (displayable, never used by recommendation logic).
// NOT_APPLICABLE = explicitly confirmed as not applying (distinct from an
// absent/unknown value — no fake value is stored either way).
const CUSTOM_ELIGIBILITY_STATUSES = ["CONFIRMED", "NEEDS_VERIFICATION", "NOT_APPLICABLE"];

// Controlled extensibility point for criteria outside the common fields.
// Structured (key/label/value + status/source/notes) so entries are
// displayable, auditable, and promotable to first-class fields later —
// never free-form garbage inside core eligibility logic.
const customEligibilitySchema = new mongoose.Schema({
    key : {
        type : String ,
        required : true ,
        trim : true ,
        match : /^[a-z][a-zA-Z0-9]*$/ ,
    } ,
    label : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    value : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    status : {
        type : String ,
        enum : CUSTOM_ELIGIBILITY_STATUSES ,
        default : "CONFIRMED" ,
    } ,
    source : {
        type : String ,
        enum : ELIGIBILITY_SOURCES ,
        default : "MANUAL" ,
    } ,
    notes : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    updatedBy : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
} , { _id : false });

// Audit trail for human corrections. The live value always sits on the exam
// document itself; this array records WHO set it, WHY, and WHEN — so manual
// data stays distinguishable from scraper/seed data forever.
const manualEditSchema = new mongoose.Schema({
    field : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    source : {
        type : String ,
        enum : ELIGIBILITY_SOURCES ,
        default : "MANUAL" ,
    } ,
    updatedBy : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    note : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    updatedAt : {
        type : Date ,
        default : Date.now ,
    } ,
} , { _id : false });

// Setter: store canonically ("Class 10" -> "10", 10 -> "10") so matching
// never depends on input spelling. Unrecognized values pass through
// unchanged so the path validator below can reject them explicitly.
const canonicalEducationSetter = (value) => {
    if (value === undefined || value === null) return value;
    const canonical = normalizeEducationLevel(value);
    return canonical === null ? value : canonical;
};

const examSchema = new mongoose.Schema({
    name  : {
        type : String , 
        required : true ,
        trim : true ,
    } ,

    fullForm : {
        type : String , 
        required : true ,
        trim : true ,
    },

    // NULL SEMANTICS (applies to every eligibility field below): null means
    // "no confirmed value" — either not specified by the source or explicitly
    // not applicable. It must NEVER be read as a requirement, a wildcard, or
    // an empty set. Recommendation logic (utils/eligibility.js) skips
    // null/empty criteria instead of filtering on them, and the UI renders
    // null as "No <criterion> specified". UNKNOWN is never converted into a
    // guessed value anywhere in this codebase.
    streams : {
        type : [String] ,
        default : null ,
    } ,

    minimumEducationLevel : {
        type : String ,
        default : null ,
        trim : true ,
        set : canonicalEducationSetter ,
        validate : {
            validator : function(value) {
                if (value === undefined || value === null) return true;
                return normalizeEducationLevel(value) !== null;
            } ,
            message : "minimumEducationLevel must be a canonical education level or null" ,
        } ,
    } ,
    // NOTE (Phase 1): values in the dataset mix class levels ("8", "10",
    // "12") and "Graduate". They are stored as canonical strings (see
    // utils/educationLevels.js) and compared by numeric rank in
    // utils/eligibility.js — never with a Mongo string `$lte`.
    // Nullable since the flexible-eligibility redesign: degree-level exams
    // (e.g. GATE-shaped drafts) may carry no school-level bar.

    // Official MAXIMUM education level (inclusive). null = not established —
    // NEVER read as "no cap" (see noUpperEducationLimit) or as "nobody
    // eligible". Matching (utils/eligibility.js) treats a missing maximum
    // without an explicit open flag as UNKNOWN and excludes conservatively.
    maximumEducationLevel : {
        type : String ,
        default : null ,
        trim : true ,
        set : canonicalEducationSetter ,
        validate : {
            validator : function(value) {
                if (value === undefined || value === null) return true;
                if (normalizeEducationLevel(value) === null) return false;
                // Cross-field sanity: a known maximum must not rank below a
                // known minimum (checked here, not silently fixed).
                const maxRank = getEducationRank(value);
                const minRank = getEducationRank(this && this.minimumEducationLevel);
                return minRank === null || maxRank === null || maxRank >= minRank;
            } ,
            message : "maximumEducationLevel must be a canonical level ranking at or above minimumEducationLevel" ,
        } ,
    } ,

    // Explicitly true ONLY when official rules establish no upper education
    // restriction (e.g. open UG entrances a graduate may still sit). Distinct
    // from unknown: null/false + null maximum = UNKNOWN (conservative).
    noUpperEducationLimit : {
        type : Boolean ,
        default : null ,
    } ,

    // Alternative entry pathways as canonical levels (e.g. ["Diploma"] for
    // lateral-entry exams). A student below the minimum whose own canonical
    // level is listed here is eligible; pathways never override an explicit
    // maximum. null/[] = none evidenced. Free-text nuance belongs in
    // customEligibility (display-only), never here.
    alternativeQualifications : {
        type : [String] ,
        default : null ,
        set : function(value) {
            if (value === undefined || value === null) return value;
            if (!Array.isArray(value)) return value;
            return value.map((entry) => {
                const canonical = normalizeEducationLevel(entry);
                return canonical === null ? entry : canonical;
            });
        } ,
        validate : {
            validator : function(value) {
                if (value === undefined || value === null) return true;
                if (!Array.isArray(value)) return false;
                return value.every((entry) => normalizeEducationLevel(entry) !== null);
            } ,
            message : "alternativeQualifications entries must be canonical education levels" ,
        } ,
    } ,

    minimumAge : {
        type : Number ,
        default : null ,
    } ,

    maximumAge : {
        type : Number ,
        default : null ,
    } ,

    registrationStartDate : {
        type : Date,
        required : true 
    } , 
    registrationEndDate : {
        type : Date,
        required : true 
    } ,

    officialWebsite : {
        type : String , 
        required : true , 
        trim : true
    } ,

    description : {
        type : String , 
        trim : true
    },

    eligibility : {
        minimumPercentage : { type : Number , default : null } ,
        // Common structured criteria. Every field is nullable: null = no
        // confirmed value for this exam (not specified or not applicable).
        // Arrays use null (not []) for the same reason.
        degreeRequirements : { type : [String] , default : null } ,
        requiredQualification : { type : String , default : null , trim : true } ,
        qualifyingExam : { type : String , default : null , trim : true } ,
        graduationYear : { type : Number , default : null } ,
        yearOfStudy : { type : String , default : null , trim : true } ,
        attemptsAllowed : { type : Number , default : null } ,
        nationality : { type : String , default : null , trim : true } ,
        domicile : { type : String , default : null , trim : true } ,
        workExperience : { type : String , default : null , trim : true } ,
        professionalRegistration : { type : String , default : null , trim : true } ,
        institutionRequirement : { type : String , default : null , trim : true } ,
        genderEligibility : { type : String , default : null , trim : true } ,
        ageRelaxation : { type : String , default : null , trim : true } ,
        categoryRelaxation : { type : String , default : null , trim : true } ,
        otherEligibility : { type : String , default : null , trim : true } ,
    } ,

    subjects : {
        type : [String] ,
        default : null ,
    } ,

    // Controlled extensible criteria (see customEligibilitySchema above).
    // Displayable even when unused by recommendation logic. Keys must be
    // unique per exam so a frequent criterion can later be promoted to a
    // first-class field without ambiguity.
    customEligibility : {
        type : [customEligibilitySchema] ,
        default : [] ,
        validate : {
            validator : function(entries) {
                if (!Array.isArray(entries)) return false;
                const keys = entries.map((entry) => entry.key);
                return new Set(keys).size === keys.length;
            } ,
            message : "customEligibility keys must be unique within an exam" ,
        } ,
    } ,

    // Provenance of the record itself (see ELIGIBILITY_SOURCES above).
    // Scraper publishes set SCRAPER; the seed dataset is SEED; any manual
    // correction flips the record to MIXED (MANUAL only when the whole
    // record was human-authored). Per-edit detail lives in manualEdits.
    origin : {
        type : String ,
        enum : [...ELIGIBILITY_SOURCES , "MIXED"] ,
        default : "SEED" ,
    } ,

    manualEdits : {
        type : [manualEditSchema] ,
        default : [] ,
    } ,

    redditLinks : [String] ,

    quoraLinks : [String] ,

    // Phase 2 — MainPage discovery data (backend only, no discovery API yet).
    // Stream stays OUT: it belongs to the User profile / Phase 1 eligibility.
    // No month field: month relevance is derived from registrationStartDate /
    // registrationEndDate via examOverlapsMonth() in utils/discovery.js.
    careerType : {
        type : String ,
        enum : CAREER_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Optional on purpose: legacy documents predate this field, so absence is
    // allowed (treated as unclassified until the data-migration phase). Any
    // value that IS stored must be a valid enum member.

    examType : {
        type : String ,
        enum : EXAM_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Same backward-compatibility contract as careerType above.

} , {
    timestamps : true,
})

module.exports = mongoose.model("Exam" , examSchema);

module.exports.ELIGIBILITY_SOURCES = ELIGIBILITY_SOURCES;
module.exports.CUSTOM_ELIGIBILITY_STATUSES = CUSTOM_ELIGIBILITY_STATUSES;