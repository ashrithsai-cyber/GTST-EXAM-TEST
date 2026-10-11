const bcrypt = require("bcrypt");
const ExcelJS = require("exceljs");
const supabase = require("../config/examSupabase");
const registrationSupabase = require("../config/registrationSupabase");
const { logAdminAction } = require("../utils/auditLog");
const { getActiveExam, normalizeClassName, computeTimingStatus } = require("./_examShared");
const { sanitizeSearchTerm, isUuid } = require("../utils/validation");

// The authenticated device heartbeat updates student_presence without
// changing its stage. A stale heartbeat and stale answer activity both
// indicate a likely disconnection; the attempt itself stays recoverable.
const DISCONNECTED_AFTER_SECONDS = 90;
const ACTIVE_PRESENCE_AFTER_SECONDS = 90;

// Uses whichever signal is most recent: the exam page's IN_EXAM presence
// heartbeat (every ~10s) or the last answer save/resume.
function isLikelyDisconnected(session, secondsPerQuestion) {
    if (session.status !== "IN_PROGRESS") return false;
    const lastContact = Math.max(
        session.presence_updated_at ? new Date(session.presence_updated_at).getTime() : 0,
        session.last_activity_at ? new Date(session.last_activity_at).getTime() : 0
    );
    if (!lastContact) return false;
    const threshold = Math.max(DISCONNECTED_AFTER_SECONDS, (secondsPerQuestion || 60) * 2) * 1000;
    return Date.now() - lastContact > threshold;
}

// Structural question-bank changes (adding/removing/reordering subjects
// or questions) shift the pointer-based question delivery in
// _examShared.js: a student's session maps (subjectIndex, questionIndex)
// to "the Nth question in order", so inserting one mid-exam would re-serve
// an already-answered question and deleting one would skip an unseen
// one. They are refused (409) while any student has that class's exam in
// progress; editing text/options/marks/answer key stays allowed.
// PostgREST puts `.in()` values in the request URL, so a filter over every
// student in the exam (~400 uuids ≈ 15KB) can exceed gateway URL limits.
// Runs the query in batches and concatenates the rows instead.
const IN_FILTER_BATCH_SIZE = 100;
async function selectInBatches(values, runQuery) {
    const rows = [];
    for (let i = 0; i < values.length; i += IN_FILTER_BATCH_SIZE) {
        const { data, error } = await runQuery(values.slice(i, i + IN_FILTER_BATCH_SIZE));
        if (error) return { data: null, error };
        rows.push(...(data || []));
    }
    return { data: rows, error: null };
}

const LIVE_SESSIONS_MESSAGE =
    "Students are currently taking this exam. Adding, removing or reordering subjects/questions is blocked until every in-progress session has ended; editing question content is still allowed.";

async function classHasLiveSessions(classId) {
    if (!classId) return false;
    const { count, error } = await supabase
        .from("exam_sessions")
        .select("id", { count: "exact", head: true })
        .eq("class_id", classId)
        .eq("status", "IN_PROGRESS");
    if (error) throw error;
    return (count || 0) > 0;
}

async function subjectHasLiveSessions(subjectId) {
    const { data, error } = await supabase
        .from("subjects")
        .select("class_id")
        .eq("id", subjectId)
        .maybeSingle();
    if (error) throw error;
    return classHasLiveSessions(data?.class_id);
}

async function questionHasLiveSessions(questionId) {
    const { data, error } = await supabase
        .from("questions")
        .select("subject_id")
        .eq("id", questionId)
        .maybeSingle();
    if (error) throw error;
    return data ? subjectHasLiveSessions(data.subject_id) : false;
}

// exams.results_published comes from 014_preflight_results_hardening.sql —
// merged in separately (not part of the main select) so the Exams page
// keeps working, reporting "unpublished", on a database without it.
async function withResultsPublished(rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    const ids = list.filter(Boolean).map((row) => row.id);
    let published = new Map();
    if (ids.length) {
        const { data, error } = await supabase
            .from("exams")
            .select("id, results_published, results_published_at")
            .in("id", ids);
        if (error) {
            console.warn("[admin] results_published unavailable (has 014_preflight_results_hardening.sql been run?):", error.message || error);
        } else {
            published = new Map(data.map((row) => [row.id, row]));
        }
    }
    const merged = list.map((row) => row && {
        ...row,
        results_published: Boolean(published.get(row.id)?.results_published),
        results_published_at: published.get(row.id)?.results_published_at || null
    });
    return Array.isArray(rows) ? merged : merged[0];
}

// Shared pagination parsing for the list endpoints below — capped at
// 100/page so a malicious or mistaken ?limit=999999 can't force a huge
// unbounded query.
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    return { page, limit, from, to };
}

