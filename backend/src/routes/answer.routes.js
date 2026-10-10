const express = require("express");
const studentAuth = require("../middleware/studentAuth");
const { answerLimiter, studentReadLimiter } = require("../middleware/rateLimiters");

const {
    saveAnswer,
    saveDraft,
    getMyAnswers
} = require("../controllers/answer.controller");

const router = express.Router();

router.post("/answers", studentAuth, answerLimiter, saveAnswer);
router.post("/answers/draft", studentAuth, answerLimiter, saveDraft);
router.get("/answers/:sessionId", studentAuth, studentReadLimiter, getMyAnswers);

module.exports = router;
