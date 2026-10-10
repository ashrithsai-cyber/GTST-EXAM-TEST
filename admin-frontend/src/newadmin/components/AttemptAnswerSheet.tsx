import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { Select } from './ui/Form';
import { formatDateTime } from '../lib/format';
import { getSessionAnswerSheet } from '../../services/adminApi';

type Letter = 'A' | 'B' | 'C' | 'D';
type SheetQuestion = {
  sequenceNumber: number;
  questionId: string;
  subjectName: string | null;
  questionText: string;
  passage: string | null;
  options: Record<Letter, string>;
  marks: number;
  selectedOption: Letter | null;
  selectedOptionText: string | null;
  correctOption: Letter;
  correctOptionText: string;
  answered: boolean;
  isCorrect: boolean | null;
  reached: boolean;
  timeSpentSeconds: number | null;
  answeredAt: string | null;
};
type Sheet = {
  source: 'attempt_snapshot' | 'legacy_answers';
  attempt: {
    id: string; candidateId: string; examId: string; examName: string | null; studentName: string | null;
    registrationId: string | null; studentClass: string | null; status: string; startedAt: string | null;
    submittedAt: string | null; totalScore: number | null; maxScore: number | null; proctoringWarningCount: number;
  };
  summary: { totalQuestions: number; answered: number; unanswered: number; correct: number; incorrect: number };
  questions: SheetQuestion[];
};

const LETTERS: Letter[] = ['A', 'B', 'C', 'D'];
const FILTERS = [
  { value: 'all', label: 'All Questions' },
  { value: 'correct', label: 'Correct' },
  { value: 'incorrect', label: 'Incorrect' },
  { value: 'unanswered', label: 'Unanswered' },
];

// Read-only view of one attempt: Question → Options → the student's
// selection → correct answer → result, for every question in the attempt.
export function AttemptAnswerSheet({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    setSheet(null); setError(''); setFilter('all');
    getSessionAnswerSheet(sessionId)
      .then((data: Sheet) => { if (!cancelled) setSheet(data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load this attempt.'); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const questions = useMemo(() => (sheet?.questions || []).filter((q) => {
    if (filter === 'correct') return q.isCorrect === true;
    if (filter === 'incorrect') return q.isCorrect === false;
    if (filter === 'unanswered') return !q.answered;
    return true;
  }), [sheet, filter]);

  const attempt = sheet?.attempt;
  return (
    <Modal
      open={!!sessionId}
      onClose={onClose}
      size="xl"
      title={attempt ? `Exam Attempt — ${attempt.studentName || 'Unknown student'}` : 'Exam Attempt'}
      subtitle={attempt ? [attempt.registrationId, attempt.examName, attempt.studentClass && `Class ${attempt.studentClass}`].filter(Boolean).join(' · ') : ''}
    >
      {error ? (
        <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700" role="alert">{error}</div>
      ) : !sheet ? (
        <p className="py-10 text-center text-sm text-ink-400">Loading answer sheet…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <Tile label="Score" value={attempt?.maxScore ? `${attempt.totalScore ?? 0} / ${attempt.maxScore}` : '—'} />
            <Tile label="Answered" value={`${sheet.summary.answered} / ${sheet.summary.totalQuestions}`} />
            <Tile label="Correct" value={sheet.summary.correct} tone="text-success-600" />
            <Tile label="Incorrect" value={sheet.summary.incorrect} tone="text-danger-600" />
            <Tile label="Unanswered" value={sheet.summary.unanswered} tone="text-ink-500" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
            <span>
              Status <Badge tone={attempt?.status === 'SUBMITTED' ? 'success' : attempt?.status === 'BLOCKED' ? 'danger' : 'warning'}>{attempt?.status}</Badge>
              {' '}· Started {formatDateTime(attempt?.startedAt ?? null)} · Submitted {formatDateTime(attempt?.submittedAt ?? null)}
            </span>
            <Select value={filter} onChange={setFilter} options={FILTERS} />
          </div>
          {sheet.source === 'legacy_answers' && (
            <p className="rounded-lg bg-warning-50 border border-warning-200 px-3 py-2 text-xs text-warning-700">
              This attempt was taken before per-attempt question snapshots existed, so only the questions it saved an answer for are shown, using the current question bank.
            </p>
          )}

          {questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-400">No questions match this filter.</p>
          ) : questions.map((q) => (
            <article key={q.questionId} className="rounded-xl border border-ink-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Question {q.sequenceNumber}{q.subjectName ? ` · ${q.subjectName}` : ''} · {q.marks} mark{q.marks === 1 ? '' : 's'}
                </p>
                <ResultBadge q={q} />
              </div>
              {q.passage && <p className="mb-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600 whitespace-pre-wrap">{q.passage}</p>}
              <p className="text-sm font-semibold text-ink-900 mb-3 whitespace-pre-wrap">{q.questionText}</p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {LETTERS.map((letter) => {
                  const isSelected = q.selectedOption === letter;
                  const isAnswerKey = q.correctOption === letter;
                  const style = isAnswerKey
                    ? 'border-success-300 bg-success-50'
                    : isSelected ? 'border-danger-300 bg-danger-50' : 'border-ink-200';
                  return (
                    <li key={letter} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${style}`}>
                      <span className="font-bold text-ink-700">{letter}.</span>
                      <span className="flex-1 text-ink-800">{q.options[letter]}</span>
                      {isSelected && <Badge tone={isAnswerKey ? 'success' : 'danger'}>Student</Badge>}
                      {isAnswerKey && <Badge tone="success">Correct</Badge>}
                    </li>
                  );
                })}
              </ul>
              <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-ink-500 sm:grid-cols-3">
                <div><dt className="inline font-semibold">Student's answer: </dt><dd className="inline">{q.selectedOption ? `${q.selectedOption}. ${q.selectedOptionText}` : 'Not answered'}</dd></div>
                <div><dt className="inline font-semibold">Correct answer: </dt><dd className="inline">{q.correctOption}. {q.correctOptionText}</dd></div>
                <div><dt className="inline font-semibold">Saved: </dt><dd className="inline">{q.answeredAt ? formatDateTime(q.answeredAt) : q.reached ? '—' : 'Not reached'}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}

function ResultBadge({ q }: { q: SheetQuestion }) {
  if (q.isCorrect === true) return <Badge tone="success"><CheckCircle2 size={12} /> Correct</Badge>;
  if (q.isCorrect === false) return <Badge tone="danger"><XCircle size={12} /> Incorrect</Badge>;
  return <Badge tone="neutral"><MinusCircle size={12} /> {q.reached ? 'Unanswered' : 'Not reached'}</Badge>;
}

function Tile({ label, value, tone = 'text-ink-900' }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg bg-ink-50 px-3 py-2.5">
      <p className="text-[11px] text-ink-400 uppercase tracking-wide font-semibold">{label}</p>
      <p className={`text-sm font-bold mt-1 tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}