function parseDateFilters(query, fromKey = "from", toKey = "to") {
    const parseDay = (value, endOfDay = false) => {
        if (value === undefined || value === "") return null;
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
        const date = new Date(`${value}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
        if (endOfDay) date.setUTCHours(23, 59, 59, 999);
        return date.toISOString();
    };
    const from = parseDay(query[fromKey]);
    const to = parseDay(query[toKey], true);
    if (from === undefined || to === undefined || (from && to && from > to)) return null;
    return { from, to };
}

function spreadsheetText(value) {
    const text = value == null ? "" : String(value);
    return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
}


// =====================================================
// DASHBOARD
// =====================================================

const getDashboard = async (req, res) => {
    try {
        const requestedExamId = req.query.examId ? String(req.query.examId) : null;
        const requestedDates = parseDateFilters(req.query);
        if (requestedExamId && !isUuid(requestedExamId)) {
            return res.status(400).json({ success: false, message: "examId must be a valid exam ID" });
        }
        if (!requestedDates) {
            return res.status(400).json({ success: false, message: "from and to must be valid dates, and from must not be after to" });
        }

        const activeExam = await getActiveExam();
        let selectedExam = activeExam;
        if (requestedExamId) {
            const { data, error } = await supabase
                .from("exams")
                .select("id, exam_code, exam_name, status, seconds_per_question")
                .eq("id", requestedExamId)
                .maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ success: false, message: "Exam not found" });
            selectedExam = data;
        }

        const today = new Date().toISOString().slice(0, 10);
        const shiftDay = (day, amount) => {
            const shifted = new Date(`${day}T00:00:00.000Z`);
            shifted.setUTCDate(shifted.getUTCDate() + amount);
            return shifted.toISOString().slice(0, 10);
        };
        const trendFrom = requestedDates.from
            ? requestedDates.from.slice(0, 10)
            : shiftDay(requestedDates.to?.slice(0, 10) || today, -13);
        const trendTo = requestedDates.to
            ? requestedDates.to.slice(0, 10)
            : requestedDates.from
                ? shiftDay(trendFrom, 13)
                : today;
        const trendDays = Math.floor((Date.parse(`${trendTo}T00:00:00.000Z`) - Date.parse(`${trendFrom}T00:00:00.000Z`)) / 86_400_000) + 1;
        if (trendDays > 90) {
            return res.status(400).json({ success: false, message: "Dashboard trend date range cannot exceed 90 days" });
        }

        const [examsCount, registrationsResult, activeExamSessionsResult] = await Promise.all([
            supabase.from("exams").select("id", { count: "exact", head: true }),
            registrationSupabase
                .from("registrations")
                .select("registration_id")
                .eq("payment_status", "SUCCESS"),
            selectedExam
                ? supabase.from("exam_sessions").select("candidate_id, status, last_activity_at, exam_candidates(registration_id)").eq("exam_id", selectedExam.id)
                : Promise.resolve({ data: [], error: null })
        ]);

        for (const [label, result] of Object.entries({ examsCount, registrationsResult, activeExamSessionsResult })) {
            if (result.error) throw new Error(`${label}: ${result.error.message}`);
        }

        const activeExamSessions = activeExamSessionsResult.data || [];
        const eligibleRegistrationIds = new Set((registrationsResult.data || []).map((row) => row.registration_id));
        const sessionsByCandidate = new Map();
        for (const session of activeExamSessions) {
            // A candidate should have one active-exam session, but keeping
            // the latest row makes these totals accurate even if old data
            // contains duplicate session records.
            const existing = sessionsByCandidate.get(session.candidate_id);
            if (!existing || new Date(session.last_activity_at || 0) > new Date(existing.last_activity_at || 0)) {
                sessionsByCandidate.set(session.candidate_id, session);
            }
        }

        const sessionValues = Array.from(sessionsByCandidate.values())
            .filter((session) => eligibleRegistrationIds.has(session.exam_candidates?.registration_id));
        const inProgressCount = sessionValues.filter((session) => session.status === "IN_PROGRESS").length;
        const submittedCount = sessionValues.filter((session) => session.status === "SUBMITTED").length;
        const blockedCount = sessionValues.filter((session) => session.status === "BLOCKED").length;
        const loggedInCandidateIds = new Set();
        if (eligibleRegistrationIds.size && selectedExam?.id === activeExam?.id) {
            const { data: eligibleCandidates, error: eligibleCandidatesError } = await selectInBatches(
                Array.from(eligibleRegistrationIds),
                (batch) => supabase.from("exam_candidates").select("id, registration_id").in("registration_id", batch)
            );
            if (eligibleCandidatesError) throw eligibleCandidatesError;

            const eligibleCandidateIds = (eligibleCandidates || []).map((candidate) => candidate.id);
            if (eligibleCandidateIds.length) {
                try {
                    const { data: presenceRows, error: presenceError } = await selectInBatches(
                        eligibleCandidateIds,
                        (batch) => supabase.from("student_presence").select("candidate_id, stage, updated_at").in("candidate_id", batch)
                    );
                    if (presenceError) throw presenceError;
                    const sessionByCandidateId = new Map(activeExamSessions.map((session) => [session.candidate_id, session]));
                    for (const presence of presenceRows || []) {
                        const session = sessionByCandidateId.get(presence.candidate_id);
                        if (session) session.presence_updated_at = presence.updated_at;
                        const hasStarted = session && ["IN_PROGRESS", "SUBMITTED", "BLOCKED"].includes(session.status);
                        const presenceAge = Date.now() - new Date(presence.updated_at || 0).getTime();
                        const isCurrentlyPresent = presenceAge <= ACTIVE_PRESENCE_AFTER_SECONDS * 1000;
                        if (isCurrentlyPresent && !hasStarted && ["LOGGED_IN", "SYSTEM_CHECK", "RULES"].includes(presence.stage)) {
                            loggedInCandidateIds.add(presence.candidate_id);
                        }
                    }
                } catch (presenceError) {
                    console.warn("[getDashboard] student_presence unavailable:", presenceError.message || presenceError);
                }
            }
        }
        const loggedInCount = loggedInCandidateIds.size;
        const eligibleCount = eligibleRegistrationIds.size;
        const notStartedCount = Math.max(0, eligibleCount - submittedCount - inProgressCount - loggedInCount - blockedCount);

        const { data: scoredSessions, error: scoredError } = await supabase
            .from("exam_sessions")
            .select("total_score, max_score")
            .eq("status", "SUBMITTED")
            .eq("exam_id", selectedExam?.id || "00000000-0000-0000-0000-000000000000");

        if (scoredError) throw scoredError;

        const averageScorePercent = scoredSessions.length
            ? scoredSessions.reduce((sum, s) => sum + (s.max_score ? (s.total_score / s.max_score) * 100 : 0), 0) / scoredSessions.length
            : null;

        // Per-class breakdown for the Overview page's class activity table.
        // student_class is free text entered at registration — grouped here
        // rather than via a SQL GROUP BY so an unrecognized/blank class
        // still shows up (bucketed under "Unspecified") instead of being
        // silently dropped.
        const { data: sessionRows, error: sessionRowsError } = selectedExam
            ? await supabase
                .from("exam_sessions")
                .select("status, proctoring_warning_count, exam_candidates(registration_id, student_class)")
                .eq("exam_id", selectedExam.id)
            : { data: [], error: null };

        if (sessionRowsError) throw sessionRowsError;

        const classMap = new Map();
        for (const row of sessionRows) {
            if (!eligibleRegistrationIds.has(row.exam_candidates?.registration_id)) continue;
            const className = row.exam_candidates?.student_class?.trim() || "Unspecified";
            if (!classMap.has(className)) {
                classMap.set(className, { studentClass: className, present: 0, ongoing: 0, completed: 0, alerts: 0 });
            }
            const bucket = classMap.get(className);
            bucket.present += 1;
            if (row.status === "IN_PROGRESS") bucket.ongoing += 1;
            if (row.status === "SUBMITTED") bucket.completed += 1;
            if (row.status === "BLOCKED" || (row.proctoring_warning_count || 0) > 0) bucket.alerts += 1;
        }

        const classBreakdown = Array.from(classMap.values()).sort((a, b) => a.studentClass.localeCompare(b.studentClass, undefined, { numeric: true }));

        // "Not Started" and "Disconnected" are both scoped to the single
        // currently-ACTIVE exam (there is only ever one) — a candidate who
        // finished last year's exam but hasn't touched this one yet should
        // count as Not Started for THIS exam, not be hidden by an old
        // SUBMITTED row for a different one.
        let disconnectedCount = 0;

        if (selectedExam?.id === activeExam?.id) {
            disconnectedCount = sessionValues.filter((session) => isLikelyDisconnected(session, selectedExam.seconds_per_question)).length;
        }

        const dailyTrend = [];
        for (let day = trendFrom; day <= trendTo; day = shiftDay(day, 1)) {
            dailyTrend.push({ date: day, submissions: 0, averageScorePercent: null });
        }
        if (selectedExam) {
            const trendRows = [];
            const batchSize = 500;
            for (let offset = 0; ; offset += batchSize) {
                const { data, error } = await supabase.from("exam_sessions")
                    .select("submitted_at, total_score, max_score")
                    .eq("status", "SUBMITTED")
                    .eq("exam_id", selectedExam.id)
                    .gte("submitted_at", `${trendFrom}T00:00:00.000Z`)
                    .lte("submitted_at", `${trendTo}T23:59:59.999Z`)
                    .order("submitted_at", { ascending: true })
                    .range(offset, offset + batchSize - 1);
                if (error) throw error;
                trendRows.push(...(data || []));
                if (!data || data.length < batchSize) break;
            }
            const byDate = new Map(dailyTrend.map((point) => [point.date, point]));
            const scoreSums = new Map();
            const scoreCounts = new Map();
            for (const row of trendRows || []) {
                const point = byDate.get(row.submitted_at?.slice(0, 10));
                if (!point) continue;
                point.submissions += 1;
                if (row.max_score > 0) {
                    scoreSums.set(point.date, (scoreSums.get(point.date) || 0) + (row.total_score / row.max_score) * 100);
                    scoreCounts.set(point.date, (scoreCounts.get(point.date) || 0) + 1);
                }
            }
            for (const point of dailyTrend) {
                if (scoreCounts.has(point.date)) {
                    point.averageScorePercent = Math.round((scoreSums.get(point.date) / scoreCounts.get(point.date)) * 100) / 100;
                }
            }
        }

        return res.json({
            success: true,
            dashboard: {
                totalCandidates: loggedInCount,
                currentlyLoggedIn: loggedInCount,
                eligibleCandidates: eligibleCount,
                totalExams: examsCount.count || 0,
                sessionsInProgress: inProgressCount,
                sessionsSubmitted: submittedCount,
                sessionsBlocked: blockedCount,
                sessionsNotStarted: notStartedCount,
                sessionsDisconnected: disconnectedCount,
                averageScorePercent: averageScorePercent != null ? Math.round(averageScorePercent * 100) / 100 : null,
                classBreakdown,
                selectedExam: selectedExam ? { id: selectedExam.id, name: selectedExam.exam_name, status: selectedExam.status } : null,
                trendRange: { from: trendFrom, to: trendTo },
                dailyTrend
            }
        });
    } catch (error) {
        console.error("getDashboard error:", error);
        return res.status(500).json({ success: false, message: "Unable to load dashboard" });
    }
};


// =====================================================
// CANDIDATES
// =====================================================

const listCandidates = async (req, res) => {
    try {
        const { page, limit, from, to } = parsePagination(req.query);

        let query = supabase
            .from("exam_candidates")
            .select("id, registration_id, full_name, student_class, last_verified_at, created_at", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, to);

        const term = sanitizeSearchTerm(req.query.search);
        if (term) {
            query = query.or(`registration_id.ilike.%${term}%,full_name.ilike.%${term}%`);
        }

        const { data, error, count } = await query;
        if (error) throw error;

        let sessionByCandidate = new Map();
        let presenceByCandidate = new Map();
        let classByCandidate = new Map();
        const activeExam = await getActiveExam();
        if (activeExam && data.length) {
            const candidateIds = data.map((candidate) => candidate.id);
            const { data: sessions, error: sessionsError } = await supabase
                .from("exam_sessions")
                .select("id, candidate_id, exam_id, status, started_at, submitted_at, total_score, max_score, proctoring_warning_count")
                .eq("exam_id", activeExam.id)
                .in("candidate_id", candidateIds);
            if (sessionsError) throw sessionsError;
            sessionByCandidate = new Map(sessions.map((session) => [session.candidate_id, { ...session, exam: activeExam }]));

            const { data: classes, error: classesError } = await supabase
                .from("classes")
                .select("id, class_name")
                .eq("exam_id", activeExam.id);
            if (classesError) throw classesError;
            for (const candidate of data) {
                const candidateClass = normalizeClassName(candidate.student_class);
                const classRow = candidateClass === null
                    ? undefined
                    : classes.find((row) => normalizeClassName(row.class_name) === candidateClass);
                if (classRow) classByCandidate.set(candidate.id, classRow.id);
            }

            try {
                const { data: presence, error: presenceError } = await supabase
                    .from("student_presence")
                    .select("candidate_id, stage, updated_at")
                    .in("candidate_id", candidateIds);
                if (presenceError) throw presenceError;
                presenceByCandidate = new Map(presence.map((row) => [row.candidate_id, row]));
            } catch (presenceError) {
                console.warn("[listCandidates] student_presence unavailable:", presenceError.message || presenceError);
            }
        }

        const candidates = data.map((candidate) => ({
            ...candidate,
            session: sessionByCandidate.get(candidate.id) || null,
            presence: presenceByCandidate.get(candidate.id) || null,
            active_exam: activeExam || null,
            active_class_id: classByCandidate.get(candidate.id) || null
        }));

        return res.json({ success: true, page, limit, total: count, candidates });
    } catch (error) {
        console.error("listCandidates error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch candidates" });
    }
};

const getCandidate = async (req, res) => {
    try {
        const { candidateId } = req.params;

        const { data: candidate, error } = await supabase
            .from("exam_candidates")
            .select("id, registration_id, full_name, student_class, last_verified_at, created_at")
            .eq("id", candidateId)
            .maybeSingle();

        if (error) throw error;
        if (!candidate) return res.status(404).json({ success: false, message: "Candidate not found" });

        const { data: sessions, error: sessionsError } = await supabase
            .from("exam_sessions")
            .select("id, exam_id, status, started_at, submitted_at, total_score, max_score")
            .eq("candidate_id", candidateId);

        if (sessionsError) throw sessionsError;

        return res.json({ success: true, candidate: { ...candidate, sessions } });
    } catch (error) {
        console.error("getCandidate error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch candidate" });
    }
};


// =====================================================
// EXAMS
// =====================================================

const EXAM_BASE_FIELDS = "id, exam_code, exam_name, status, seconds_per_question, created_at";

// exam_start_at/duration_minutes back the Exam Timing feature
// (backend/sql/012_exam_timing.sql) — kept as their own optional field
// group for the same reason exam_date already is: this admin page must
// keep working in an environment where that migration hasn't been run
// yet, degrading to "not scheduled" (both null) rather than a dead page.
const EXAM_TIMING_FIELDS = "exam_start_at, duration_minutes";

// Adds the derived Scheduled/Live/Completed/Unscheduled status (and the
// computed exam_end_at) to an already-fetched exam row — the exact same
// computeTimingStatus() the student-facing waiting-room gate uses (see
// _examShared.js), so the admin badge and the actual enforcement can
// never disagree about what "Live" means.
function withTimingStatus(row) {
    if (!row) return row;
    const timingStatus = computeTimingStatus({ examStartAt: row.exam_start_at, durationMinutes: row.duration_minutes });
    return { ...row, timing_status: timingStatus.status, exam_end_at: timingStatus.examEndAt };
}

// "Only the ACTIVE Exam should be available" — enforced by deactivating
// every other exam before a target one is (re)activated, backed by the
// exams_single_active partial unique index (010_classes_hierarchy.sql)
// as a DB-level backstop against any other write path. excludeExamId is
// omitted when called from createExam, since the not-yet-inserted exam
// obviously isn't in the table to exclude.
async function deactivateAllExams(excludeExamId) {
    let query = supabase.from("exams").update({ status: "INACTIVE" }).eq("status", "ACTIVE");
    if (excludeExamId) query = query.neq("id", excludeExamId);
    const { error } = await query;
    if (error) throw error;
}

// exam_date is requested as part of the same select, but this page loads
// on every single admin visit to Question Bank/Mock Test/Exam
// Management — it must not go fully dark in an environment where
// backend/sql/004_exam_date.sql hasn't been run yet. On the specific
// "unknown column" error, retries once without exam_date rather than
// failing the whole request; every row just gets exam_date: null until
// the migration is applied.
const listExams = async (req, res) => {
    try {
        let { data, error } = await supabase
            .from("exams")
            .select(`${EXAM_BASE_FIELDS}, exam_date, ${EXAM_TIMING_FIELDS}`)
            .order("created_at", { ascending: false });

        if (error?.code === "42703") {
            const fallback = await supabase
                .from("exams")
                .select(`${EXAM_BASE_FIELDS}, exam_date`)
                .order("created_at", { ascending: false });
            if (fallback.error?.code === "42703") {
                const baseOnly = await supabase
                    .from("exams")
                    .select(EXAM_BASE_FIELDS)
                    .order("created_at", { ascending: false });
                if (baseOnly.error) throw baseOnly.error;
                data = baseOnly.data.map((row) => ({ ...row, exam_date: null, exam_start_at: null, duration_minutes: null }));
            } else if (fallback.error) {
                throw fallback.error;
            } else {
                data = fallback.data.map((row) => ({ ...row, exam_start_at: null, duration_minutes: null }));
            }
        } else if (error) {
            throw error;
        }

        return res.json({ success: true, exams: await withResultsPublished(data.map(withTimingStatus)) });
    } catch (error) {
        console.error("listExams error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch exams" });
    }
};

const createExam = async (req, res) => {
    try {
        const { examCode, examName, secondsPerQuestion, status, examDate, examStartAt, durationMinutes } = req.body;

        if (!examCode || !examName) {
            return res.status(400).json({ success: false, message: "examCode and examName are required" });
        }

        if (secondsPerQuestion !== undefined && (!Number.isFinite(secondsPerQuestion) || secondsPerQuestion <= 0)) {
            return res.status(400).json({ success: false, message: "secondsPerQuestion must be a positive number" });
        }

        if (durationMinutes !== undefined && durationMinutes !== null && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
            return res.status(400).json({ success: false, message: "durationMinutes must be a positive number of minutes" });
        }

        if (examStartAt !== undefined && examStartAt !== null && Number.isNaN(new Date(examStartAt).getTime())) {
            return res.status(400).json({ success: false, message: "examStartAt must be a valid date/time" });
        }

        const insertPayload = {
            exam_code: examCode.trim(),
            exam_name: examName.trim(),
            seconds_per_question: Number.isFinite(secondsPerQuestion) ? secondsPerQuestion : 60,
            status: status === "ACTIVE" ? "ACTIVE" : "INACTIVE"
        };
        // Only included when actually provided — the plain "Add Exam"
        // flow never sends these fields, and each must keep working even
        // in an environment where its own migration (004_exam_date.sql /
        // 012_exam_timing.sql) hasn't been run yet (the column wouldn't
        // exist to insert into — see the isMissingColumnError fallback
        // below).
        if (examDate !== undefined) insertPayload.exam_date = examDate || null;
        if (examStartAt !== undefined) insertPayload.exam_start_at = examStartAt || null;
        if (durationMinutes !== undefined) insertPayload.duration_minutes = durationMinutes || null;

        if (insertPayload.status === "ACTIVE") await deactivateAllExams();

        let { data, error } = await supabase
            .from("exams")
            .insert(insertPayload)
            .select()
            .single();

        if (isMissingColumnError(error)) {
            const { exam_start_at: _startAt, duration_minutes: _duration, ...withoutTiming } = insertPayload;
            const fallback = await supabase.from("exams").insert(withoutTiming).select().single();
            if (fallback.error) {
                if (fallback.error.code === "23505") {
                    return res.status(409).json({ success: false, message: "An exam with this examCode already exists" });
                }
                throw fallback.error;
            }
            data = { ...fallback.data, exam_start_at: null, duration_minutes: null };
        } else if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "An exam with this examCode already exists" });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "CREATE", "exam", data.id, { examCode: data.exam_code });

        return res.status(201).json({ success: true, exam: withTimingStatus(data) });
    } catch (error) {
        console.error("createExam error:", error);
        return res.status(500).json({ success: false, message: "Unable to create exam" });
    }
};

const getExam = async (req, res) => {
    try {
        const { examId } = req.params;
        let { data, error } = await supabase
            .from("exams")
            .select(`${EXAM_BASE_FIELDS}, exam_date, ${EXAM_TIMING_FIELDS}`)
            .eq("id", examId)
            .maybeSingle();

        if (error?.code === "42703") {
            const fallback = await supabase.from("exams").select(`${EXAM_BASE_FIELDS}, exam_date`).eq("id", examId).maybeSingle();
            if (fallback.error?.code === "42703") {
                const baseOnly = await supabase.from("exams").select(EXAM_BASE_FIELDS).eq("id", examId).maybeSingle();
                if (baseOnly.error) throw baseOnly.error;
                data = baseOnly.data ? { ...baseOnly.data, exam_date: null, exam_start_at: null, duration_minutes: null } : null;
            } else if (fallback.error) {
                throw fallback.error;
            } else {
                data = fallback.data ? { ...fallback.data, exam_start_at: null, duration_minutes: null } : null;
            }
        } else if (error) {
            throw error;
        }

        if (!data) return res.status(404).json({ success: false, message: "Exam not found" });

        return res.json({ success: true, exam: await withResultsPublished(withTimingStatus(data)) });
    } catch (error) {
        console.error("getExam error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch exam" });
    }
};

// The admin frontend's Exams list already disables the delete action on
// an ACTIVE exam (see admin-frontend/src/services/questionBank.js
// fetchExams) so it can never surface a delete against the exam
// getActiveExam() (backend/src/controllers/_examShared.js) is actually
// serving to students. This check is the server-side backstop for that —
// refuses regardless of which client calls it, deactivate first via
// PATCH /exams/:examId/status. Cascades to classes/subjects/questions
// via the existing FK ON DELETE CASCADE chain once it does proceed.
const deleteExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const { data, error } = await supabase.rpc("admin_delete_exam_completely", {
            p_exam_id: examId
        });
        if (error) throw error;

        const failures = {
            EXAM_NOT_FOUND: [404, "Exam not found"],
            EXAM_ACTIVE: [409, "Deactivate the exam before permanently deleting it"],
            EXAM_HAS_ACTIVE_ATTEMPTS: [409, "Students still have attempts in progress. Wait for them to finish before deleting."]
        };
        if (failures[data?.code]) {
            const [status, message] = failures[data.code];
            return res.status(status).json({ success: false, code: data.code, message });
        }
        if (!data?.success || !Array.isArray(data.screenshotPaths)) {
            throw new Error("Exam deletion returned an invalid response");
        }

        let photoCleanupError = null;
        if (data.screenshotPaths.length) {
            try {
                const { error: storageError } = await supabase.storage
                    .from("system-check-screenshots")
                    .remove(data.screenshotPaths);
                if (storageError) photoCleanupError = storageError;
            } catch (storageError) {
                photoCleanupError = storageError;
            }
        }

        let auditError = null;
        try {
            await logAdminAction(req.admin.id, "DELETE", "exam", examId, {
                deletedAttempts: data.deletedAttempts,
                deletedAnswers: data.deletedAnswers,
                deletedEvents: data.deletedEvents,
                deletedCheckInPhotos: data.deletedCheckInPhotos,
                photoCleanupFailed: Boolean(photoCleanupError)
            });
        } catch (error) {
            auditError = error;
            console.error("deleteExam audit logging failed after permanent deletion:", error, { examId });
        }

        if (photoCleanupError) {
            console.error("deleteExam photo cleanup failed after exam records were deleted:", photoCleanupError, {
                examId, photoCount: data.screenshotPaths.length
            });
        }
        if (photoCleanupError || auditError) {
            const details = [];
            if (photoCleanupError) details.push("stored check-in photos could not all be removed");
            if (auditError) details.push("the admin audit record could not be written");
            return res.status(500).json({
                success: false,
                examDeleted: true,
                message: `The exam and its database records were deleted, but ${details.join(" and ")}. Contact support to complete cleanup.`
            });
        }

        return res.json({
            success: true,
            message: "Exam and all exam-specific records and check-in photos were permanently deleted.",
            deletedAttempts: data.deletedAttempts,
            deletedAnswers: data.deletedAnswers,
            deletedEvents: data.deletedEvents,
            deletedCheckInPhotos: data.deletedCheckInPhotos
        });
    } catch (error) {
        console.error("deleteExam error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete exam" });
    }
};

const updateExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const { examName, secondsPerQuestion, examDate, examStartAt, durationMinutes } = req.body;

        if (secondsPerQuestion !== undefined && (!Number.isFinite(secondsPerQuestion) || secondsPerQuestion <= 0)) {
            return res.status(400).json({ success: false, message: "secondsPerQuestion must be a positive number" });
        }

        if (durationMinutes !== undefined && durationMinutes !== null && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
            return res.status(400).json({ success: false, message: "durationMinutes must be a positive number of minutes" });
        }

        if (examStartAt !== undefined && examStartAt !== null && Number.isNaN(new Date(examStartAt).getTime())) {
            return res.status(400).json({ success: false, message: "examStartAt must be a valid date/time" });
        }

        const updates = {};
        if (examName !== undefined) updates.exam_name = examName;
        if (secondsPerQuestion !== undefined) updates.seconds_per_question = secondsPerQuestion;
        if (examDate !== undefined) updates.exam_date = examDate || null;
        // examStartAt/durationMinutes are edited together as one "Exam
        // Timing" unit by the admin UI (see ExamsPage.tsx) — either can
        // also be cleared individually by sending null (the page's
        // "Clear Timing" action sends both null, unscheduling the exam
        // back to today's un-gated behavior).
        if (examStartAt !== undefined) updates.exam_start_at = examStartAt || null;
        if (durationMinutes !== undefined) updates.duration_minutes = durationMinutes || null;

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: "No fields to update" });
        }

        let { data, error } = await supabase
            .from("exams")
            .update(updates)
            .eq("id", examId)
            .select()
            .maybeSingle();

        if (isMissingColumnError(error)) {
            const { exam_start_at: _startAt, duration_minutes: _duration, ...updatesWithoutTiming } = updates;
            if (!Object.keys(updatesWithoutTiming).length) {
                return res.status(400).json({
                    success: false,
                    message: "Exam timing is not available yet — has backend/sql/012_exam_timing.sql been run?"
                });
            }
            const fallback = await supabase.from("exams").update(updatesWithoutTiming).eq("id", examId).select().maybeSingle();
            if (fallback.error) throw fallback.error;
            data = fallback.data ? { ...fallback.data, exam_start_at: null, duration_minutes: null } : null;
        } else if (error) {
            throw error;
        }

        if (!data) return res.status(404).json({ success: false, message: "Exam not found" });

        await logAdminAction(req.admin.id, "UPDATE", "exam", examId, updates);

        return res.json({ success: true, exam: withTimingStatus(data) });
    } catch (error) {
        console.error("updateExam error:", error);
        return res.status(500).json({ success: false, message: "Unable to update exam" });
    }
};

const updateExamStatus = async (req, res) => {
    try {
        const { examId } = req.params;
        const { status } = req.body;

        if (!["ACTIVE", "INACTIVE"].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be ACTIVE or INACTIVE" });
        }

        if (status === "ACTIVE") await deactivateAllExams(examId);

        const { data, error } = await supabase
            .from("exams")
            .update({ status })
            .eq("id", examId)
            .select()
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Exam not found" });

        await logAdminAction(req.admin.id, "STATUS_CHANGE", "exam", examId, { status });

        return res.json({ success: true, exam: await withResultsPublished(withTimingStatus(data)) });
    } catch (error) {
        console.error("updateExamStatus error:", error);
        return res.status(500).json({ success: false, message: "Unable to update exam status" });
    }
};

// Results stay hidden from students (GET /api/exam/result) until an
// admin publishes them for the exam. Unpublishing hides them again.
const updateResultsPublication = async (req, res) => {
    try {
        const { examId } = req.params;
        const { published } = req.body;

        if (!isUuid(examId)) return res.status(404).json({ success: false, message: "Exam not found" });
        if (typeof published !== "boolean") {
            return res.status(400).json({ success: false, message: "published must be true or false" });
        }

        const { data, error } = await supabase
            .from("exams")
            .update({ results_published: published, results_published_at: published ? new Date().toISOString() : null })
            .eq("id", examId)
            .select("id, results_published, results_published_at")
            .maybeSingle();

        if (isMissingColumnError(error)) {
            return res.status(400).json({
                success: false,
                message: "Result publication is not available yet — has backend/sql/014_preflight_results_hardening.sql been run?"
            });
        }
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Exam not found" });

        await logAdminAction(req.admin.id, published ? "PUBLISH_RESULTS" : "UNPUBLISH_RESULTS", "exam", examId, { published });

        return res.json({ success: true, exam: data });
    } catch (error) {
        console.error("updateResultsPublication error:", error);
        return res.status(500).json({ success: false, message: "Unable to update result publication" });
    }
};


// =====================================================
// CLASSES
//
// Sits between an Exam and its Subjects (see
// backend/sql/010_classes_hierarchy.sql). No status/activation of its
// own — only the parent Exam is ever activated, and a class's questions
// become live the moment its exam is ACTIVE and a student's registered
// class (see _examShared.js's getActiveExamForStudent) normalizes to
// match this row's class_name.
// =====================================================

const listClasses = async (req, res) => {
    try {
        const { examId } = req.params;
        const { data, error } = await supabase
            .from("classes")
            .select("id, exam_id, class_name, display_order, created_at")
            .eq("exam_id", examId)
            .order("display_order", { ascending: true });

        if (error) throw error;
        return res.json({ success: true, classes: data });
    } catch (error) {
        console.error("listClasses error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch classes" });
    }
};

const createClass = async (req, res) => {
    try {
        const { examId } = req.params;
        const { className, displayOrder } = req.body;

        if (!className || !className.trim() || displayOrder === undefined) {
            return res.status(400).json({ success: false, message: "className and displayOrder are required" });
        }

        const target = normalizeClassName(className);
        if (target !== null) {
            const { data: siblings, error: siblingsError } = await supabase
                .from("classes")
                .select("class_name")
                .eq("exam_id", examId);
            if (siblingsError) throw siblingsError;
            if (siblings.some((c) => normalizeClassName(c.class_name) === target)) {
                return res.status(409).json({ success: false, message: "A class matching this name already exists for this exam" });
            }
        }

        const { data, error } = await supabase
            .from("classes")
            .insert({
                exam_id: examId,
                class_name: className.trim(),
                display_order: displayOrder
            })
            .select()
            .single();

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "A class with this name or display order already exists for this exam" });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "CREATE", "class", data.id, { examId, className: data.class_name });

        return res.status(201).json({ success: true, class: data });
    } catch (error) {
        console.error("createClass error:", error);
        return res.status(500).json({ success: false, message: "Unable to create class" });
    }
};

const updateClass = async (req, res) => {
    try {
        const { classId } = req.params;
        const { className, displayOrder } = req.body;

        const updates = {};
        if (className !== undefined) updates.class_name = className.trim();
        if (displayOrder !== undefined) updates.display_order = displayOrder;

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: "No fields to update" });
        }

        if (updates.class_name !== undefined) {
            const { data: existing, error: existingError } = await supabase
                .from("classes")
                .select("exam_id")
                .eq("id", classId)
                .maybeSingle();
            if (existingError) throw existingError;
            if (!existing) return res.status(404).json({ success: false, message: "Class not found" });

            const target = normalizeClassName(updates.class_name);
            if (target !== null) {
                const { data: siblings, error: siblingsError } = await supabase
                    .from("classes")
                    .select("id, class_name")
                    .eq("exam_id", existing.exam_id);
                if (siblingsError) throw siblingsError;
                if (siblings.some((c) => c.id !== classId && normalizeClassName(c.class_name) === target)) {
                    return res.status(409).json({ success: false, message: "A class matching this name already exists for this exam" });
                }
            }
        }

        const { data, error } = await supabase
            .from("classes")
            .update(updates)
            .eq("id", classId)
            .select()
            .maybeSingle();

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "A class with this name or display order already exists for this exam" });
            }
            throw error;
        }
        if (!data) return res.status(404).json({ success: false, message: "Class not found" });

        await logAdminAction(req.admin.id, "UPDATE", "class", classId, updates);

        return res.json({ success: true, class: data });
    } catch (error) {
        console.error("updateClass error:", error);
        return res.status(500).json({ success: false, message: "Unable to update class" });
    }
};

const deleteClass = async (req, res) => {
    try {
        const { classId } = req.params;

        const { error } = await supabase
            .from("classes")
            .delete()
            .eq("id", classId);

        if (error) {
            if (error.code === "23503") {
                return res.status(409).json({
                    success: false,
                    message: "Cannot delete this class — students have already started sessions under it"
                });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "DELETE", "class", classId, null);

        return res.json({ success: true, message: "Class deleted" });
    } catch (error) {
        console.error("deleteClass error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete class" });
    }
};


// =====================================================
// SUBJECTS
// =====================================================

const listSubjects = async (req, res) => {
    try {
        const { classId } = req.params;
        const { data, error } = await supabase
            .from("subjects")
            .select("id, class_id, subject_key, subject_name, display_order")
            .eq("class_id", classId)
            .order("display_order", { ascending: true });

        if (error) throw error;
        return res.json({ success: true, subjects: data });
    } catch (error) {
        console.error("listSubjects error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch subjects" });
    }
};

const createSubject = async (req, res) => {
    try {
        const { classId } = req.params;
        const { subjectKey, subjectName, displayOrder } = req.body;

        if (!subjectKey || !subjectName || displayOrder === undefined) {
            return res.status(400).json({ success: false, message: "subjectKey, subjectName and displayOrder are required" });
        }

        if (await classHasLiveSessions(classId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const { data, error } = await supabase
            .from("subjects")
            .insert({
                class_id: classId,
                subject_key: subjectKey.trim(),
                subject_name: subjectName.trim(),
                display_order: displayOrder
            })
            .select()
            .single();

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "A subject with this key or display order already exists for this class" });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "CREATE", "subject", data.id, { classId, subjectKey: data.subject_key });

        return res.status(201).json({ success: true, subject: data });
    } catch (error) {
        console.error("createSubject error:", error);
        return res.status(500).json({ success: false, message: "Unable to create subject" });
    }
};

const updateSubject = async (req, res) => {
    try {
        const { subjectId } = req.params;
        const { subjectName, displayOrder } = req.body;

        const updates = {};
        if (subjectName !== undefined) updates.subject_name = subjectName;
        if (displayOrder !== undefined) updates.display_order = displayOrder;

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: "No fields to update" });
        }

        // Renaming is harmless mid-exam; reordering changes which subject
        // a live session's subjectIndex points at.
        if (updates.display_order !== undefined && await subjectHasLiveSessions(subjectId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const { data, error } = await supabase
            .from("subjects")
            .update(updates)
            .eq("id", subjectId)
            .select()
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Subject not found" });

        await logAdminAction(req.admin.id, "UPDATE", "subject", subjectId, updates);

        return res.json({ success: true, subject: data });
    } catch (error) {
        console.error("updateSubject error:", error);
        return res.status(500).json({ success: false, message: "Unable to update subject" });
    }
};

const deleteSubject = async (req, res) => {
    try {
        const { subjectId } = req.params;

        if (await subjectHasLiveSessions(subjectId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const { error } = await supabase
            .from("subjects")
            .delete()
            .eq("id", subjectId);

        if (error) {
            if (error.code === "23503") {
                return res.status(409).json({
                    success: false,
                    message: "Cannot delete this subject because its questions belong to recorded exam attempts. Keep it to preserve exam history."
                });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "DELETE", "subject", subjectId, null);

        return res.json({ success: true, message: "Subject deleted" });
    } catch (error) {
        console.error("deleteSubject error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete subject" });
    }
};


// =====================================================
// QUESTIONS
//
// correct_option is intentionally read and written here — this is the
// one place it's meant to flow through the API. exam.controller.js
// (student-facing) never selects this column; do not import anything
// from this file into a student route.
// =====================================================

const QUESTION_FIELDS = "id, subject_id, question_number, question_text, passage, option_a, option_b, option_c, option_d, correct_option, marks";

// A plain SELECT for a column PostgREST doesn't know about returns
// Postgres's own "42703 undefined_column" — but an INSERT/UPDATE that
// writes to it instead returns PostgREST's own "PGRST204" (schema-cache
// miss). Both mean the same thing here ("questions.status hasn't been
// migrated in yet"), so every status fallback below — read or write —
// must treat them as one case.
function isMissingColumnError(error) {
    return error?.code === "42703" || error?.code === "PGRST204";
}

// status is admin-side organizational metadata only (Active/Inactive, for
// filtering/curation on the Questions page) — it is deliberately NOT
// consulted anywhere in the student-facing delivery pipeline
// (_examShared.js's pointer-based getQuestionAtPointer/
// getQuestionDisplayAtPointer). That pipeline maps a session's pointer
// directly to question_number and assumes a dense, gapless 1..N sequence
// per subject; making "Inactive" actually skip a question during
// delivery would require reworking that pointer resolution into an
// offset-based query instead of a direct question_number lookup — a
// change to the most security-sensitive part of this system, not
// something to fold in silently alongside a display/filter field.
const listQuestions = async (req, res) => {
    try {
        const { subjectId } = req.params;

        let { data, error } = await supabase
            .from("questions")
            .select(`${QUESTION_FIELDS}, status`)
            .eq("subject_id", subjectId)
            .order("question_number", { ascending: true });

        if (isMissingColumnError(error)) {
            const fallback = await supabase
                .from("questions")
                .select(QUESTION_FIELDS)
                .eq("subject_id", subjectId)
                .order("question_number", { ascending: true });
            if (fallback.error) throw fallback.error;
            data = fallback.data.map((row) => ({ ...row, status: "ACTIVE" }));
        } else if (error) {
            throw error;
        }

        return res.json({ success: true, questions: data });
    } catch (error) {
        console.error("listQuestions error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch questions" });
    }
};

const createQuestion = async (req, res) => {
    try {
        const { subjectId } = req.params;
        const {
            questionNumber, questionText, passage,
            optionA, optionB, optionC, optionD,
            correctOption, marks, status
        } = req.body;

        if (!questionNumber || !questionText || !optionA || !optionB || !optionC || !optionD || !correctOption) {
            return res.status(400).json({
                success: false,
                message: "questionNumber, questionText, all four options and correctOption are required"
            });
        }

        if (!["A", "B", "C", "D"].includes(correctOption)) {
            return res.status(400).json({ success: false, message: "correctOption must be A, B, C or D" });
        }

        if (status !== undefined && !["ACTIVE", "INACTIVE"].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be ACTIVE or INACTIVE" });
        }

        if (await subjectHasLiveSessions(subjectId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const insertPayload = {
            subject_id: subjectId,
            question_number: questionNumber,
            question_text: questionText,
            passage: passage || null,
            option_a: optionA,
            option_b: optionB,
            option_c: optionC,
            option_d: optionD,
            correct_option: correctOption,
            marks: Number.isFinite(marks) ? marks : 1
        };

        let { data, error } = await supabase
            .from("questions")
            .insert({ ...insertPayload, status: status || "ACTIVE" })
            .select()
            .single();

        if (isMissingColumnError(error)) {
            const fallback = await supabase.from("questions").insert(insertPayload).select().single();
            if (fallback.error) throw fallback.error;
            data = { ...fallback.data, status: "ACTIVE" };
        } else if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "A question with this number already exists in this subject" });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "CREATE", "question", data.id, { subjectId, questionNumber });

        return res.status(201).json({ success: true, question: data });
    } catch (error) {
        console.error("createQuestion error:", error);
        return res.status(500).json({ success: false, message: "Unable to create question" });
    }
};

const getQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;

        let { data, error } = await supabase
            .from("questions")
            .select(`${QUESTION_FIELDS}, status`)
            .eq("id", questionId)
            .maybeSingle();

        if (isMissingColumnError(error)) {
            const fallback = await supabase.from("questions").select(QUESTION_FIELDS).eq("id", questionId).maybeSingle();
            if (fallback.error) throw fallback.error;
            data = fallback.data ? { ...fallback.data, status: "ACTIVE" } : null;
        } else if (error) {
            throw error;
        }

        if (!data) return res.status(404).json({ success: false, message: "Question not found" });

        return res.json({ success: true, question: data });
    } catch (error) {
        console.error("getQuestion error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch question" });
    }
};

const updateQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const {
            questionText, passage,
            optionA, optionB, optionC, optionD,
            correctOption, marks, status
        } = req.body;

        if (correctOption !== undefined && !["A", "B", "C", "D"].includes(correctOption)) {
            return res.status(400).json({ success: false, message: "correctOption must be A, B, C or D" });
        }

        if (status !== undefined && !["ACTIVE", "INACTIVE"].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be ACTIVE or INACTIVE" });
        }

        const updates = {};
        if (questionText !== undefined) updates.question_text = questionText;
        if (passage !== undefined) updates.passage = passage;
        if (optionA !== undefined) updates.option_a = optionA;
        if (optionB !== undefined) updates.option_b = optionB;
        if (optionC !== undefined) updates.option_c = optionC;
        if (optionD !== undefined) updates.option_d = optionD;
        if (correctOption !== undefined) updates.correct_option = correctOption;
        if (marks !== undefined) updates.marks = marks;
        if (status !== undefined) updates.status = status;

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: "No fields to update" });
        }

        // Every authenticated admin can edit any field of a question,
        // including the answer key — there is a single admin role.
        let { data, error } = await supabase
            .from("questions")
            .update(updates)
            .eq("id", questionId)
            .select()
            .maybeSingle();

        if (isMissingColumnError(error) && updates.status !== undefined) {
            const { status: _status, ...updatesWithoutStatus } = updates;
            if (!Object.keys(updatesWithoutStatus).length) {
                return res.status(400).json({
                    success: false,
                    message: "Question status is not available yet — has backend/sql/006_question_status.sql been run?"
                });
            }
            const fallback = await supabase
                .from("questions")
                .update(updatesWithoutStatus)
                .eq("id", questionId)
                .select()
                .maybeSingle();
            if (fallback.error) throw fallback.error;
            data = fallback.data ? { ...fallback.data, status: "ACTIVE" } : null;
        } else if (error) {
            throw error;
        }

        if (!data) return res.status(404).json({ success: false, message: "Question not found" });

        // Logged as which fields changed, not the actual option text/
        // correct answer value — keeps the audit log's blast radius
        // small even though only admins can ever read it.
        await logAdminAction(req.admin.id, "UPDATE", "question", questionId, {
            fieldsChanged: Object.keys(updates)
        });

        return res.json({ success: true, question: data });
    } catch (error) {
        console.error("updateQuestion error:", error);
        return res.status(500).json({ success: false, message: "Unable to update question" });
    }
};

const deleteQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;

        if (await questionHasLiveSessions(questionId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const { error } = await supabase
            .from("questions")
            .delete()
            .eq("id", questionId);

        if (error) {
            if (error.code === "23503") {
                return res.status(409).json({
                    success: false,
                    message: "Cannot delete this question because it belongs to recorded exam attempts. Set it to INACTIVE to remove it from future exams."
                });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "DELETE", "question", questionId, null);

        return res.json({ success: true, message: "Question deleted" });
    } catch (error) {
        console.error("deleteQuestion error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete question" });
    }
};


// =====================================================
// SESSIONS
// =====================================================

const SESSION_CANDIDATE_FIELDS = "registration_id, full_name, student_class, hall_ticket_number";
const SESSION_BASE_FIELDS =
    "id, candidate_id, exam_id, class_id, status, current_subject_index, current_question_index, question_started_at, started_at, submitted_at, last_activity_at, total_score, max_score, proctoring_warning_count, exams(exam_name, seconds_per_question)";

function missingMonitoringFunction(error, name) {
    return ["PGRST202", "42883"].includes(error?.code) &&
        `${error.message || ""} ${error.details || ""}`.includes(name);
}

const MONITORING_MIGRATION_MESSAGE =
    "Monitoring summaries are unavailable. Review and apply pending migration 021_admin_monitoring_summary.sql to the exam database, then refresh this page.";

const listSessions = async (req, res) => {
    try {
        const { page, limit, from, to } = parsePagination(req.query);

        const applyFilters = (q) => {
            let query = q;
            if (req.query.status) {
                // Comma-separated list support (e.g. "IN_PROGRESS,BLOCKED" for
                // Live Monitoring) — a single value still works the same as
                // the old .eq() did.
                const statuses = req.query.status.split(",").map((s) => s.trim()).filter(Boolean);
                query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", statuses[0]);
            }
            if (req.query.examId) {
                query = query.eq("exam_id", req.query.examId);
            }
            return query;
        };

        // hall_ticket_number is requested as part of the candidate embed,
        // but this page loads on every Live Students visit — it must not
        // go dark in an environment where 005_settings_and_presence.sql
        // hasn't been run yet. Falls back to the same query without it on
        // the specific "unknown column" error.
        let { data, error, count } = await applyFilters(
            supabase
                .from("exam_sessions")
                .select(`${SESSION_BASE_FIELDS}, exam_candidates(${SESSION_CANDIDATE_FIELDS})`, { count: "exact" })
                .order("created_at", { ascending: false })
                .range(from, to)
        );

        if (error?.code === "42703") {
            const fallback = await applyFilters(
                supabase
                    .from("exam_sessions")
                    .select(`${SESSION_BASE_FIELDS}, exam_candidates(registration_id, full_name, student_class)`, { count: "exact" })
                    .order("created_at", { ascending: false })
                    .range(from, to)
            );
            if (fallback.error) throw fallback.error;
            data = fallback.data.map((row) => ({ ...row, exam_candidates: { ...row.exam_candidates, hall_ticket_number: null } }));
            count = fallback.count;
        } else if (error) {
            throw error;
        }

        const progressBySession = new Map();
        let monitoringWarning = null;
        if (data.length) {
            const { data: progressRows, error: progressError } = await supabase.rpc("admin_exam_attempt_progress", {
                p_session_ids: data.map((session) => session.id)
            });
            if (progressError) {
                if (!missingMonitoringFunction(progressError, "admin_exam_attempt_progress")) throw progressError;
                monitoringWarning = MONITORING_MIGRATION_MESSAGE;
            }
            for (const progress of progressRows || []) {
                progressBySession.set(progress.session_id, {
                    attempted: progress.attempted,
                    total: progress.total,
                    current_subject: progress.current_subject
                });
            }
        }

        // Presence stage (Logged In / System Check / Rules / In Exam /
        // Completed) is display-only and lives in a separate table keyed
        // by candidate_id — fetched independently rather than as a
        // relational embed (no FK link between exam_sessions and
        // student_presence), and tolerant of the table not existing yet.
        let presenceByCandidate = new Map();
        if (data.length) {
            try {
                const { data: presenceRows, error: presenceError } = await supabase
                    .from("student_presence")
                    .select("candidate_id, stage, updated_at")
                    .in("candidate_id", data.map((s) => s.candidate_id));
                if (presenceError) throw presenceError;
                presenceByCandidate = new Map(presenceRows.map((p) => [p.candidate_id, p]));
            } catch (presenceError) {
                console.warn("[listSessions] student_presence unavailable (has 005_settings_and_presence.sql been run?):", presenceError.message || presenceError);
            }
        }

        const sessions = data.map((session) => {
            const presence = presenceByCandidate.get(session.candidate_id);
            const enriched = {
                ...session,
                attempt_progress: progressBySession.get(session.id) || null,
                presence_stage: presence?.stage || null,
                presence_updated_at: presence?.updated_at || null
            };
            return {
                ...enriched,
                is_likely_disconnected: isLikelyDisconnected(enriched, session.exams?.seconds_per_question)
            };
        });

        return res.json({ success: true, page, limit, total: count, sessions, monitoringWarning });
    } catch (error) {
        console.error("listSessions error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch sessions" });
    }
};

const getSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { data, error } = await supabase
            .from("exam_sessions")
            .select("*, exam_candidates(registration_id, full_name, student_class)")
            .eq("id", sessionId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Session not found" });

        return res.json({ success: true, session: data });
    } catch (error) {
        console.error("getSession error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch session" });
    }
};

// Superseded the old GET /api/exam/session/admin/result/:sessionId
// (static-API-key protected) — same query shape, now behind
// adminJwtAuth + a real admin identity instead.
const getSessionResult = async (req, res) => {
    try {
        const { sessionId } = req.params;

        const { data: session, error: sessionError } = await supabase
            .from("exam_sessions")
            .select("*, exam_candidates(registration_id, full_name, student_class)")
            .eq("id", sessionId)
            .maybeSingle();

        if (sessionError) throw sessionError;
        if (!session) return res.status(404).json({ success: false, message: "Exam session not found" });

        const { data: answers, error: answersError } = await supabase
            .from("exam_answers")
            .select("question_id, subject_id, selected_option, is_attempted, is_correct, questions(question_number, marks)")
            .eq("session_id", sessionId);

        if (answersError) throw answersError;

        let resultAnswers = answers;
        if (session.sequence_initialized_at) {
            const { data: sequence, error: sequenceError } = await supabase
                .from("exam_attempt_questions")
                .select("question_id, position, question_number, marks, correct_option")
                .eq("session_id", sessionId)
                .order("position", { ascending: true });
            if (sequenceError) throw sequenceError;
            const snapshotByQuestion = new Map(sequence.map((question) => [question.question_id, question]));
            resultAnswers = answers.map((answer) => {
                const snapshot = snapshotByQuestion.get(answer.question_id);
                return snapshot ? {
                    ...answer,
                    position: snapshot.position,
                    is_correct: answer.selected_option ? answer.selected_option === snapshot.correct_option : null,
                    questions: { question_number: snapshot.question_number, marks: snapshot.marks }
                } : answer;
            }).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
        }

        return res.json({ success: true, session, answers: resultAnswers });
    } catch (error) {
        console.error("getSessionResult error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch session result" });
    }
};


// Full answer sheet for one attempt: every question in the attempt, with
// its options, the student's selection, the correct option and the result.
// Read-only — built from data the exam already stores:
//   exam_attempt_questions  immutable per-attempt snapshot (question text,
//                           options, correct option, order) — so later edits
//                           to the question bank never change a past sheet
//   exam_answers            the student's selection, correctness, timestamp
//   exam_sessions           student (candidate_id), exam, attempt
// A question with no exam_answers row (never reached: early submission or
// the exam deadline) is reported as unanswered.
const ANSWER_LETTERS = ["A", "B", "C", "D"];

function answerSheetRow(question, answer, fallbackPosition) {
    const options = {
        A: question.option_a, B: question.option_b, C: question.option_c, D: question.option_d
    };
    const selectedOption = answer?.selected_option || null;
    const correctOption = question.correct_option;
    return {
        position: question.position ?? fallbackPosition,
        sequenceNumber: (question.position ?? fallbackPosition) + 1,
        questionId: question.question_id ?? question.id,
        subjectName: question.subject_name ?? question.subjects?.subject_name ?? null,
        questionNumber: question.question_number,
        questionText: question.question_text,
        passage: question.passage || null,
        options,
        marks: question.marks,
        selectedOption,
        selectedOptionText: selectedOption ? options[selectedOption] : null,
        correctOption,
        correctOptionText: options[correctOption],
        answered: selectedOption !== null,
        isCorrect: selectedOption ? selectedOption === correctOption : null,
        reached: Boolean(answer),
        timeSpentSeconds: answer?.time_spent_seconds ?? null,
        answeredAt: answer?.answered_at ?? null
    };
}

const getSessionAnswerSheet = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!isUuid(sessionId)) return res.status(404).json({ success: false, message: "Exam session not found" });

        const { data: session, error: sessionError } = await supabase
            .from("exam_sessions")
            .select("id, candidate_id, exam_id, status, started_at, submitted_at, total_score, max_score, proctoring_warning_count, sequence_initialized_at, exams(exam_name), exam_candidates(registration_id, full_name, student_class)")
            .eq("id", sessionId)
            .maybeSingle();
        if (sessionError) throw sessionError;
        if (!session) return res.status(404).json({ success: false, message: "Exam session not found" });

        const { data: answers, error: answersError } = await supabase
            .from("exam_answers")
            .select("question_id, selected_option, is_attempted, is_correct, time_spent_seconds, answered_at")
            .eq("session_id", sessionId);
        if (answersError) throw answersError;
        const answerByQuestion = new Map(answers.map((answer) => [answer.question_id, answer]));

        let rows;
        let source;
        if (session.sequence_initialized_at) {
            const { data: sequence, error: sequenceError } = await supabase
                .from("exam_attempt_questions")
                .select("position, question_id, subject_name, question_number, question_text, passage, option_a, option_b, option_c, option_d, correct_option, marks")
                .eq("session_id", sessionId)
                .order("position", { ascending: true });
            if (sequenceError) throw sequenceError;
            rows = sequence.map((question) => answerSheetRow(question, answerByQuestion.get(question.question_id)));
            source = "attempt_snapshot";
        } else {
            // Attempts created before migration 017 have no snapshot: only
            // the questions they saved an answer for can be shown, read from
            // the current question bank.
            const questionIds = answers.map((answer) => answer.question_id);
            const { data: questions, error: questionsError } = questionIds.length
                ? await supabase
                    .from("questions")
                    .select("id, question_number, question_text, passage, option_a, option_b, option_c, option_d, correct_option, marks, subjects(subject_name, display_order)")
                    .in("id", questionIds)
                : { data: [], error: null };
            if (questionsError) throw questionsError;
            rows = questions
                .slice()
                .sort((a, b) => ((a.subjects?.display_order ?? 0) - (b.subjects?.display_order ?? 0)) || (a.question_number - b.question_number))
                .map((question, index) => answerSheetRow(question, answerByQuestion.get(question.id), index));
            source = "legacy_answers";
        }

        const summary = {
            totalQuestions: rows.length,
            answered: rows.filter((row) => row.answered).length,
            unanswered: rows.filter((row) => !row.answered).length,
            correct: rows.filter((row) => row.isCorrect === true).length,
            incorrect: rows.filter((row) => row.isCorrect === false).length
        };

        return res.json({
            success: true,
            source,
            attempt: {
                id: session.id,
                candidateId: session.candidate_id,
                examId: session.exam_id,
                examName: session.exams?.exam_name || null,
                studentName: session.exam_candidates?.full_name || null,
                registrationId: session.exam_candidates?.registration_id || null,
                studentClass: session.exam_candidates?.student_class || null,
                status: session.status,
                startedAt: session.started_at,
                submittedAt: session.submitted_at,
                totalScore: session.total_score,
                maxScore: session.max_score,
                proctoringWarningCount: session.proctoring_warning_count
            },
            summary,
            questions: rows,
            letters: ANSWER_LETTERS
        });
    } catch (error) {
        console.error("getSessionAnswerSheet error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch the attempt answer sheet" });
    }
};


// =====================================================
// RESULTS
// =====================================================

// percentage is plain arithmetic on already-authoritative scored fields
// (total_score/max_score, both set once at submission — see
// session.controller.js submitExam) — not a ranking or a pass/fail
// judgment, so it's safe to compute here. There is deliberately no
// rank/classRank/qualification-status field: no official ranking rule
// is defined anywhere in this system, so the admin frontend must not
// invent one (see admin-frontend/src/services/results.js).
function resultFilters(query) {
    const examId = query.examId ? String(query.examId) : null;
    const className = query.className ? String(query.className).trim() : null;
    const dates = parseDateFilters(query);
    if (examId && !isUuid(examId)) return { error: "examId must be a valid exam ID" };
    if (className && (!className.length || className.length > 80)) return { error: "className must be 1–80 characters" };
    if (!dates) return { error: "from and to must be valid dates, and from must not be after to" };
    return { filters: { examId, className, dates, term: sanitizeSearchTerm(query.search) } };
}

function resultQuery(filters, { count = false } = {}) {
    const needsCandidateJoin = Boolean(filters.term || filters.className);
    let query = supabase
        .from("exam_sessions")
        .select(
            `id, candidate_id, exam_id, submitted_at, total_score, max_score, exam_candidates${needsCandidateJoin ? "!inner" : ""}(registration_id, full_name, student_class)`,
            count ? { count: "exact" } : undefined
        )
        .eq("status", "SUBMITTED")
        .order("submitted_at", { ascending: false });
    if (filters.examId) query = query.eq("exam_id", filters.examId);
    if (filters.className) query = query.eq("exam_candidates.student_class", filters.className);
    if (filters.dates.from) query = query.gte("submitted_at", filters.dates.from);
    if (filters.dates.to) query = query.lte("submitted_at", filters.dates.to);
    if (filters.term) {
        query = query.or(
            `registration_id.ilike.%${filters.term}%,full_name.ilike.%${filters.term}%`,
            { foreignTable: "exam_candidates" }
        );
    }
    return query;
}

async function allResultRows(filters) {
    const rows = [];
    const batchSize = 500;
    for (let from = 0; ; from += batchSize) {
        const { data, error } = await resultQuery(filters).range(from, from + batchSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < batchSize) return rows;
    }
}

const RESULT_EXPORT_HEADERS = ["Student Name", "Registration ID", "Class", "Exam ID", "Submitted At", "Score", "Maximum Score", "Percentage"];
function resultExportRow(row) {
    const candidate = row.exam_candidates || {};
    return [
        candidate.full_name, candidate.registration_id, candidate.student_class,
        row.exam_id, row.submitted_at, row.total_score, row.max_score,
        row.max_score ? Math.round((row.total_score / row.max_score) * 1000) / 10 : 0
    ];
}

function csvDocument(headers, records) {
    const csvCell = (value) => {
        const safe = spreadsheetText(value);
        return `"${safe.replace(/"/g, '""')}"`;
    };
    return `\uFEFF${[headers, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n")}`;
}

