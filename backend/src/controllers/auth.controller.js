const registrationSupabase = require("../config/registrationSupabase");
const examSupabase = require("../config/examSupabase");
const { getActiveExam, getExamDate, recordPresence, getFinishedActiveAttempt } = require("./_examShared");
<<<<<<< HEAD
const { isNonEmptyString, normalizeLoginId } = require("../utils/validation");
=======
const { isNonEmptyString } = require("../utils/validation");
>>>>>>> origin/main
const {
    readStudentToken, issueStudentToken, acquireStudentSession,
    touchStudentSession, sessionRpc, SESSION_ACTIVE_BODY, SESSION_EXPIRED_BODY
} = require("../utils/studentSessions");

// Fallback only — used when the active exam has no exam_date configured
// yet (backend/sql/004_exam_date.sql added the column; existing exams
// start out NULL until an admin sets one via PUT /api/admin/exams/:id).
const FALLBACK_EXAM_DATE =
    process.env.EXAM_DATE || "2026-10-11";

// Fallback only — used if no ACTIVE exam exists in the exams table (e.g.
// the very first run, before 001_exam_schema.sql's seed has landed).
// Whenever an active exam exists, its live exam_name is used instead, so
// renaming the exam in the admin dashboard (PUT /api/admin/exams/:id)
// reaches every student's next login without a restart.
const FALLBACK_EXAM_NAME =
    "Global Talent Scholarship Test Plus · South India Level";


// ========================================
// LOGIN
// ========================================

const login = async (req, res) => {

    try {

        const {
            registrationId,
            hallTicketNumber
        } = req.body;


        // ========================================
        // 1. VALIDATE INPUT
        // ========================================

        if (!isNonEmptyString(registrationId) || !isNonEmptyString(hallTicketNumber)) {

            return res.status(400).json({
                success: false,
                message:
                    "Registration ID and Hall Ticket Number are required"
            });
        }


        // ========================================
        // 2. FIND STUDENT RECORD MATCHING BOTH FIELDS
        // ========================================
<<<<<<< HEAD
        //
        // Case-insensitive in the database (ILIKE on both columns of the
        // same row), so "gtst26100094" finds "GTST26100094". The input is
        // normalized first and can hold no pattern characters, so ILIKE
        // here is a plain case-insensitive equality. Stored values are
        // never changed; everything below uses the stored spelling.

        const regIdInput = normalizeLoginId(registrationId);
        const hallTicketInput = normalizeLoginId(hallTicketNumber);

        if (!regIdInput || !hallTicketInput) {
            return res.status(401).json({
                success: false,
                message:
                    "Invalid Registration ID or Hall Ticket Number"
            });
        }

        const {
            data: matches,
=======

        const {
            data: student,
>>>>>>> origin/main
            error: studentError
        } = await registrationSupabase

            .from("registrations")

            .select(`
                id,
                registration_id,
                hall_ticket_number,
                full_name,
                student_class,
                payment_status
            `)

<<<<<<< HEAD
            .ilike(
                "registration_id",
                regIdInput
            )

            .ilike(
                "hall_ticket_number",
                hallTicketInput
            )

            .limit(2);

        // Two records differing only in letter case would make the match
        // ambiguous — never guess which student is logging in.
        if (!studentError && matches?.length > 1) {
            console.error("Student lookup is ambiguous: several registrations match ignoring case.");
            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify student"
            });
        }

        const student = matches?.[0] ?? null;
=======
            .eq(
                "registration_id",
                registrationId.trim()
            )

            .eq(
                "hall_ticket_number",
                hallTicketNumber.trim()
            )

            .maybeSingle();
>>>>>>> origin/main


        if (studentError) {

            console.error(
                "Student lookup error:",
                studentError
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify student"
            });
        }


        if (!student) {

            return res.status(401).json({
                success: false,
                message:
                    "Invalid Registration ID or Hall Ticket Number"
            });
        }


        // ========================================
        // 3. CHECK ELIGIBILITY
        // ========================================

        if (student.payment_status !== "SUCCESS") {

            return res.status(403).json({
                success: false,
                message:
                    "Student is not eligible for this examination"
            });
        }


        // ========================================
        // 4. GET-OR-CREATE THE MATCHING EXAM CANDIDATE
        // ========================================
        //
        // The Exam Supabase never stores the Registration Supabase's own
        // uuid — registration_id (the shared text code, e.g.
        // "GTST26100094") is what ties the two systems together.
        // exam_candidates is this project's own minimal identity row,
        // created the first time a verified student reaches the exam
        // portal, and everything downstream (exam_sessions, exam_answers)
        // foreign-keys against its local id instead.

        // hall_ticket_number is included when backend/sql/005_settings_and_
        // presence.sql has been run (adds the column); on an unmigrated
        // database this upsert fails with an unknown-column error, and the
        // retry below drops just that field so login itself never breaks
        // over a column the admin dashboard's Live Students page merely
        // wants to display.
        let candidate;
        let candidateError;

        ({ data: candidate, error: candidateError } = await examSupabase
            .from("exam_candidates")
            .upsert(
                {
                    registration_id: student.registration_id,
                    full_name: student.full_name,
                    student_class: student.student_class,
                    hall_ticket_number: student.hall_ticket_number,
                    last_verified_at: new Date().toISOString()
                },
                { onConflict: "registration_id" }
            )
            .select("id")
            .single());

        if (candidateError) {
            console.warn("[login] exam_candidates upsert with hall_ticket_number failed, retrying without it (has 005_settings_and_presence.sql been run?):", candidateError.message || candidateError);

            ({ data: candidate, error: candidateError } = await examSupabase
                .from("exam_candidates")
                .upsert(
                    {
                        registration_id: student.registration_id,
                        full_name: student.full_name,
                        student_class: student.student_class,
                        last_verified_at: new Date().toISOString()
                    },
                    { onConflict: "registration_id" }
                )
                .select("id")
                .single());
        }

        if (candidateError) {
            console.error("Exam candidate upsert error:", candidateError);
            return res.status(500).json({
                success: false,
                message: "Unable to set up exam access"
            });
        }

        // ========================================
        // 4b. LIVE EXAM NAME
        // ========================================
        //
        // Queried fresh on every login — never cached — so a rename in
        // the admin dashboard shows up for the next student who logs in,
        // with no server restart involved.

        let examName = FALLBACK_EXAM_NAME;
        let examDate = FALLBACK_EXAM_DATE;
        try {
            const activeExam = await getActiveExam();
            if (activeExam?.exam_name) {
                examName = activeExam.exam_name;
                // Separate, error-tolerant lookup — see getExamDate's
                // comment in _examShared.js for why this isn't just
                // folded into getActiveExam()'s own select().
                const liveExamDate = await getExamDate(activeExam.id);
                if (liveExamDate) examDate = liveExamDate;
            } else {
                console.warn("[auth.login] No ACTIVE exam found — falling back to the static exam name.");
            }
        } catch (examLookupError) {
            console.error("[auth.login] getActiveExam() failed, falling back to the static exam name/date:", examLookupError);
        }


        // ========================================
        // 5. ISSUE SESSION TOKEN
        // ========================================
        //
        // Every exam session/question/answer endpoint requires this token
        // (see backend/src/middleware/studentAuth.js) so a student can only
        // ever read or write their own data. It carries the exam-local
        // candidate id, not anything from the Registration Supabase.

        const secret = process.env.STUDENT_JWT_SECRET;

        if (!secret) {
            console.error("STUDENT_JWT_SECRET is not configured");
            return res.status(500).json({
                success: false,
                message: "Server error"
            });
        }

        // An expired token is accepted only here, after verifying the
        // student's registration credentials, to identify their original
        // device. It cannot restore a lease that a different device owns.
        const recoveryPayload = readStudentToken(req, { allowExpired: true });
        const activeSession = await acquireStudentSession(candidate, student, recoveryPayload);
        if (!activeSession?.active) {
            return res.status(409).json(SESSION_ACTIVE_BODY);
        }
        const { token } = activeSession;
        // A competing login must never reset the original device's
        // monitoring stage. Recovery preserves its current stage too.
        // A completed student logging in again stays COMPLETED for admins.
        if (!activeSession.resumed && !(await getFinishedActiveAttempt(candidate.id))) {
            await recordPresence(candidate.id, "LOGGED_IN");
        }


        // ========================================
        // 6. SUCCESSFUL LOGIN
        // ========================================

        return res.json({

            success: true,

            message:
                "Login successful",

            token,
            loginExpiresAt: activeSession.expiresAt,

            student: {

                registrationId:
                    student.registration_id,

                hallTicketNumber:
                    student.hall_ticket_number,

                name:
                    student.full_name,

                class:
                    student.student_class,

                examName:
                    examName,

                examDate:
                    examDate
            }
        });


    } catch (error) {

        console.error(
            "Login error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "Server error. Please try again."
        });
    }
};

