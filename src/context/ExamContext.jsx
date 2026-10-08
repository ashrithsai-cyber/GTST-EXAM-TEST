import React, { createContext, useState, useContext, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AuthContext } from './AuthContext';
import { QUESTION_SECONDS } from '../utils/constants';
import { createCountdown, readCountdown } from '../utils/examClock';
import { startExamSession, fetchCurrentQuestion, fetchExamInfo, saveExamAnswer, submitExamSession, fetchExamNavigation, updateExamAnswer } from '../services/examService';

export const ExamContext = createContext();
const LETTERS = ['A', 'B', 'C', 'D'];
function buildQuestion(question, subject, response) {
  if (!question || !subject) return null;
  return {
    id: question.id, questionNumber: question.questionNumber, questionText: question.questionText,
    passage: question.passage, options: LETTERS.map((letter) => question.options[letter]), marks: question.marks,
    subjectId: subject.subjectId, subjectKey: subject.subjectKey, subjectName: subject.subjectName,
    questionCountInSubject: subject.questionCount, sequenceNumber: response.sequenceNumber ?? question.sequenceNumber,
  };
}
const pendingKey = (id) => `gtst_pending_answer_${id}`;
function readPending(id) {
  try { return JSON.parse(sessionStorage.getItem(pendingKey(id)) || 'null'); } catch { return null; }
}
function writePending(id, value) {
  try {
    if (value) sessionStorage.setItem(pendingKey(id), JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey(id));
  } catch { /* Live saves still work when browser storage is unavailable. */ }
}