const listResults = async (req, res) => {
    try {
        const selected = resultFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const { page, limit, from, to } = parsePagination(req.query);
        const { data, error, count } = await resultQuery(selected.filters, { count: true }).range(from, to);
        if (error) throw error;
        const results = data.map((row) => ({
            ...row,
            percentage: row.max_score ? Math.round((row.total_score / row.max_score) * 1000) / 10 : 0
        }));
        return res.json({ success: true, page, limit, total: count, results });
    } catch (error) {
        console.error("listResults error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch results" });
    }
};

const exportResultsCsv = async (req, res) => {
    try {
        const selected = resultFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const rows = await allResultRows(selected.filters);
        res.set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="gtst-exam-results.csv"',
            "Cache-Control": "no-store"
        });
        return res.send(csvDocument(RESULT_EXPORT_HEADERS, rows.map(resultExportRow)));
    } catch (error) {
        console.error("exportResultsCsv error:", error);
        return res.status(500).json({ success: false, message: "Unable to export results" });
    }
};

const exportResultsXlsx = async (req, res) => {
    try {
        const selected = resultFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const rows = await allResultRows(selected.filters);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Results");
        sheet.addRow(RESULT_EXPORT_HEADERS);
        for (const row of rows) {
            const exported = resultExportRow(row);
            sheet.addRow(exported.map((value) => typeof value === "string" ? spreadsheetText(value) : value));
        }
        sheet.getRow(1).font = { bold: true };
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": 'attachment; filename="gtst-exam-results.xlsx"',
            "Cache-Control": "no-store"
        });
        return res.send(await workbook.xlsx.writeBuffer());
    } catch (error) {
        console.error("exportResultsXlsx error:", error);
        return res.status(500).json({ success: false, message: "Unable to export results" });
    }
};


