// =============================================================================
// scraper/extractors/eligibility.js
// =============================================================================
// WHAT: Rule-based eligibility extraction from prepared text into the
//   tri-state Eligibility shape from validators/examValidator.js.
// WHY: Eligibility must be evidenced, never assumed. Each axis starts UNKNOWN
//   (via buildUnknownEligibility) and flips to KNOWN only on an explicit
//   textual signal; genuinely ambiguous signals are left UNKNOWN rather than
//   recorded as NEEDS_VERIFICATION noise — except DOB-cutoff age phrasing,
//   where the fact is real but not an int, so NEEDS_VERIFICATION is honest.
// VALUE MAPS: education levels stay engine-owned (canonical closed set,
// aligned with server/utils/educationLevels.js via a local copy so the
// scraper never imports server code). Stream and subject vocabularies are
// ADAPTER-owned (registry `streamVocabulary` / `subjectVocabulary`): the
// engine below only matches configured phrases and records configured
// canonical values. No vocab configured -> the axis stays UNKNOWN; values
// outside the configured vocab are never guessed.
// PRECISION GATES (conservative extraction — an UNKNOWN beats a wrong KNOWN):
//   - education signals count only inside an ELIGIBILITY-axis section or near
//     an explicit requirement relationship (must/passed/completed/eligible
//     ...). Paper titles, abbreviation glossaries, and notices-list link text
//     ("Paper 1 (B.E./B.Tech.)") carry none of these, so degree abbreviations
//     there no longer fabricate a minimum-education bar.
//   - subject "with X, Y and Z" lists are skipped inside illustrative example
//     contexts ("for example", "if a candidate has ..."). Examples of a
//     candidate's history are not requirements.
//   - percentage matches tied to admission TO a named institution/system
//     ("admission to NIT+ System", counselling, seat allotment) are skipped:
//     downstream admission criteria are not generic exam eligibility. A bare
//     "seeking admission this year" (no institution) still extracts.
//   - education minLevel: "8" | "9" | "10" | "11" | "12" | "Diploma" |
//     "Graduate" | "Post-Graduate" | "Doctorate". Explicit school-class RANGE
//     constructions ("Class 8 to 10") extract as a KNOWN bounded
//     { minLevel, maxLevel } pair. Explicit "no upper qualification cap"
//     phrasing sets upperOpen:true; explicit diploma-entry phrasing sets
//     alternativeLevels:["Diploma"]. Multi-category rule (generic): every
//     distinct signaled level is collected. ONE distinct level -> KNOWN (the
//     single-category case). SEVERAL distinct levels -> the schema holds a
//     single minLevel and cannot represent alternatives, so minLevel stays
//     null/UNKNOWN and the per-category excerpts are preserved in one
//     LOW-confidence evidence entry — the ambiguity stays visible instead of
//     collapsing to a guessed "most demanding" bar, and UNKNOWN is never
//     "not eligible". Contradictory ranges ("Class 12 to 8") and DOB-style
//     partial signals go NEEDS_VERIFICATION, never KNOWN.
//   - percentage min: number 0–100. percentage: KNOWN requires a value.
//   - age min/max: ints. DOB cutoffs ("born on or after …") with no ints →
//     NEEDS_VERIFICATION with null values.
//   - stream allowed: canonical values from the adapter vocabulary, evidenced
//     by configured match phrases.
//   - subjects requiredAny: canonical values from the adapter vocabulary,
//     parsed from explicit "with X, Y and Z" requirement lists.
// STEP 6 context (education only; other axes untouched): ordinal matches in
//   date/age/pagination noise are suppressed via extractors/contextFilters
//   before the set decision, and a lone match inside an ELIGIBILITY section
//   (extractors/sections) carries HIGH confidence. Multi-level UNKNOWN,
//   DOB handling, and percentage anchoring are unchanged.
// CONTRACT:
//   extractEligibility(text, ctx, vocab) -> full eligibility object.
//   ctx: provenance + extractor tag (defaults to "eligibility.v1").
//   vocab: { subjectVocabulary, streamVocabulary } — arrays of
//     { canonical, match[] } (registry VocabEntrySchema). Missing/empty
//     means the axis stays UNKNOWN; nothing is invented.
//   Each adopted axis carries { status, evidence }; untouched axes keep
//   { status: "UNKNOWN", evidence: null }. One exception: multi-category
//   education is UNKNOWN *with* evidence — the preserved category excerpts
//   are the ambiguity signal, and UNKNOWN never means "not eligible".
// =============================================================================