const heartbeat = async (req, res) => {
    try {
        const { candidateId, registrationId, studentClass, loginSessionId, tokenExpiresAt } = req.student;
        let issued;
        // Refresh only near expiry, while the original device still owns
        // the database lease. A long running exam must not lose its JWT.
        if (tokenExpiresAt * 1000 - Date.now() <= 10 * 60 * 1000) {
            issued = issueStudentToken({ candidateId, registrationId, studentClass, loginSessionId });
        }
        // Middleware already validated/renewed a normal heartbeat. Only
        // token rotation needs a second database update.
        const result = issued
            ? await touchStudentSession({ candidateId, loginSessionId, exp: tokenExpiresAt }, issued.expiresAt)
            : { active: true, expiresAt: req.student.loginExpiresAt, serverTime: req.student.loginServerTime };
        if (!result?.active) return res.status(409).json(SESSION_EXPIRED_BODY);
        return res.json({
            success: true,
            serverTime: result.serverTime,
            expiresAt: result.expiresAt,
            ...(issued && { token: issued.token })
        });
    } catch (error) {
        console.error("[heartbeat] error:", error.message);
        return res.status(503).json({ success: false, code: "SESSION_UNAVAILABLE", message: "Unable to renew your session. Please retry shortly." });
    }
};

const logout = async (req, res) => {
    try {
        const payload = readStudentToken(req, { allowExpired: true });
        if (!payload) return res.status(401).json({ success: false, message: "Authentication required" });
        await sessionRpc("release_student_login_session", {
            p_candidate_id: payload.candidateId, p_login_session_id: payload.loginSessionId
        });
        return res.json({ success: true, message: "Logged out successfully" });
    } catch (error) {
        console.error("[logout] error:", error.message);
        return res.status(503).json({ success: false, message: "Unable to end your session. Please retry shortly." });
    }
};

module.exports = {
    login,
    heartbeat,
    logout
};