// =====================================================
// PROCTORING
// =====================================================

const listProctoringEvents = async (req, res) => {
    try {
        const selected = proctoringFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const { page, limit, from, to } = parsePagination(req.query);
        const { data, error, count } = await proctoringEventQuery(selected.filters, { count: true }).range(from, to);
        if (error) throw error;
        return res.json({ success: true, page, limit, total: count, events: data });
    } catch (error) {
        console.error("listProctoringEvents error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch proctoring events" });
    }
};

const PROCTORING_EVENT_TYPES = new Set([
    "MULTIPLE_FACE", "NO_FACE", "CAMERA_DISABLED", "MICROPHONE_DISABLED", "TAB_SWITCH",
    "WINDOW_BLUR", "FULLSCREEN_EXIT", "RIGHT_CLICK", "COPY_PASTE", "NETWORK_DISCONNECT",
    "NETWORK_RECONNECT", "EXAM_LEFT", "SCREEN_SHARE_STOPPED"
]);

function proctoringFilters(query) {
    const examId = query.examId ? String(query.examId) : null;
    const sessionId = query.sessionId ? String(query.sessionId) : null;
    const eventType = query.eventType ? String(query.eventType) : null;
    const className = query.className ? String(query.className).trim() : null;
    const dates = parseDateFilters(query, "from", "to");
    const reviewed = query.reviewed === undefined ? null : String(query.reviewed);
    let createdAfter = null;
    if (query.createdAfter !== undefined) {
        const parsed = new Date(String(query.createdAfter));
        if (Number.isNaN(parsed.getTime())) return { error: "createdAfter must be a valid date/time" };
        createdAfter = parsed.toISOString();
    }
    if (examId && !isUuid(examId)) return { error: "examId must be a valid exam ID" };
    if (sessionId && !isUuid(sessionId)) return { error: "sessionId must be a valid session ID" };
    if (eventType && !PROCTORING_EVENT_TYPES.has(eventType)) return { error: "eventType is not recognized" };
    if (className && (!className.length || className.length > 80)) return { error: "className must be 1–80 characters" };
    if (reviewed !== null && !["true", "false"].includes(reviewed)) return { error: "reviewed must be true or false" };
    if (!dates) return { error: "from and to must be valid dates, and from must not be after to" };
    return {
        filters: {
            examId, sessionId, eventType, className, dates,
            reviewed: reviewed === null ? null : reviewed === "true", createdAfter,
            term: sanitizeSearchTerm(query.search)
        }
    };
}

