import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, HelpCircle, Pencil, Trash2, Check, X, ChevronLeft, Download, Upload, AlertCircle } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Field, TextInput, TextArea, Select, SearchInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { questionStatusMeta } from '../lib/format';
import type { Question } from '../lib/types';
import {
  fetchSubjects, fetchQuestions, addQuestion, editQuestion, removeQuestion,
  nextQuestionNumber, addSubject, removeSubject, downloadQuestionTemplate, uploadQuestionsExcel,
} from '../../services/questionBank';

type EditState = Omit<Question, 'id' | 'questionNumber'> & { id?: string; questionNumber?: number };

const emptyQuestion: EditState = {
  question: '', passage: '', optionA: '', optionB: '', optionC: '', optionD: '',
  correctAnswer: 'A', marks: 1, status: 'ACTIVE',
};

type ImportRowResult = { row: number; status: 'OK' | 'ERROR'; questionText: string; questionNumber?: number; errors?: string[] };
type ImportResult = { summary: { totalRows: number; imported: number; failed: number }; results: ImportRowResult[] };

type Props = { classId: string; className: string; examName: string; onBack: () => void };

export function QuestionsPage({ classId, className, examName, onBack }: Props) {
  const [subjects, setSubjects] = useState<any[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Question | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [addingSubject, setAddingSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState('');
  const [confirmDeleteSubject, setConfirmDeleteSubject] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadSubjects = async () => {
    setLoading(true);
    try {
      const subs = await fetchSubjects(classId);
      setSubjects(subs);
      setSelectedSubjectId((prev) => (subs.some((s: any) => s.id === prev) ? prev : subs[0]?.id || ''));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSubjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  const loadQuestions = async (subjectId: string) => {
    if (!subjectId) { setQuestions([]); return; }
    const qs = await fetchQuestions(subjectId);
    setQuestions(qs);
  };

  useEffect(() => {
    loadQuestions(selectedSubjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubjectId]);

  const filtered = useMemo(() => {
    if (!search) return questions;
    const q = search.toLowerCase();
    return questions.filter((qq) => qq.question.toLowerCase().includes(q));
  }, [questions, search]);

  const openNew = () => {
    setFormError('');
    setEditing({ ...emptyQuestion });
    setShowForm(true);
  };

  const save = async () => {
    if (!editing || !editing.question.trim() || !selectedSubjectId) return;
    setSaving(true);
    setFormError('');
    try {
      if (editing.id) {
        await editQuestion(editing.id, editing);
      } else {
        await addQuestion(selectedSubjectId, editing, nextQuestionNumber(questions));
      }
      setShowForm(false);
      setEditing(null);
      await loadQuestions(selectedSubjectId);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2500);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save question.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await removeQuestion(confirmDelete.id);
      setConfirmDelete(null);
      await loadQuestions(selectedSubjectId);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to delete question.');
    }
  };

  const handleAddSubject = async () => {
    const name = newSubjectName.trim();
    if (!name) return;
    await addSubject(classId, name, subjects.length);
    setNewSubjectName('');
    setAddingSubject(false);
    await loadSubjects();
  };

  const handleDeleteSubject = async () => {
    if (!confirmDeleteSubject) return;
    await removeSubject(confirmDeleteSubject);
    setConfirmDeleteSubject(null);
    await loadSubjects();
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadQuestionTemplate();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to download the template.');
    }
  };

  const handleFileChosen = async (file: File) => {
    if (!selectedSubjectId) return;
    setUploading(true);
    setImportError('');
    try {
      const result = await uploadQuestionsExcel(selectedSubjectId, file);
      setImportResult(result);
      await loadQuestions(selectedSubjectId);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unable to import questions.');
      setImportResult(null);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (loading) {
    return <PageContainer><LoadingState label="Loading questions…" /></PageContainer>;
  }

  return (
    <PageContainer>
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-brand-600 transition-colors mb-3">
        <ChevronLeft size={16} /> Back to Exams
      </button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink-900 tracking-tight">Questions</h1>
          <p className="text-sm text-ink-500 mt-1">{examName} · {className}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Download size={16} />} onClick={handleDownloadTemplate}>Download Template</Button>
          <Button variant="secondary" icon={<Upload size={16} />} disabled={subjects.length === 0 || uploading} onClick={() => fileInputRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Upload Excel'}
          </Button>
          <Button icon={<Plus size={16} />} onClick={openNew} disabled={subjects.length === 0}>Add Question</Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileChosen(f); }}
        />
      </div>

      {importError && (
        <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700 mb-4 flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0" /> {importError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {subjects.map((s) => {
          const active = s.id === selectedSubjectId;
          return (
            <div key={s.id} className="group relative inline-flex">
              <button
                onClick={() => setSelectedSubjectId(s.id)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-brand-600 text-white shadow-sm' : 'bg-surface text-ink-600 ring-1 ring-ink-200 hover:bg-ink-100'}`}
              >
                {s.name}
              </button>
              <button
                onClick={() => setConfirmDeleteSubject(s.id)}
                className="ml-0.5 inline-flex items-center justify-center rounded-r-lg border border-l-0 border-ink-200 px-1.5 text-ink-400 hover:bg-danger-50 hover:text-danger-600 hover:border-danger-200 transition-colors"
                title={`Delete ${s.name}`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        {addingSubject ? (
          <div className="inline-flex items-center gap-1.5">
            <TextInput value={newSubjectName} onChange={setNewSubjectName} placeholder="Subject name" className="!w-36 !py-1.5" />
            <Button size="sm" icon={<Check size={14} />} onClick={handleAddSubject}>Add</Button>
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => { setAddingSubject(false); setNewSubjectName(''); }} />
          </div>
        ) : (
          <button onClick={() => setAddingSubject(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 transition-colors">
            <Plus size={16} /> Add Subject
          </button>
        )}
      </div>

      {subjects.length === 0 ? (
        <Card><EmptyState icon={<HelpCircle size={22} />} title="No subjects yet" description="Add a subject to start creating questions." action={<Button icon={<Plus size={16} />} onClick={() => setAddingSubject(true)}>Add Subject</Button>} /></Card>
      ) : (
        <Card className="mb-4">
          <CardBody>
            <Field label="Search">
              <SearchInput value={search} onChange={setSearch} placeholder="Search questions…" />
            </Field>
          </CardBody>
        </Card>
      )}

      {subjects.length === 0 ? null : filtered.length === 0 ? (
        <Card><EmptyState icon={<HelpCircle size={22} />} title="No questions found" description="Add a question, upload an Excel file, or adjust your search." action={<Button icon={<Plus size={16} />} onClick={openNew}>Add Question</Button>} /></Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((q) => (
            <Card key={q.id} hover>
              <div className="flex items-start gap-4 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-500 text-sm font-semibold">{q.questionNumber}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {q.passage && <p className="text-xs text-ink-400 mb-1 line-clamp-2">{q.passage}</p>}
                      <p className="text-sm font-medium text-ink-900">{q.question}</p>
                    </div>
                    <Badge tone={questionStatusMeta[q.status].tone}>{questionStatusMeta[q.status].label}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(['A', 'B', 'C', 'D'] as const).map((opt) => {
                      const val = (q as any)[`option${opt}`];
                      const isCorrect = q.correctAnswer === opt;
                      return (
                        <div key={opt} className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${isCorrect ? 'bg-success-50 text-success-700 ring-1 ring-success-200' : 'bg-ink-50 text-ink-600'}`}>
                          <span className="font-semibold">{opt}.</span>
                          <span className="truncate">{val || '—'}</span>
                          {isCorrect && <Check size={12} className="ml-auto shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    <span className="text-xs text-ink-400">Marks: <span className="font-semibold text-ink-700">{q.marks}</span></span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => { setFormError(''); setEditing({ ...q }); setShowForm(true); }}>Edit</Button>
                      <button onClick={() => setConfirmDelete(q)} className="rounded-lg p-1.5 text-ink-400 hover:bg-danger-50 hover:text-danger-600 transition-colors"><Trash2 size={16} /></button>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing?.id ? 'Edit Question' : 'Add Question'}
        subtitle="Correct answer is stored securely and never exposed to students"
        size="lg"
        footer={<><Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Question'}</Button></>}
      >
        {editing && (
          <div className="space-y-4">
            {formError && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{formError}</div>}
            <Field label="Passage (optional)" hint="Shown above the question, e.g. for reading-comprehension items">
              <TextArea value={editing.passage} onChange={(v) => setEditing({ ...editing, passage: v })} placeholder="Optional reading passage…" rows={2} />
            </Field>
            <Field label="Question Text" required>
              <TextArea value={editing.question} onChange={(v) => setEditing({ ...editing, question: v })} placeholder="Enter the question…" rows={2} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Option A" required><TextInput value={editing.optionA} onChange={(v) => setEditing({ ...editing, optionA: v })} placeholder="Option A" /></Field>
              <Field label="Option B" required><TextInput value={editing.optionB} onChange={(v) => setEditing({ ...editing, optionB: v })} placeholder="Option B" /></Field>
              <Field label="Option C" required><TextInput value={editing.optionC} onChange={(v) => setEditing({ ...editing, optionC: v })} placeholder="Option C" /></Field>
              <Field label="Option D" required><TextInput value={editing.optionD} onChange={(v) => setEditing({ ...editing, optionD: v })} placeholder="Option D" /></Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Correct Answer" required>
                <Select value={editing.correctAnswer} onChange={(v) => setEditing({ ...editing, correctAnswer: v as Question['correctAnswer'] })} options={[
                  { value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }, { value: 'C', label: 'Option C' }, { value: 'D', label: 'Option D' },
                ]} />
              </Field>
              <Field label="Marks" required>
                <TextInput type="number" value={String(editing.marks)} onChange={(v) => setEditing({ ...editing, marks: Number(v) || 1 })} />
              </Field>
            </div>
            <Field label="Status" hint="Organizational only — does not affect what students see during the exam.">
              <Select value={editing.status} onChange={(v) => setEditing({ ...editing, status: v as Question['status'] })} options={[{ value: 'ACTIVE', label: 'Published' }, { value: 'INACTIVE', label: 'Draft' }]} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete Question"
        size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="danger" onClick={handleDelete}>Delete</Button></>}
      >
        <p className="text-sm text-ink-600">Delete this question? This action cannot be undone.</p>
        {confirmDelete && <p className="text-sm font-medium text-ink-900 mt-2">{confirmDelete.question}</p>}
      </Modal>

      <Modal
        open={!!confirmDeleteSubject}
        onClose={() => setConfirmDeleteSubject(null)}
        title="Delete Subject"
        size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDeleteSubject(null)}>Cancel</Button><Button variant="danger" onClick={handleDeleteSubject}>Delete</Button></>}
      >
        <p className="text-sm text-ink-600">Delete this subject and all its questions? This action cannot be undone.</p>
        {confirmDeleteSubject && <p className="text-sm font-medium text-ink-900 mt-2">{subjects.find((s) => s.id === confirmDeleteSubject)?.name}</p>}
      </Modal>

      <Modal
        open={!!importResult}
        onClose={() => setImportResult(null)}
        title="Excel Import Results"
        subtitle={importResult ? `${importResult.summary.imported} of ${importResult.summary.totalRows} imported, ${importResult.summary.failed} failed` : undefined}
        size="lg"
        footer={<Button onClick={() => setImportResult(null)}>Close</Button>}
      >
        {importResult && (
          <div className="space-y-2">
            {importResult.results.map((r) => (
              <div key={r.row} className={`rounded-lg px-3 py-2 text-sm ${r.status === 'OK' ? 'bg-success-50 text-success-700 ring-1 ring-success-200' : 'bg-danger-50 text-danger-700 ring-1 ring-danger-200'}`}>
                <div className="flex items-center gap-2 font-medium">
                  {r.status === 'OK' ? <Check size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
                  <span>Row {r.row}</span>
                  {r.status === 'OK' && <span className="text-xs font-normal opacity-80">— Q{r.questionNumber}</span>}
                </div>
                <p className="mt-1 truncate opacity-90">{r.questionText || '(empty)'}</p>
                {r.errors && (
                  <ul className="mt-1 list-disc list-inside text-xs opacity-90">
                    {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {savedToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-surface-raised text-ink-900 ring-1 ring-ink-300 px-4 py-3 shadow-pop animate-slide-in-right">
          <Check size={16} className="text-success-600" />
          <span className="text-sm font-medium">Question saved successfully</span>
        </div>
      )}
    </PageContainer>
  );
}