const { buildUnknownEligibility } = require("../validators/examValidator");
const { buildEvidence } = require("./evidence");
const { filterEducationMatches } = require("./contextFilters");
const { detectSections, sectionAt } = require("./sections");

const EXTRACTOR_TAG = "eligibility.v1";

const EDUCATION_RANK = {
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  Diploma: 13,
  Graduate: 15,
  "Post-Graduate": 16,
  Doctorate: 17,
};
// Local copy of the canonical rank order (server/utils/educationLevels.js).
// Diploma (13) sits above any school class and below a bachelor's degree.

// Signal order is irrelevant: distinct levels are collected and decided on
// as a set (see the multi-category rule in the header).
const EDUCATION_SIGNALS = [
  { level: "Doctorate", re: /\b(ph\.?\s*d\.?|doctorate)\b/i },
  { level: "Post-Graduate", re: /\b(post[\s-]?graduat\w*|master'?s?\s+degree|m\.?\s?tech\b|m\.?\s?sc\b)/i },
  { level: "Graduate", re: /\b(graduat\w*|bachelor'?s?\s+degree|b\.?\s?tech\b|b\.?\s?sc\b|\bug\b(?!.*diagnos))/i },
  { level: "12", re: /(\b10\s*\+\s*2\b|\b12\s?th\b|\bclass\s*12\b|\bclass\s*XII\b|higher\s+secondary|senior\s+secondary|intermediate\s+(?:education|exam)|hsc\b)/i },
  { level: "11", re: /(\b11\s?th\b|\bclass\s*XI\b)/i },
  { level: "10", re: /(\b10\s?th\b|\bclass\s*10\b|\bclass\s*X\b|matriculation|secondary\s+school(?!.*higher)|ssc\s+(?:exam|board))/i },
  { level: "9", re: /(\b9\s?th\b|\bclass\s*9\b|\bclass\s*IX\b)/i },
  { level: "8", re: /(\b8\s?th\b|\bclass\s*8\b|elementary\s+education)/i },
];

// Explicit school-class RANGE constructions ("Class 8 to 10", "classes 8-12").
// Both ends must be rankable school classes; anything else (degree ranges,
// reversed ranges) is left for human review, never guessed.
const EDUCATION_RANGE_RES = [
  /(?:from\s+)?class\s*(\d{1,2})\s*(?:to|-|–|through)\s*(?:class\s*)?(\d{1,2})/i,
  /classes\s*(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})/i,
];

// Explicit "no upper cap" phrasing for the EDUCATION axis only (age caps use
// different wording and must never satisfy this — an age limit is not a
// qualification limit).
const UPPER_OPEN_RES = [
  /no\s+(?:upper|maximum)\s+(?:limit\s+(?:on\s+|for\s+)?)?(?:educational\s+qualifications?|education(?:al)?\s+qualifications?|qualifications?)/i,
  /irrespective\s+of\s+higher\s+qualifications?/i,
  /higher\s+qualifications?\s+(?:may\s+also|are\s+also|can\s+also)\s+(?:apply|be\s+eligible)/i,
];

// Explicit alternative entry pathways. Deliberately narrow: only diploma
// phrasing is machine-recognized. Degree-level "or" alternatives ("Bachelor's
// or Master's may apply") stay UNKNOWN for human review — collapsing them
// would invent a minimum.
const ALTERNATIVE_RES = [
  {
    level: "Diploma",
    re: /diploma\s+holders?\s+(?:may\s+also|are\s+also|can\s+also|are)\s+(?:also\s+)?(?:eligible|apply|admitted)/i,
  },
  {
    level: "Diploma",
    re: /(?:10\s*\+\s*2|class\s*12)\s+or\s+equivalent\s+diploma/i,
  },
];

const APPEARING_RE = /\b(appearing|appeared)\b.{0,60}\b(candidates?|students?|applicants?)\b.{0,60}\b(eligible|apply|appear)\b|\bfinal\s+year\b.{0,40}\beligible\b/i;

// Requirement relationship: words that tie a nearby degree/class mention to
// an actual eligibility rule (as opposed to a paper title, glossary entry,
// or link label that merely names a degree).
const REQUIREMENT_CONTEXT_RE =
  /\bmust\b|\bhave\b|\bhas\b|\bhaving\b|\bholds?\b|\bholding\b|\bpassed\b|\bpassing\b|\bpass\b|\bcompleted?\b|\bobtained?\b|\brequire\b|\brequires\b|\brequired\b|\brequirement\b|\beligib\w*|\bqualif\w*|\badmission\b|\badmit\b|\bappl(y|ied|icants?)\b|\bminimum\b|\bat least\b|\bshould\b|\bshall\b|\bcriteria\b|\bstudying\b|\benrolled\b|\bappear\b|\bopen\s+to\b/i;

const REQUIREMENT_CONTEXT_CHARS = 200;
const REQUIREMENT_FOLLOW_CHARS = 120;

// Illustrative example markers: a subject list introduced as an example of
// one candidate's history ("For example, if a candidate has passed Class XII
// with Physics, ...") states no requirement.
const EXAMPLE_CONTEXT_RE =
  /\bfor example\b|\bfor instance\b|\be\.g\.|\bsuch as\b|\bsuppose\b|\billustrat\w*|\bsample\b|\bif a candidate (has|have|had)\b/i;

const EXAMPLE_CONTEXT_CHARS = 200;

// Downstream-admission markers: a percentage tied to admission TO a named
// institution/system, counselling, or seat allotment is an admission rule,
// not generic exam eligibility. Note the capital after "admission to": a
// bare "seeking admission this year" (no institution) still extracts.
const ADMISSION_CONTEXT_RE =
  /\badmission\s+to\s+[A-Z]|\bcounsell?ing\b|\bseat\s+(allocation|allotment)\b|\ballotment\b/i;

const ADMISSION_CONTEXT_CHARS = 250;

function contextAround(collapsed, index, chars) {
  return collapsed.slice(Math.max(0, index - chars), index);
}

const PERCENTAGE_RES = [
  // Minimum/at-least figure anchored to marks within the same clause.
  // The anchor is load-bearing: reservation and impairment percentages
  // ("5% seats", "at least 40% impairment") appear in nearly every Indian
  // bulletin and must never read as qualifying marks.
  /(?:minimum|at\s+least|not\s+less\s+than)\s+(\d{1,3}(?:\.\d+)?)\s*%(?=[^.]{0,60}?(?:marks|aggregate))/i,
  /(?:secured?|obtained?|scored?)(?:\s+a)?\s+(?:minimum|at\s+least\s+of\s+)?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
  /(\d{1,3}(?:\.\d+)?)\s*%\s+(?:marks|aggregate|in\s+aggregate)/i,
];

const AGE_MIN_RES = [
  /minimum\s+age\s*(?:is|:)?\s*(\d{1,2})/i,
  /lower\s+age\s+limit\s*(?:is|:)?\s*(\d{1,2})/i,
  /at\s+least\s+(\d{1,2})\s*years?\s+old/i,
];
const AGE_MAX_RES = [
  /maximum\s+age\s*(?:is|:)?\s*(\d{1,2})/i,
  /upper\s+age\s+limit\s*(?:is|:)?\s*(\d{1,2})/i,
];
const AGE_SPAN_RE = /age\s+limit\s*(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})/i;
const DOB_CUTOFF_RE = /born\s+on\s+or\s+(?:after|before)\s+[^\n.]{3,80}/i;

// Escape a vocab phrase so it matches literally inside a built pattern.
function escapePhrase(phrase) {
  return String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalize the adapter vocabularies into engine-ready matchers. Malformed
// input fails safe to empty vocabularies (UNKNOWN, never invented).
function vocabEntries(vocab, key) {
  const list = vocab && Array.isArray(vocab[key]) ? vocab[key] : [];
  return list.filter(
    (entry) =>
      entry &&
      typeof entry.canonical === "string" &&
      entry.canonical.trim() !== "" &&
      Array.isArray(entry.match) &&
      entry.match.some((p) => typeof p === "string" && p.trim() !== "")
  );
}

// Case-insensitive substring search returning the match index, or -1.
function findPhrase(collapsed, phrase) {
  return collapsed.toLowerCase().indexOf(String(phrase).toLowerCase());
}

function collapse(text) {
  // Collapse horizontal whitespace but preserve newlines: the section layer
  // (sections.js) reads headings as lines, and all signal patterns already
  // tolerate newlines via \s. Excerpts are normalized downstream by
  // buildEvidence, so stored evidence keeps its single-line shape.
  return String(text || "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function windowAround(collapsed, index, length = 120) {
  const start = Math.max(0, index - length);
  return collapsed.slice(start, index + length + 200).trim();
}

function withCtx(ctx) {
  return {
    sourceUrl: ctx.sourceUrl,
    documentUrl: ctx.documentUrl,
    docType: ctx.docType,
    retrievedAt: ctx.retrievedAt,
    section: ctx.section,
    extractor: (ctx && ctx.extractor) || EXTRACTOR_TAG,
  };
}

function validPercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function validAge(value) {
  return Number.isInteger(value) && value >= 0 && value <= 120;
}

function extractEligibility(text, ctx = {}, vocab = {}) {
  const collapsed = collapse(text);
  const base = withCtx(ctx);
  const eligibility = buildUnknownEligibility();
  if (!collapsed) return eligibility;

  // --- education -----------------------------------------------------------
  // Distinct signaled levels decide as a set: one -> KNOWN; several ->
  // UNKNOWN with every category's excerpt preserved (schema cannot hold
  // alternatives, so choosing any single level would invent a requirement).
  // Step 6 context: matches inside date/age/pagination noise are suppressed
  // before the set decision (an ordinal in "8th September, 2008" is a date,
  // not a level), and a lone match inside an Eligibility section carries
  // HIGH confidence instead of MEDIUM.
  // Every occurrence of every signal is collected, then noise-suppressed
  // occurrences are dropped and each level keeps its first clean one. A
  // suppressed early hit ("8th" in a date) therefore never hides a genuine
  // later one ("Class 8"); with no noise this is exactly the previous
  // first-match behavior.
  const rawLevels = [];
  for (const signal of EDUCATION_SIGNALS) {
    const global = new RegExp(
      signal.re.source,
      signal.re.flags.includes("g") ? signal.re.flags : `${signal.re.flags}g`
    );
    let match = null;
    while ((match = global.exec(collapsed)) !== null) {
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      rawLevels.push({
        level: signal.level,
        index: match.index,
        length: match[0].length,
        text: match[0],
        excerpt: windowAround(collapsed, match.index),
      });
    }
  }
  const { kept: cleanLevels } = filterEducationMatches(collapsed, rawLevels);
  const sections = detectSections(collapsed);
  const matchedLevels = [];
  const seenLevels = new Set();
  for (const entry of cleanLevels) {
    if (seenLevels.has(entry.level)) continue;
    // Requirement-context gate: paper titles, abbreviation glossaries, and
    // notices-list link text name degrees without stating any rule. A signal
    // counts only inside an ELIGIBILITY-axis section or near an explicit
    // requirement relationship — otherwise it is dropped, never guessed from.
    const home = sectionAt(entry.index, sections);
    const inEligibilitySection = home !== null && home.axis === "ELIGIBILITY";
    // Bidirectional: requirement verbs may precede ("must have passed Class
    // XII") or follow ("Senior Secondary examination passed") the signal.
    const nearby =
      contextAround(collapsed, entry.index, REQUIREMENT_CONTEXT_CHARS) +
      " " +
      collapsed.slice(
        entry.index + entry.length,
        entry.index + entry.length + REQUIREMENT_FOLLOW_CHARS
      );
    if (!inEligibilitySection && !REQUIREMENT_CONTEXT_RE.test(nearby)) continue;
    seenLevels.add(entry.level);
    matchedLevels.push(entry);
  }
  // (sections already computed above for the lone-match confidence below.)
  const sectionNameAt = (index) => {
    const section = sectionAt(index, sections);
    return section ? section.name : null;
  };
  let appearingAllowed = null;
  const appearingMatch = APPEARING_RE.exec(collapsed);
  if (appearingMatch) appearingAllowed = true;

  // --- education range (bounded) -------------------------------------------
  // An explicit "Class X to Y" construction inside requirement context is a
  // KNOWN bounded range — not two competing categories. Ends must be
  // rankable school classes with lo <= hi; anything else (degree ranges,
  // reversed ranges) is contradictory input for human review.
  let rangedEducation = null;
  for (const re of EDUCATION_RANGE_RES) {
    const global = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`
    );
    let match = null;
    while ((match = global.exec(collapsed)) !== null) {
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      const nearby =
        contextAround(collapsed, match.index, REQUIREMENT_CONTEXT_CHARS) +
        " " +
        collapsed.slice(match.index + match[0].length, match.index + match[0].length + REQUIREMENT_FOLLOW_CHARS);
      if (!REQUIREMENT_CONTEXT_RE.test(nearby)) continue;
      const lo = match[1];
      const hi = match[2];
      if (EDUCATION_RANK[lo] === undefined || EDUCATION_RANK[hi] === undefined) continue;
      rangedEducation = {
        lo,
        hi,
        contradictory: EDUCATION_RANK[hi] < EDUCATION_RANK[lo],
        excerpt: windowAround(collapsed, match.index),
      };
      break;
    }
    if (rangedEducation) break;
  }

  // --- education upper-open + alternatives -----------------------------------
  // Narrow, explicitly-worded signals only (see pattern docs above). Each
  // must sit near requirement context — a bare "diploma" in a course list or
  // an age-limit "no upper limit" states no education rule.
  const nearRequirement = (index, length) => {
    const nearby =
      contextAround(collapsed, index, REQUIREMENT_CONTEXT_CHARS) +
      " " +
      collapsed.slice(index + length, index + length + REQUIREMENT_FOLLOW_CHARS);
    return REQUIREMENT_CONTEXT_RE.test(nearby);
  };
  let upperOpen = null;
  let upperOpenExcerpt = null;
  for (const re of UPPER_OPEN_RES) {
    const match = re.exec(collapsed);
    if (match && nearRequirement(match.index, match[0].length)) {
      upperOpen = true;
      upperOpenExcerpt = windowAround(collapsed, match.index);
      break;
    }
  }
  const alternativeLevels = [];
  const alternativeExcerpts = [];
  for (const { level, re } of ALTERNATIVE_RES) {
    const global = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`
    );
    let match = null;
    while ((match = global.exec(collapsed)) !== null) {
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      if (!nearRequirement(match.index, match[0].length)) continue;
      if (!alternativeLevels.includes(level)) {
        alternativeLevels.push(level);
        alternativeExcerpts.push(windowAround(collapsed, match.index));
      }
    }
  }

  // --- education comma-list ("Class 8, 9, 10, 11 or 12") --------------------
  // Bare numbers never match level signals on their own (precision: dates,
  // ages, paper numbers all contain bare numbers). Inside an explicit
  // comma/and/or list following "Class"/"Classes" they do: a consecutive run
  // is a KNOWN bounded range; a non-consecutive list is ambiguous and goes to
  // human review instead of guessing which in-betweens qualify.
  if (!rangedEducation) {
    const listMatch =
      /class(?:es)?\s+(\d{1,2}(?:\s*(?:,|and|or)\s*(?:class\s*)?\d{1,2})+)/i.exec(
        collapsed
      );
    if (listMatch && nearRequirement(listMatch.index, listMatch[0].length)) {
      const nums = listMatch[0].match(/\d{1,2}/g) || [];
      const levels = [
        ...new Set(nums.filter((n) => EDUCATION_RANK[n] !== undefined)),
      ].sort((a, b) => EDUCATION_RANK[a] - EDUCATION_RANK[b]);
      if (levels.length >= 2) {
        const run = levels.every(
          (lv, i) => i === 0 || EDUCATION_RANK[lv] === EDUCATION_RANK[levels[i - 1]] + 1
        );
        rangedEducation = run
          ? {
              lo: levels[0],
              hi: levels[levels.length - 1],
              contradictory: false,
              excerpt: windowAround(collapsed, listMatch.index),
            }
          : {
              lo: null,
              hi: null,
              contradictory: "ambiguous-list",
              excerpt: windowAround(collapsed, listMatch.index),
            };
      }
    }
  }

  if (rangedEducation) {
    if (rangedEducation.contradictory) {
      // "Class 12 to 8" style text — or a non-consecutive class list — states
      // no coherent range: flag for verification instead of publishing either
      // end as fact.
      eligibility.education = {
        minLevel: null,
        maxLevel: null,
        upperOpen: null,
        alternativeLevels: null,
        appearingAllowed,
        status: "NEEDS_VERIFICATION",
        evidence: buildEvidence(base, {
          confidence: "LOW",
          excerpt: rangedEducation.excerpt,
        }),
      };
    } else {
      eligibility.education = {
        minLevel: rangedEducation.lo,
        maxLevel: rangedEducation.hi,
        upperOpen: null,
        alternativeLevels: alternativeLevels.length > 0 ? [...alternativeLevels] : null,
        appearingAllowed,
        status: "KNOWN",
        evidence: buildEvidence(base, {
          confidence: "MEDIUM",
          excerpt: rangedEducation.excerpt,
        }),
      };
    }
  } else if (matchedLevels.length === 1) {
    const only = matchedLevels[0];
    const home = sectionAt(only.index, sections);
    const inEligibility = home !== null && home.axis === "ELIGIBILITY";
    eligibility.education = {
      minLevel: only.level,
      maxLevel: null,
      upperOpen,
      alternativeLevels: alternativeLevels.length > 0 ? [...alternativeLevels] : null,
      appearingAllowed,
      status: "KNOWN",
      evidence: buildEvidence(base, {
        confidence: inEligibility ? "HIGH" : "MEDIUM",
        excerpt: only.excerpt,
        // Surface the detected section only when the caller supplied none —
        // pipeline/test contexts already carry the document label there.
        section: base.section || sectionNameAt(only.index),
      }),
    };
  } else if (matchedLevels.length > 1) {
    // Consecutive-list rule (IOQM-style "Class 8, 9, 10, 11 or 12 are
    // eligible"): distinct levels forming an unbroken rank run inside ONE
    // sentence/clause state a bounded range, not competing categories.
    // Levels split across sentences ("Class X ... course. Class XII ...
    // post.") stay UNKNOWN — separate clauses mean separate rules.
    const byRank = [...matchedLevels].sort(
      (a, b) => EDUCATION_RANK[a.level] - EDUCATION_RANK[b.level]
    );
    const ranks = byRank.map((m) => EDUCATION_RANK[m.level]);
    const consecutive =
      ranks.length > 1 && ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
    const spanStart = Math.min(...matchedLevels.map((m) => m.index));
    const spanEnd = Math.max(...matchedLevels.map((m) => m.index + m.length));
    const spanText = collapsed.slice(spanStart, spanEnd);
    const singleClause = !/[.!?;]/.test(spanText);
    if (consecutive && singleClause) {
      const home = sectionAt(byRank[0].index, sections);
      const inEligibility = home !== null && home.axis === "ELIGIBILITY";
      eligibility.education = {
        minLevel: byRank[0].level,
        maxLevel: byRank[byRank.length - 1].level,
        upperOpen: null,
        alternativeLevels: alternativeLevels.length > 0 ? [...alternativeLevels] : null,
        appearingAllowed,
        status: "KNOWN",
        evidence: buildEvidence(base, {
          confidence: inEligibility ? "HIGH" : "MEDIUM",
          excerpt: windowAround(collapsed, byRank[0].index),
          section: base.section || sectionNameAt(byRank[0].index),
        }),
      };
    } else {
      const combined = matchedLevels
        .sort((a, b) => EDUCATION_RANK[a.level] - EDUCATION_RANK[b.level])
        .map((m) => `[${m.level}] ${m.excerpt}`)
        .join(" | ");
      eligibility.education = {
        minLevel: null,
        maxLevel: null,
        upperOpen: null,
        alternativeLevels: null,
        appearingAllowed,
        status: "UNKNOWN",
        evidence: buildEvidence(base, {
          confidence: "LOW",
          excerpt: combined,
        }),
      };
    }
  } else if (appearingAllowed !== null) {
    // "Appearing candidates may apply" with no stated bar: real but partial
    // signal — flag for verification instead of inventing a minLevel.
    eligibility.education = {
      ...eligibility.education,
      appearingAllowed,
      status: "NEEDS_VERIFICATION",
      evidence: buildEvidence(base, {
        confidence: "LOW",
        excerpt: windowAround(collapsed, appearingMatch.index),
      }),
    };
  }

  // --- percentage ----------------------------------------------------------
  // Every match is walked (not just the first): a percentage tied to
  // admission TO a named institution/system is skipped as a downstream
  // admission rule, and scanning continues for a genuine exam-wide figure.
  for (const re of PERCENTAGE_RES) {
    const global = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`
    );
    let match = null;
    while ((match = global.exec(collapsed)) !== null) {
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      const value = Number(match[1]);
      if (!validPercentage(value)) continue;
      const nearby = contextAround(collapsed, match.index, ADMISSION_CONTEXT_CHARS);
      if (ADMISSION_CONTEXT_RE.test(nearby)) continue;
      eligibility.percentage = {
        min: value,
        status: "KNOWN",
        evidence: buildEvidence(base, {
          confidence: "MEDIUM",
          excerpt: windowAround(collapsed, match.index),
        }),
      };
      break;
    }
    if (eligibility.percentage.status === "KNOWN") break;
  }

  // --- age -----------------------------------------------------------------
  let ageMin = null;
  let ageMax = null;
  let ageExcerpt = null;
  const span = AGE_SPAN_RE.exec(collapsed);
  if (span && validAge(Number(span[1])) && validAge(Number(span[2]))) {
    ageMin = Number(span[1]);
    ageMax = Number(span[2]);
    ageExcerpt = windowAround(collapsed, span.index);
  } else {
    for (const re of AGE_MIN_RES) {
      const match = re.exec(collapsed);
      if (match && validAge(Number(match[1]))) {
        ageMin = Number(match[1]);
        ageExcerpt = windowAround(collapsed, match.index);
        break;
      }
    }
    for (const re of AGE_MAX_RES) {
      const match = re.exec(collapsed);
      if (match && validAge(Number(match[1]))) {
        ageMax = Number(match[1]);
        ageExcerpt = ageExcerpt || windowAround(collapsed, match.index);
        break;
      }
    }
  }
  if (ageMin !== null || ageMax !== null) {
    eligibility.age = {
      min: ageMin,
      max: ageMax,
      asOfDate: null,
      status: "KNOWN",
      evidence: buildEvidence(base, {
        confidence: "MEDIUM",
        excerpt: ageExcerpt,
      }),
    };
  } else {
    const dob = DOB_CUTOFF_RE.exec(collapsed);
    if (dob) {
      eligibility.age = {
        ...eligibility.age,
        status: "NEEDS_VERIFICATION",
        evidence: buildEvidence(base, {
          confidence: "LOW",
          excerpt: windowAround(collapsed, dob.index),
        }),
      };
    }
  }

  // --- stream --------------------------------------------------------------
  // Every configured entry whose phrases appear becomes allowed, in vocab
  // order. No configured vocabulary (or no hit) -> UNKNOWN, never guessed.
  const streamEntries = vocabEntries(vocab, "streamVocabulary");
  const streamHits = [];
  for (const entry of streamEntries) {
    let at = -1;
    for (const phrase of entry.match) {
      if (typeof phrase !== "string" || phrase.trim() === "") continue;
      const index = findPhrase(collapsed, phrase);
      if (index !== -1 && (at === -1 || index < at)) at = index;
    }
    if (at !== -1) streamHits.push({ canonical: entry.canonical, index: at });
  }
  if (streamHits.length > 0) {
    streamHits.sort((a, b) => a.index - b.index);
    const firstAt = streamHits[0].index;
    const seen = new Set();
    const allowed = [];
    for (const hit of streamHits) {
      if (!seen.has(hit.canonical)) {
        seen.add(hit.canonical);
        allowed.push(hit.canonical);
      }
    }
    eligibility.stream = {
      allowed,
      status: "KNOWN",
      evidence: buildEvidence(base, {
        confidence: "MEDIUM",
        excerpt: windowAround(collapsed, firstAt),
      }),
    };
  }

  // --- subjects ------------------------------------------------------------
  // The configured subject phrases form one explicit "with X, Y and Z"
  // requirement list. Tokens map back to their entry canonicals (first
  // entry wins on collisions); anything outside the vocab stays UNKNOWN.
  const subjectEntries = vocabEntries(vocab, "subjectVocabulary");
  const phraseToCanonical = new Map();
  for (const entry of subjectEntries) {
    for (const phrase of entry.match) {
      if (typeof phrase !== "string" || phrase.trim() === "") continue;
      const key = phrase.toLowerCase();
      if (!phraseToCanonical.has(key)) phraseToCanonical.set(key, entry.canonical);
    }
  }
  const subjectAlts = [...phraseToCanonical.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapePhrase);
  if (subjectAlts.length > 0) {
    const altGroup = `(?:${subjectAlts.join("|")})`;
    const listRe = new RegExp(
      `with\\s+(${altGroup}(?:\\s*(?:,|and|&)\\s*${altGroup})*)`,
      "gi"
    );
    // Every "with X, Y and Z" list is walked (not just the first): lists
    // inside illustrative example contexts ("For example, if a candidate has
    // passed Class XII with ...") describe one candidate's history, not a
    // requirement, and are skipped while scanning continues.
    let subjectMatch = null;
    while ((subjectMatch = listRe.exec(collapsed)) !== null) {
      if (subjectMatch[0].length === 0) {
        listRe.lastIndex += 1;
        continue;
      }
      const nearby = contextAround(collapsed, subjectMatch.index, EXAMPLE_CONTEXT_CHARS);
      if (EXAMPLE_CONTEXT_RE.test(nearby)) continue;
      const names = [];
      const seen = new Set();
      const tokenRe = new RegExp(subjectAlts.join("|"), "gi");
      let token;
      while ((token = tokenRe.exec(subjectMatch[1])) !== null) {
        const canonical = phraseToCanonical.get(token[0].toLowerCase());
        if (canonical && !seen.has(canonical)) {
          seen.add(canonical);
          names.push(canonical);
        }
      }
      if (names.length > 0) {
        eligibility.subjects = {
          requiredAny: names,
          status: "KNOWN",
          evidence: buildEvidence(base, {
            confidence: "MEDIUM",
            excerpt: windowAround(collapsed, subjectMatch.index),
          }),
        };
        break;
      }
    }
  }

  return eligibility;
}

module.exports = {
  extractEligibility,
  EXTRACTOR_TAG,
};