function proctoringEventQuery(filters, { count = false } = {}) {
    const candidateJoin = filters.term || filters.className ? "exam_candidates!inner" : "exam_candidates";
    let query = supabase.from("exam_events")
        .select(
            `id, session_id, event_type, event_message, warning_number, reviewed, reviewed_at, created_at, occurred_at, is_violation, exam_sessions!inner(candidate_id, exam_id, status, proctoring_warning_count, exams(exam_name), ${candidateJoin}(registration_id, full_name, student_class))`,
            count ? { count: "exact" } : undefined
        )
        .order("created_at", { ascending: false });
    if (filters.sessionId) query = query.eq("session_id", filters.sessionId);
    if (filters.examId) query = query.eq("exam_sessions.exam_id", filters.examId);
    if (filters.className) query = query.eq("exam_sessions.exam_candidates.student_class", filters.className);
    if (filters.eventType) query = query.eq("event_type", filters.eventType);
    if (filters.reviewed !== null) query = query.eq("reviewed", filters.reviewed);
    if (filters.dates.from) query = query.gte("created_at", filters.dates.from);
    if (filters.dates.to) query = query.lte("created_at", filters.dates.to);
    if (filters.createdAfter) query = query.gte("created_at", filters.createdAfter);
    if (filters.term) {
        query = query.or(
            `registration_id.ilike.%${filters.term}%,full_name.ilike.%${filters.term}%`,
            { foreignTable: "exam_sessions.exam_candidates" }
        );
    }
    return query;
}