export const ExamProvider = ({ children }) => {
  const { token, student } = useContext(AuthContext);
  const [sessionId, setSessionId] = useState(null);
  const [examMeta, setExamMeta] = useState(null);
  const [subjectsMeta, setSubjectsMeta] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [questionItems, setQuestionItems] = useState([]);
  const [answers, setAnswers] = useState({}); // Immutable question IDs, never bank positions.
  const [sectionIdx, setSectionIdx] = useState(0);
  const [qIdx, setQIdx] = useState(0);
  const [timeLeft, setTimeLeft] = useState(QUESTION_SECONDS);
  const [examTimeLeft, setExamTimeLeft] = useState(null);
  const [examEndAt, setExamEndAt] = useState(null);
  const [waitingForStart, setWaitingForStart] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitTime, setSubmitTime] = useState(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [banners, setBanners] = useState([]);
  const [saveToastOn, setSaveToastOn] = useState(false);
  const [examLoading, setExamLoading] = useState(true);
  const [examInitError, setExamInitError] = useState(null);
  const [examComplete, setExamComplete] = useState(false);
  const [draftStatus, setDraftStatus] = useState('idle');
  const clocks = useRef({ question: null, exam: null });
  const draftQueue = useRef(Promise.resolve());
  const pendingDraft = useRef(null);
  const activeQuestion = useRef(null);
  const activeSession = useRef(null);
  const generation = useRef(0);
  const syncing = useRef(false);
  const stateVersion = useRef(0);
  const advancing = useRef(false);
  const latestAnswers = useRef(answers);
  latestAnswers.current = answers;
  activeQuestion.current = currentQuestion;
  activeSession.current = sessionId;

  const syncClocks = useCallback((response) => {
    if (response.remainingSeconds != null) {
      clocks.current.question = createCountdown(response.remainingSeconds);
      setTimeLeft(readCountdown(clocks.current.question));
    }
    if (response.examTiming) {
      clocks.current.exam = createCountdown(response.examTiming.remainingSeconds);
      setExamTimeLeft(readCountdown(clocks.current.exam));
      setExamEndAt(response.examTiming.examEndAt);
    }
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (clocks.current.question) setTimeLeft(readCountdown(clocks.current.question));
      if (clocks.current.exam) setExamTimeLeft(readCountdown(clocks.current.exam));
    }, 250);
    return () => clearInterval(timer);
  }, []);
  const markSubmitted = useCallback((response = {}) => {
    setSubmitted(true); setSubmitTime(response.submittedAt || response.session?.submittedAt || null);
    setExamComplete(true); setCurrentQuestion(null);
    clocks.current = { question: null, exam: null };
    writePending(activeSession.current, null); pendingDraft.current = null;
  }, []);
  const applyCurrent = useCallback((response, attemptId) => {
    syncClocks(response);
    if (response.autoSubmitted || response.submitted || response.status === 'SUBMITTED') {
      markSubmitted(response); return;
    }
    if (response.examComplete) {
      setCurrentQuestion(null); setExamComplete(true); clocks.current.question = null; return;
    }
    const question = buildQuestion(response.question || response.nextQuestion,
      response.subject || response.nextQuestion?.subject, response);
    if (!question) return;
    const changed = activeQuestion.current?.id !== question.id;
    setCurrentQuestion(question);
    setSectionIdx(response.subjectIndex ?? response.nextSubjectIndex ?? 0);
    setQIdx(response.questionIndex ?? response.nextQuestionIndex ?? 0);
    setExamComplete(false);
    const pending = pendingDraft.current || readPending(attemptId);
    const selectedOption = pending?.questionId === question.id
      ? pending.selectedOption : response.selectedOption ?? response.question?.selectedOption ?? null;
    if (pending?.questionId === question.id) {
      pendingDraft.current = pending; setDraftStatus('pending');
    } else if (changed) {
      pendingDraft.current = null; writePending(attemptId, null); setDraftStatus('idle');
    }
    // Never erase a selection made while this synchronization was in flight.
    if (changed || !pendingDraft.current) {
      setAnswers((old) => ({ ...old, [question.id]: { sel: selectedOption == null ? null : LETTERS.indexOf(selectedOption) } }));
    }
  }, [syncClocks, markSubmitted]);
  const getAns = (questionId) => answers[questionId] || { sel: null };
  const setAns = (questionId, patch) => {
    stateVersion.current += 1;
    const next = { ...latestAnswers.current, [questionId]: { sel: null, ...latestAnswers.current[questionId], ...patch } };
    latestAnswers.current = next; setAnswers(next);
  };
  const saveAnswerDraft = useCallback((questionId, selectedOption) => {
    const attemptId = activeSession.current;
    const epoch = generation.current;
    const draft = { questionId, selectedOption };
    pendingDraft.current = draft; writePending(attemptId, draft); setDraftStatus('saving');
    const operation = draftQueue.current.catch(() => {}).then(async () => {
      if (epoch !== generation.current || activeQuestion.current?.id !== questionId) return;
      const response = await updateExamAnswer(token, { sessionId: attemptId, questionId, selectedOption });
      if (epoch !== generation.current) return response;
      if (response.autoSubmitted) markSubmitted(response);
      if (pendingDraft.current === draft) {
        pendingDraft.current = null; writePending(attemptId, null); setDraftStatus('saved');
      }
      setQuestionItems((items) => items.map((item) => item.id === questionId
        ? { ...item, answer: selectedOption, answered: selectedOption !== null } : item));
      return response;
    }).catch((error) => {
      if (epoch === generation.current && pendingDraft.current === draft) {
        setDraftStatus(error.status === 0 ? 'pending' : 'error');
        if (error.status === 401 || error.data?.status === 'BLOCKED' || error.data?.code === 'SESSION_ACTIVE') {
          setExamInitError({ message: error.message, status: error.status, data: error.data });
        }
      }
      throw error;
    });
    draftQueue.current = operation;
    return operation;
  }, [token, markSubmitted]);
  const initExam = useCallback(async () => {
    const epoch = generation.current;
    setExamLoading(true); setExamInitError(null);
    try {
      const start = await startExamSession(token);
      if (epoch !== generation.current) return { success: false };
      if (start.waiting) {
        setWaitingForStart({ examStartAt: start.examStartAt, serverTime: start.serverTime, fetchedAtClientMs: Date.now() });
        return { success: true, waiting: true };
      }
      setWaitingForStart(null);
      const id = start.session.id;
      activeSession.current = id; setSessionId(id); setExamMeta(start.exam); syncClocks(start);
      const [info, navigation] = await Promise.all([fetchExamInfo(token), fetchExamNavigation(token, id)]);
      if (epoch !== generation.current) return { success: false };
      setSubjectsMeta(info.subjects.slice().sort((a, b) => a.displayOrder - b.displayOrder));
      const items = navigation.questions || [];
      setQuestionItems(items);
      const restored = {};
      items.forEach((item) => { restored[item.id] = { sel: item.answer ? LETTERS.indexOf(item.answer) : null }; });
      const pending = readPending(id);
      if (pending && items.some((item) => item.id === pending.questionId && !item.locked)) {
        pendingDraft.current = pending;
        restored[pending.questionId] = { sel: pending.selectedOption ? LETTERS.indexOf(pending.selectedOption) : null };
      }
      setAnswers(restored); latestAnswers.current = restored;
      const current = await fetchCurrentQuestion(token);
      if (epoch !== generation.current) return { success: false };
      applyCurrent(current, id);
      if (current.autoSubmitted || current.submitted || start.session.status === 'SUBMITTED') {
        markSubmitted(current);
        return { success: true, examComplete: true, submitted: true };
      }
      return { success: true, examComplete: !!current.examComplete };
    } catch (error) {
      if (epoch !== generation.current) return { success: false };
      if (error.data?.status === 'SUBMITTED' || error.data?.submittedAt) {
        markSubmitted(error.data);
        return { success: true, examComplete: true, submitted: true };
      }
      setExamInitError({ message: error.message || 'Unable to load the examination.', status: error.status ?? null, data: error.data || null });
      return { success: false, error };
    } finally { if (epoch === generation.current) setExamLoading(false); }
  }, [token, applyCurrent, syncClocks, markSubmitted]);
  const syncExam = useCallback(async () => {
    if (!activeSession.current || syncing.current || advancing.current) return;
    syncing.current = true;
    const epoch = generation.current;
    try {
      const draft = pendingDraft.current;
      if (draft && activeQuestion.current?.id === draft.questionId) {
        await saveAnswerDraft(draft.questionId, draft.selectedOption).catch((error) => {
          if (error.status !== 0 && error.status !== 409) throw error;
        });
      }
      const version = stateVersion.current;
      const response = await fetchCurrentQuestion(token);
      if (epoch === generation.current && version === stateVersion.current && !advancing.current) applyCurrent(response, activeSession.current);
    } catch (error) {
      if (epoch === generation.current) {
        if (error.data?.status === 'SUBMITTED' || error.data?.submittedAt) markSubmitted(error.data);
        else if (error.status !== 0) setExamInitError({ message: error.message, status: error.status, data: error.data });
      }
    } finally { syncing.current = false; }
  }, [token, applyCurrent, saveAnswerDraft, markSubmitted]);
  useEffect(() => {
    if (!sessionId || submitted) return undefined;
    const timer = setInterval(syncExam, 30000);
    const onVisible = () => { if (!document.hidden) syncExam(); };
    window.addEventListener('online', syncExam); document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer); window.removeEventListener('online', syncExam);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, submitted, syncExam]);
  const lockAnswerAndAdvance = useCallback(async (timeSpentSeconds) => {
    const question = activeQuestion.current;
    if (!question) throw new Error('No active question to save');
    const epoch = generation.current;
    advancing.current = true;
    stateVersion.current += 1;
    try {
    await draftQueue.current.catch(() => {});
    const selected = latestAnswers.current[question.id]?.sel;
    const selectedOption = selected == null ? null : LETTERS[selected];
    const response = await saveExamAnswer(token, { sessionId: activeSession.current, questionId: question.id, selectedOption, timeSpentSeconds });
    if (epoch !== generation.current) return response;
    setQuestionItems((items) => items.map((item) => item.id === question.id
      ? { ...item, locked: true, visited: true, answer: selectedOption, answered: selectedOption !== null } : item));
    pendingDraft.current = null; writePending(activeSession.current, null); setDraftStatus('idle');
    if (response.nextQuestion) applyCurrent(response, activeSession.current);
    else if (response.autoSubmitted || response.submitted) markSubmitted(response);
    else { syncClocks(response); setExamComplete(true); setCurrentQuestion(null); clocks.current.question = null; }
    return response;
    } finally { advancing.current = false; }
  }, [token, applyCurrent, syncClocks, markSubmitted]);
  const finalizeSubmission = useCallback(async () => {
    await draftQueue.current.catch(() => {});
    const response = await submitExamSession(token, activeSession.current);
    markSubmitted(response); return response;
  }, [token, markSubmitted]);
  const resetExam = useCallback(() => {
    generation.current += 1;
    setSessionId(null); setExamMeta(null); setSubjectsMeta([]); setCurrentQuestion(null);
    setQuestionItems([]); setAnswers({}); latestAnswers.current = {};
    setSectionIdx(0); setQIdx(0); setTimeLeft(QUESTION_SECONDS); setSubmitted(false); setSubmitTime(null);
    setShowSubmitConfirm(false); setBanners([]); setSaveToastOn(false); setExamLoading(true); setExamInitError(null);
    setExamComplete(false); setWaitingForStart(null); setExamTimeLeft(null); setExamEndAt(null);
    clocks.current = { question: null, exam: null }; pendingDraft.current = null;
    activeQuestion.current = null; activeSession.current = null; setDraftStatus('idle'); draftQueue.current = Promise.resolve();
  }, []);
  useLayoutEffect(resetExam, [student?.registrationId, resetExam]);
  const answeredCountFor = (subjectKey) => questionItems.filter((item) =>
    item.subjectKey === subjectKey && (answers[item.id]?.sel ?? null) !== null).length;
  const totalAnsweredCount = () => questionItems.filter((item) => (answers[item.id]?.sel ?? null) !== null).length;
  return <ExamContext.Provider value={{
    sessionId, examMeta, subjectsMeta, currentQuestion, sectionIdx, qIdx, answers, timeLeft, submitted, submitTime,
    showSubmitConfirm, setShowSubmitConfirm, banners, setBanners, saveToastOn, setSaveToastOn, getAns, setAns, saveAnswerDraft,
    questionItems, answeredCountFor, totalAnsweredCount, resetExam, draftStatus, examLoading, examInitError,
    setExamInitError, examComplete, initExam, syncExam, lockAnswerAndAdvance, finalizeSubmission,
    waitingForStart, examTimeLeft, examEndAt,
  }}>{children}</ExamContext.Provider>;
};
