const ExcelJS = require("exceljs");
const supabase = require("../config/examSupabase");
const { logAdminAction } = require("../utils/auditLog");
const { subjectHasLiveSessions, LIVE_SESSIONS_MESSAGE } = require("./admin.controller");

const TEMPLATE_HEADERS = ["Question", "Option A", "Option B", "Option C", "Option D", "Correct Answer"];
const VALID_ANSWERS = new Set(["A", "B", "C", "D"]);

// Real .xlsx files are zip archives — sniffed by content the same way
// branding.controller.js sniffs uploaded image bytes, not trusted from
// the filename extension or Content-Type header alone.
function looksLikeXlsx(buffer) {
    if (!buffer || buffer.length < 4) return false;
    return buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

// Cell values from exceljs can be a plain string/number, rich text
// ({richText: [...]}), a formula result ({result: ...}), or a Date —
// normalized to a trimmed plain string regardless of which.
function cellText(cell) {
    const value = cell ? cell.value : null;
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
        if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
        if (value.result !== undefined) return String(value.result);
        if (value.text !== undefined) return String(value.text);
        if (value instanceof Date) return value.toISOString();
        return "";
    }
    return String(value);
}


// =====================================================
// DOWNLOAD QUESTION TEMPLATE
//
// Subject-agnostic — the six columns never vary by subject, so this
// isn't parameterized by subjectId.
// =====================================================

const downloadQuestionTemplate = async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Questions");
        sheet.addRow(TEMPLATE_HEADERS);
        sheet.addRow(["What is the capital of India?", "Mumbai", "New Delhi", "Kolkata", "Chennai", "B"]);
        sheet.columns.forEach((column) => {
            column.width = 28;
        });

        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=question-upload-template.xlsx");
        return res.send(Buffer.from(buffer));
    } catch (error) {
        console.error("downloadQuestionTemplate error:", error);
        return res.status(500).json({ success: false, message: "Unable to generate the question template" });
    }
};


// =====================================================
// IMPORT QUESTIONS (bulk, via Excel)
//
// Validates every row before inserting any — a partially-bad file never
// silently drops the bad rows, it reports every row's pass/fail in the
// response body so nothing is swallowed. correct_option here follows
// the exact same rules as the manual createQuestion in admin.controller.js
// (must be A/B/C/D); this file never exposes it to anything student-facing.
// =====================================================