async function allProctoringEvents(filters, { violationsOnly = false } = {}) {
    const rows = [];
    const batchSize = 500;
    for (let from = 0; ; from += batchSize) {
        const { data, error } = await proctoringEventQuery(filters).range(from, from + batchSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < batchSize) {
            return violationsOnly
                ? rows.filter((event) => event.is_violation === true ||
                    (event.is_violation == null && !["NETWORK_DISCONNECT", "NETWORK_RECONNECT"].includes(event.event_type)))
                : rows;
        }
    }
}

const PROCTORING_EXPORT_HEADERS = [
    "Student Name", "Registration ID", "Class", "Exam", "Session ID", "Event Type",
    "Event Message", "Event Time", "Violation", "Reviewed", "Reviewed At", "Warning Number"
];
function proctoringExportRow(event) {
    const session = event.exam_sessions || {};
    const candidate = session.exam_candidates || {};
    const violation = event.is_violation === null || event.is_violation === undefined
        ? !["NETWORK_DISCONNECT", "NETWORK_RECONNECT"].includes(event.event_type)
        : event.is_violation;
    return [
        candidate.full_name, candidate.registration_id, candidate.student_class,
        session.exams?.exam_name, event.session_id, event.event_type, event.event_message,
        event.occurred_at || event.created_at, violation ? "Yes" : "No",
        event.reviewed ? "Yes" : "No", event.reviewed_at, event.warning_number
    ];
}

const exportProctoringEventsCsv = async (req, res) => {
    try {
        const selected = proctoringFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const rows = await allProctoringEvents(selected.filters, { violationsOnly: true });
        res.set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="gtst-proctoring-violations.csv"',
            "Cache-Control": "no-store"
        });
        return res.send(csvDocument(PROCTORING_EXPORT_HEADERS, rows.map(proctoringExportRow)));
    } catch (error) {
        console.error("exportProctoringEventsCsv error:", error);
        return res.status(500).json({ success: false, message: "Unable to export proctoring events" });
    }
};

const exportProctoringEventsXlsx = async (req, res) => {
    try {
        const selected = proctoringFilters(req.query);
        if (selected.error) return res.status(400).json({ success: false, message: selected.error });
        const rows = await allProctoringEvents(selected.filters, { violationsOnly: true });
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Proctoring Violations");
        sheet.addRow(PROCTORING_EXPORT_HEADERS);
        for (const row of rows) {
            sheet.addRow(proctoringExportRow(row).map((value) => typeof value === "string" ? spreadsheetText(value) : value));
        }
        sheet.getRow(1).font = { bold: true };
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": 'attachment; filename="gtst-proctoring-violations.xlsx"',
            "Cache-Control": "no-store"
        });
        return res.send(await workbook.xlsx.writeBuffer());
    } catch (error) {
        console.error("exportProctoringEventsXlsx error:", error);
        return res.status(500).json({ success: false, message: "Unable to export proctoring events" });
    }
};

const summarizeMonitoringEvents = async (req, res) => {
    try {
        const sessionIds = req.body?.sessionIds;
        if (!Array.isArray(sessionIds) || sessionIds.length > 500 ||
            sessionIds.some((id) => !isUuid(id))) {
            return res.status(400).json({ success: false, message: "sessionIds must contain at most 500 valid session IDs" });
        }
        if (!sessionIds.length) return res.json({ success: true, summaries: [] });

        const { data, error } = await supabase.rpc("admin_monitoring_event_summary", {
            p_session_ids: Array.from(new Set(sessionIds))
        });
        if (missingMonitoringFunction(error, "admin_monitoring_event_summary")) {
            return res.status(503).json({
                success: false,
                code: "MONITORING_MIGRATION_REQUIRED",
                message: MONITORING_MIGRATION_MESSAGE
            });
        }
        if (error) throw error;
        return res.json({ success: true, summaries: data || [] });
    } catch (error) {
        console.error("summarizeMonitoringEvents error:", error);
        return res.status(500).json({ success: false, message: "Unable to summarize monitoring events" });
    }
};