const importQuestions = async (req, res) => {
    try {
        const { subjectId } = req.params;

        if (!req.file) {
            return res.status(400).json({ success: false, message: "An Excel (.xlsx) file is required" });
        }

        const originalName = (req.file.originalname || "").toLowerCase();
        if (!originalName.endsWith(".xlsx") || !looksLikeXlsx(req.file.buffer)) {
            return res.status(400).json({ success: false, message: "The uploaded file does not look like a valid .xlsx workbook" });
        }

        const { data: subject, error: subjectError } = await supabase
            .from("subjects")
            .select("id")
            .eq("id", subjectId)
            .maybeSingle();
        if (subjectError) throw subjectError;
        if (!subject) return res.status(404).json({ success: false, message: "Subject not found" });

        // Same live-exam guard as createQuestion: inserting questions under
        // an in-progress session would shift its question pointer.
        if (await subjectHasLiveSessions(subjectId)) {
            return res.status(409).json({ success: false, message: LIVE_SESSIONS_MESSAGE });
        }

        const workbook = new ExcelJS.Workbook();
        try {
            await workbook.xlsx.load(req.file.buffer);
        } catch {
            return res.status(400).json({ success: false, message: "Unable to parse this file as an Excel workbook" });
        }

        const sheet = workbook.worksheets[0];
        if (!sheet || sheet.rowCount < 2) {
            return res.status(400).json({ success: false, message: "The uploaded file has no data rows" });
        }

        const headerRow = sheet.getRow(1);
        const columnByHeader = {};
        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            columnByHeader[cellText(cell).trim()] = colNumber;
        });

        const missingHeaders = TEMPLATE_HEADERS.filter((h) => !columnByHeader[h]);
        if (missingHeaders.length) {
            return res.status(400).json({
                success: false,
                message: `The uploaded file is missing required column(s): ${missingHeaders.join(", ")}. Use "Download Template" to get the correct format.`
            });
        }

        const dataRows = [];
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
            const row = sheet.getRow(rowNumber);
            const values = {
                questionText: cellText(row.getCell(columnByHeader["Question"])).trim(),
                optionA: cellText(row.getCell(columnByHeader["Option A"])).trim(),
                optionB: cellText(row.getCell(columnByHeader["Option B"])).trim(),
                optionC: cellText(row.getCell(columnByHeader["Option C"])).trim(),
                optionD: cellText(row.getCell(columnByHeader["Option D"])).trim(),
                correctAnswer: cellText(row.getCell(columnByHeader["Correct Answer"])).trim().toUpperCase()
            };
            // Entirely blank rows (common trailing rows in a spreadsheet) are
            // skipped silently — not counted as a row at all, since they were
            // never data to begin with.
            const isBlank = Object.values(values).every((v) => v === "");
            if (isBlank) continue;
            dataRows.push({ rowNumber, ...values });
        }

        if (!dataRows.length) {
            return res.status(400).json({ success: false, message: "The uploaded file has no data rows" });
        }

        const { data: existingQuestions, error: existingError } = await supabase
            .from("questions")
            .select("question_number, question_text")
            .eq("subject_id", subjectId);
        if (existingError) throw existingError;

        let nextNumber = existingQuestions.reduce((max, q) => Math.max(max, q.question_number), 0) + 1;
        const existingTextsLower = new Set(existingQuestions.map((q) => q.question_text.trim().toLowerCase()));
        const seenInBatchLower = new Set();

        const results = [];
        const toInsert = [];

        for (const row of dataRows) {
            const { rowNumber, questionText, optionA, optionB, optionC, optionD, correctAnswer } = row;

            const errors = [];
            if (!questionText) errors.push("Question is required");
            if (!optionA) errors.push("Option A is required");
            if (!optionB) errors.push("Option B is required");
            if (!optionC) errors.push("Option C is required");
            if (!optionD) errors.push("Option D is required");
            if (!VALID_ANSWERS.has(correctAnswer)) errors.push("Correct Answer must be A, B, C or D");

            const textLower = questionText.toLowerCase();
            if (questionText && existingTextsLower.has(textLower)) {
                errors.push("An identical question already exists in this subject");
            } else if (questionText && seenInBatchLower.has(textLower)) {
                errors.push("Duplicate of another row in this same file");
            }

            if (errors.length) {
                results.push({ row: rowNumber, status: "ERROR", questionText, errors });
                continue;
            }

            seenInBatchLower.add(textLower);
            const questionNumber = nextNumber++;
            toInsert.push({
                subject_id: subjectId,
                question_number: questionNumber,
                question_text: questionText,
                option_a: optionA,
                option_b: optionB,
                option_c: optionC,
                option_d: optionD,
                correct_option: correctAnswer,
                marks: 1
            });
            results.push({ row: rowNumber, status: "OK", questionText, questionNumber });
        }

        if (toInsert.length) {
            const { error: insertError } = await supabase.from("questions").insert(toInsert);
            if (insertError) {
                console.error("importQuestions batch insert error:", insertError);
                return res.status(500).json({
                    success: false,
                    message: "Unable to import questions — no rows were changed. Please try again."
                });
            }
        }

        const summary = { totalRows: dataRows.length, imported: toInsert.length, failed: dataRows.length - toInsert.length };

        await logAdminAction(req.admin.id, "IMPORT", "question", subjectId, summary);

        return res.status(200).json({ success: true, summary, results });
    } catch (error) {
        console.error("importQuestions error:", error);
        return res.status(500).json({ success: false, message: "Unable to import questions" });
    }
};


module.exports = {
    downloadQuestionTemplate,
    importQuestions
};