// Backs the Violations page's "Mark as Reviewed" action. exam_events is
// otherwise append-only (see 002_admin_schema.sql) — reviewed/
// reviewed_at/reviewed_by are the one exception, added in
// 003_admin_extensions.sql specifically for this.
const reviewProctoringEvent = async (req, res) => {
    try {
        const { eventId } = req.params;

        const { data, error } = await supabase
            .from("exam_events")
            .update({
                reviewed: true,
                reviewed_at: new Date().toISOString(),
                reviewed_by: req.admin.id
            })
            .eq("id", eventId)
            .select("id, reviewed, reviewed_at")
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Proctoring event not found" });

        await logAdminAction(req.admin.id, "UPDATE", "proctoring_event", eventId, { reviewed: true });

        return res.json({ success: true, event: data });
    } catch (error) {
        console.error("reviewProctoringEvent error:", error);
        return res.status(500).json({ success: false, message: "Unable to update proctoring event" });
    }
};


// =====================================================
// AUDIT LOGS — read side of logAdminAction (utils/auditLog.js), which
// every mutation above already writes to. Nothing wrote here directly.
// =====================================================

const listAuditLogs = async (req, res) => {
    try {
        const { page, limit, from, to } = parsePagination(req.query);

        let query = supabase
            .from("admin_audit_logs")
            .select("id, admin_id, action, resource_type, resource_id, metadata, created_at, admin_users(name, email)", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, to);

        if (req.query.action) {
            query = query.eq("action", req.query.action);
        }
        if (req.query.resourceType) {
            query = query.eq("resource_type", req.query.resourceType);
        }

        const { data, error, count } = await query;
        if (error) throw error;

        return res.json({ success: true, page, limit, total: count, logs: data });
    } catch (error) {
        console.error("listAuditLogs error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch audit logs" });
    }
};


// =====================================================
// ADMIN USER MANAGEMENT — every authenticated admin can manage admin
// accounts. There is a single role ("admin"); it is never chosen or
// changed. Each handler trusts req.admin.id for attribution/audit only.
// =====================================================

const listAdminUsers = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("admin_users")
            .select("id, name, email, role, is_active, created_at, updated_at, last_login_at")
            .order("created_at", { ascending: false });

        if (error) throw error;
        return res.json({ success: true, admins: data });
    } catch (error) {
        console.error("listAdminUsers error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch admin users" });
    }
};

const createAdminUser = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "name, email and password are required" });
        }

        if (password.length < 10) {
            return res.status(400).json({ success: false, message: "Password must be at least 10 characters" });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        // Single role — every admin account is created as "admin".
        const { data, error } = await supabase
            .from("admin_users")
            .insert({
                name: name.trim(),
                email: email.trim().toLowerCase(),
                password_hash: passwordHash,
                role: "admin"
            })
            .select("id, name, email, role, is_active, created_at")
            .single();

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, message: "An admin with this email already exists" });
            }
            throw error;
        }

        await logAdminAction(req.admin.id, "CREATE", "admin_user", data.id, { email: data.email, role: data.role });

        return res.status(201).json({ success: true, admin: data });
    } catch (error) {
        console.error("createAdminUser error:", error);
        return res.status(500).json({ success: false, message: "Unable to create admin user" });
    }
};

const updateAdminUser = async (req, res) => {
    try {
        const { adminId } = req.params;
        const { name, password } = req.body;

        const updates = { updated_at: new Date().toISOString() };
        if (name !== undefined) updates.name = name;

        if (password !== undefined) {
            if (password.length < 10) {
                return res.status(400).json({ success: false, message: "Password must be at least 10 characters" });
            }
            updates.password_hash = await bcrypt.hash(password, 12);
        }

        const { data, error } = await supabase
            .from("admin_users")
            .update(updates)
            .eq("id", adminId)
            .select("id, name, email, role, is_active, created_at, updated_at, last_login_at")
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Admin user not found" });

        await logAdminAction(req.admin.id, "UPDATE", "admin_user", adminId, {
            fieldsChanged: Object.keys(updates).filter((k) => k !== "updated_at")
        });

        return res.json({ success: true, admin: data });
    } catch (error) {
        console.error("updateAdminUser error:", error);
        return res.status(500).json({ success: false, message: "Unable to update admin user" });
    }
};

const updateAdminUserStatus = async (req, res) => {
    try {
        const { adminId } = req.params;
        const { isActive } = req.body;

        if (typeof isActive !== "boolean") {
            return res.status(400).json({ success: false, message: "isActive must be true or false" });
        }

        if (adminId === req.admin.id && !isActive) {
            return res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
        }

        const { data, error } = await supabase
            .from("admin_users")
            .update({ is_active: isActive, updated_at: new Date().toISOString() })
            .eq("id", adminId)
            .select("id, name, email, role, is_active")
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Admin user not found" });

        await logAdminAction(req.admin.id, "STATUS_CHANGE", "admin_user", adminId, { isActive });

        return res.json({ success: true, admin: data });
    } catch (error) {
        console.error("updateAdminUserStatus error:", error);
        return res.status(500).json({ success: false, message: "Unable to update admin user status" });
    }
};


// =====================================================
// STUDENT DEVICE SESSIONS
//
// One active device lease per student (018_single_device_sessions.sql).
// Admins may view it and release a stuck lease (e.g. a crashed device),
// which only removes the lease: no token is issued here, so the student
// must still log in with their own credentials on the replacement device.
// The lease identifier itself is never returned.
// =====================================================

const DEVICE_RELEASE_REASON_MAX = 500;

function mapDeviceSession(row) {
    if (!row) return null;
    const now = Date.now();
    return {
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        tokenExpiresAt: row.token_expires_at,
        active: Date.parse(row.expires_at) > now && Date.parse(row.token_expires_at) > now
    };
}

const getCandidateDeviceSession = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const { data, error } = await supabase
            .from("student_login_sessions")
            .select("created_at, last_seen_at, expires_at, token_expires_at")
            .eq("candidate_id", candidateId)
            .maybeSingle();
        if (error) throw error;
        return res.json({ success: true, deviceSession: mapDeviceSession(data) });
    } catch (error) {
        console.error("getCandidateDeviceSession error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch the device session" });
    }
};

const releaseCandidateDeviceSession = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (reason.length < 3 || reason.length > DEVICE_RELEASE_REASON_MAX) {
            return res.status(400).json({ success: false, message: `A reason of 3-${DEVICE_RELEASE_REASON_MAX} characters is required` });
        }
        const { data: candidate, error: candidateError } = await supabase
            .from("exam_candidates").select("id, registration_id").eq("id", candidateId).maybeSingle();
        if (candidateError) throw candidateError;
        if (!candidate) return res.status(404).json({ success: false, message: "Candidate not found" });

        const { data, error } = await supabase.rpc("admin_release_student_login_session", { p_candidate_id: candidateId });
        if (error) throw error;
        if (!data?.released) {
            return res.status(404).json({ success: false, message: "This student has no device session to release" });
        }
        await logAdminAction(req.admin.id, "RELEASE_DEVICE_SESSION", "candidate", candidateId, {
            registrationId: candidate.registration_id, reason,
            leaseCreatedAt: data.createdAt, leaseLastSeenAt: data.lastSeenAt, leaseExpiresAt: data.expiresAt
        });
        return res.json({ success: true, message: "Device session released. The student can now log in again." });
    } catch (error) {
        console.error("releaseCandidateDeviceSession error:", error);
        return res.status(500).json({ success: false, message: "Unable to release the device session" });
    }
};

const resetExamAttempts = async (req, res) => {
    try {
        const { examId } = req.params;
        const { data, error } = await supabase.rpc("admin_reset_exam_attempts", {
            p_exam_id: examId
        });
        if (error) throw error;

        const failures = {
            EXAM_NOT_FOUND: [404, "Exam not found"],
            EXAM_ACTIVE: [409, "Deactivate the exam before resetting student attempts"],
            EXAM_HAS_ACTIVE_ATTEMPTS: [409, "Students still have attempts in progress. Wait for them to finish before resetting."],
            CANDIDATE_ACTIVE_IN_ANOTHER_EXAM: [409, "A student in this exam has an active attempt in another exam. Resolve it before resetting."]
        };
        if (failures[data?.code]) {
            const [status, message] = failures[data.code];
            return res.status(status).json({ success: false, code: data.code, message });
        }
        if (!data?.success) throw new Error("Exam reset returned an invalid response");

        await logAdminAction(req.admin.id, "RESET_EXAM_ATTEMPTS", "exam", examId, {
            candidateCount: data.candidateCount,
            deletedAttempts: data.deletedAttempts,
            deletedAnswers: data.deletedAnswers,
            deletedEvents: data.deletedEvents,
            releasedLoginSessions: data.releasedLoginSessions,
            clearedPreflightRecords: data.clearedPreflightRecords,
            clearedPresenceRecords: data.clearedPresenceRecords
        });
        return res.json({
            success: true,
            message: "Exam attempts were reset. Students can log in again and start a new attempt.",
            ...data
        });
    } catch (error) {
        console.error("resetExamAttempts error:", error);
        return res.status(500).json({ success: false, message: "Unable to reset exam attempts" });
    }
};

module.exports = {
    subjectHasLiveSessions,
    LIVE_SESSIONS_MESSAGE,
    getDashboard,
    listCandidates,
    getCandidate,
    getCandidateDeviceSession,
    releaseCandidateDeviceSession,
    listExams,
    createExam,
    getExam,
    updateExam,
    updateExamStatus,
    updateResultsPublication,
    resetExamAttempts,
    deleteExam,
    listClasses,
    createClass,
    updateClass,
    deleteClass,
    listSubjects,
    createSubject,
    updateSubject,
    deleteSubject,
    listQuestions,
    createQuestion,
    getQuestion,
    updateQuestion,
    deleteQuestion,
    listSessions,
    getSession,
    getSessionResult,
    getSessionAnswerSheet,
    listResults,
    exportResultsCsv,
    exportResultsXlsx,
    listProctoringEvents,
    exportProctoringEventsCsv,
    exportProctoringEventsXlsx,
    summarizeMonitoringEvents,
    reviewProctoringEvent,
    listAuditLogs,
    listAdminUsers,
    createAdminUser,
    updateAdminUser,
    updateAdminUserStatus
};
