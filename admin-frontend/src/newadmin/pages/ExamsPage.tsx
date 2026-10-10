import { useEffect, useState } from 'react';
import { Plus, FileText, Clock, Users, Pencil, Trash2, Power, BookOpen, Check, X, Timer, CalendarClock, Trophy } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Field, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { examStatusMeta, timingStatusMeta, formatDate, formatIst, istToUtcIso, utcIsoToIstParts } from '../lib/format';
import type { Exam } from '../lib/types';
// Exam/class CRUD reused verbatim from the existing admin dashboard's
// already-hardened adapter layer — not re-derived against raw API rows.
import { fetchExamsWithTree, addExam, updateExamDetails, setExamStatus, setResultsPublished, removeExam, clearExamTiming, addClass, removeClass } from '../../services/questionBank';
import { listSessions } from '../../services/adminApi';

// examStartDate/examStartTime are the IST wall-clock date/time inputs
// (converted to a UTC instant via istToUtcIso only on save) — kept as
// separate strings rather than a single ISO value so the two native
// <input type="date">/<input type="time"> controls can bind directly.
// durationMinutes is a string here purely for controlled-input purposes;
// parsed to a number on save.
type EditState = {
  id?: string;
  name: string;
  secondsPerQuestion: number;
  examDate: string;
  examStartDate: string;
  examStartTime: string;
  durationMinutes: string;
};

export function ExamsPage({ onManageClass }: { onManageClass: (classId: string, className: string, examName: string) => void }) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Exam | null>(null);
  const [addingClassFor, setAddingClassFor] = useState<string | null>(null);
  const [newClassName, setNewClassName] = useState('');
  const [confirmDeleteClass, setConfirmDeleteClass] = useState<{ examId: string; classId: string; className: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const tree = await fetchExamsWithTree();
      const withCounts = await Promise.all(
        tree.map(async (e: any) => {
          const totalQuestions = e.classes.reduce(
            (sum: number, c: any) => sum + c.subjects.reduce((s: number, sub: any) => s + sub.questions.length, 0),
            0
          );
          let studentsStarted = 0;
          try {
            const res = await listSessions({ examId: e.id, limit: 1 });
            studentsStarted = res.total || 0;
          } catch {
            studentsStarted = 0;
          }
          return {
            ...e,
            totalQuestions,
            studentsStarted,
            estDurationMinutes: totalQuestions > 0 ? Math.round((totalQuestions * e.secondsPerQuestion) / 60) : null,
          } as Exam;
        })
      );
      setExams(withCounts);
    } catch (err) {
      console.error('[ExamsPage] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setFormError('');
    setEditing({ name: '', secondsPerQuestion: 60, examDate: '', examStartDate: '', examStartTime: '', durationMinutes: '' });
    setShowForm(true);
  };

  const openEdit = (exam: Exam) => {
    setFormError('');
    const startParts = exam.examStartAt ? utcIsoToIstParts(exam.examStartAt) : null;
    setEditing({
      id: exam.id,
      name: exam.name,
      secondsPerQuestion: exam.secondsPerQuestion,
      examDate: exam.examDate || '',
      examStartDate: startParts?.date || '',
      examStartTime: startParts?.time || '',
      durationMinutes: exam.durationMinutes != null ? String(exam.durationMinutes) : '',
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!editing || !editing.name.trim()) return;

    // Exam Timing's date/time inputs are a pair — both set (a real
    // schedule) or both blank (leave whatever's already saved
    // untouched). Clearing an existing schedule entirely is the
    // dedicated "Clear Timing" action below, not this form.
    if (!!editing.examStartDate !== !!editing.examStartTime) {
      setFormError('Provide both a start date and start time, or leave both blank.');
      return;
    }
    if (editing.durationMinutes && (!Number.isFinite(Number(editing.durationMinutes)) || Number(editing.durationMinutes) <= 0)) {
      setFormError('Duration must be a positive number of minutes.');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editing.id) {
        await updateExamDetails(editing.id, {
          name: editing.name.trim(),
          secondsPerQuestion: editing.secondsPerQuestion,
          examDate: editing.examDate || null,
          examStartAt: editing.examStartDate && editing.examStartTime ? istToUtcIso(editing.examStartDate, editing.examStartTime) : undefined,
          durationMinutes: editing.durationMinutes ? Number(editing.durationMinutes) : undefined,
        });
      } else {
        await addExam(editing.name.trim());
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save exam.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearTiming = async (exam: Exam) => {
    try {
      await clearExamTiming(exam.id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to clear exam timing.');
    }
  };

  const toggleActive = async (exam: Exam) => {
    try {
      await setExamStatus(exam.id, exam.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to update exam status.');
    }
  };

  // Students only ever see their score once results are published here.
  const toggleResultsPublished = async (exam: Exam) => {
    const publish = !exam.resultsPublished;
    if (publish && !window.confirm(`Publish results for "${exam.name}"? Every student who submitted this exam will be able to see their score.`)) return;
    try {
      await setResultsPublished(exam.id, publish);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to update result publication.');
    }
  };

  const handleAddClass = async (examId: string, existingCount: number) => {
    const name = newClassName.trim();
    if (!name) return;
    try {
      await addClass(examId, name, existingCount);
      setNewClassName('');
      setAddingClassFor(null);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to add class.');
    }
  };

  const handleDeleteClass = async () => {
    if (!confirmDeleteClass) return;
    try {
      await removeClass(confirmDeleteClass.classId);
      setConfirmDeleteClass(null);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to delete class.');
    }
  };

  const handleDeleteExam = async () => {
    if (!confirmDelete) return;
    try {
      await removeExam(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to delete exam.');
    }
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink-900 tracking-tight">Exams</h1>
          <p className="text-sm text-ink-500 mt-1">Create and manage exams, classes, and configuration</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={openNew}>New Exam</Button>
      </div>

      {loading ? (
        <LoadingState label="Loading exams…" />
      ) : exams.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText size={22} />}
            title="No exams yet"
            description="Create your first exam to get started."
            action={<Button icon={<Plus size={16} />} onClick={openNew}>New Exam</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {exams.map((exam) => (
            <Card key={exam.id} hover className="flex flex-col">
              <CardHeader
                title={exam.name}
                subtitle={exam.examDate ? `${exam.examCode} · ${formatDate(exam.examDate)}` : exam.examCode}
                icon={<FileText size={18} />}
                action={
                  <div className="flex flex-col items-end gap-1.5">
                    <Badge tone={examStatusMeta[exam.status].tone} dot>{examStatusMeta[exam.status].label}</Badge>
                    {exam.timingStatus !== 'UNSCHEDULED' && (
                      <Badge tone={timingStatusMeta[exam.timingStatus].tone}>{timingStatusMeta[exam.timingStatus].label}</Badge>
                    )}
                  </div>
                }
              />
              <CardBody className="flex-1 flex flex-col">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  <MiniStat icon={<Clock size={14} />} label="Sec/Q" value={exam.secondsPerQuestion} />
                  <MiniStat icon={<Clock size={14} />} label="Duration" value={exam.durationMinutes != null ? `${exam.durationMinutes}m` : exam.estDurationMinutes != null ? `~${exam.estDurationMinutes}m` : '—'} />
                  <MiniStat icon={<Users size={14} />} label="Students Started" value={exam.studentsStarted} />
                  <MiniStat icon={<BookOpen size={14} />} label="Classes" value={exam.classes.length} />
                </div>

                {/* Exam Timing summary — only shown once the admin has actually
                    scheduled this exam (Edit Exam > Exam Timing). Mirrors
                    exactly what's enforced server-side: student login/system
                    check is always open, but the exam itself only goes Live
                    at exam.examStartAt and ends at exam.examEndAt. */}
                {exam.timingStatus !== 'UNSCHEDULED' && (
                  <div className="rounded-lg bg-brand-50 border border-brand-100 px-3 py-2.5 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-medium text-brand-800">
                      <CalendarClock size={14} /> Starts {formatIst(exam.examStartAt)}
                    </span>
                    {exam.examEndAt && (
                      <span className="inline-flex items-center gap-1.5 text-brand-700">
                        <Timer size={14} /> Ends {formatIst(exam.examEndAt)}
                      </span>
                    )}
                    <button
                      onClick={() => handleClearTiming(exam)}
                      className="ml-auto text-brand-600 hover:text-danger-600 font-medium underline-offset-2 hover:underline"
                      title="Unschedule this exam"
                    >
                      Clear Timing
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {exam.classes.map((c) => {
                    const questionCount = c.subjects.reduce((sum, s) => sum + s.questions.length, 0);
                    return (
                      <div key={c.id} className="group relative inline-flex">
                        <button
                          onClick={() => onManageClass(c.id, c.name, exam.name)}
                          className="inline-flex items-center gap-1.5 rounded-l-lg bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-600 hover:bg-brand-50 hover:text-brand-700 transition-colors"
                          title={`Manage ${c.name}`}
                        >
                          {c.name}
                          <span className="rounded-full bg-ink-200 px-1.5 py-0.5 text-[10px] font-bold text-ink-500">
                            {c.subjects.length} · {questionCount}
                          </span>
                        </button>
                        <button
                          onClick={() => setConfirmDeleteClass({ examId: exam.id, classId: c.id, className: c.name })}
                          className="inline-flex items-center justify-center rounded-r-lg border border-l-0 border-ink-200 px-1.5 text-ink-400 hover:bg-danger-50 hover:text-danger-600 hover:border-danger-200 transition-colors"
                          title={`Delete ${c.name}`}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
                  {addingClassFor === exam.id ? (
                    <div className="inline-flex items-center gap-1.5">
                      <TextInput value={newClassName} onChange={setNewClassName} placeholder="Class name" className="!w-32 !py-1 !text-xs" />
                      <Button size="sm" icon={<Check size={12} />} onClick={() => handleAddClass(exam.id, exam.classes.length)}>Add</Button>
                      <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => { setAddingClassFor(null); setNewClassName(''); }} />
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingClassFor(exam.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-dashed border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
                    >
                      <Plus size={14} /> Class
                    </button>
                  )}
                </div>

                <div className="mt-auto flex items-center gap-2 pt-3 border-t border-ink-100">
                  <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => openEdit(exam)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Trophy size={14} />}
                    onClick={() => toggleResultsPublished(exam)}
                    title={exam.resultsPublished ? 'Students can see their results — click to hide them' : 'Results are hidden from students — click to publish'}
                  >
                    {exam.resultsPublished ? 'Unpublish Results' : 'Publish Results'}
                  </Button>
                  <Button size="sm" variant={exam.status === 'ACTIVE' ? 'danger' : 'success'} icon={<Power size={14} />} onClick={() => toggleActive(exam)} className="ml-auto">
                    {exam.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </Button>
                  <button onClick={() => setConfirmDelete(exam)} className="rounded-lg p-2 text-ink-400 hover:bg-danger-50 hover:text-danger-600 transition-colors" title="Delete">
                    <Trash2 size={16} />
                  </button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing?.id ? 'Edit Exam' : 'New Exam'}
        subtitle="Configure exam details"
        footer={<><Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></>}
      >
        {editing && (
          <div className="space-y-4">
            {formError && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{formError}</div>}
            <Field label="Exam Name" required hint="e.g. GTST+ Scholarship Exam">
              <TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} placeholder="GTST+ Scholarship Exam" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Exam Date">
                <TextInput type="date" value={editing.examDate} onChange={(v) => setEditing({ ...editing, examDate: v })} />
              </Field>
              <Field label="Seconds per Question" required>
                <TextInput type="number" value={String(editing.secondsPerQuestion)} onChange={(v) => setEditing({ ...editing, secondsPerQuestion: Number(v) || 60 })} />
              </Field>
            </div>

            {editing.id ? (
              <div className="rounded-lg border border-ink-200 p-3.5 space-y-3">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                  <Timer size={15} /> Exam Timing
                </div>
                <p className="text-xs text-ink-400">
                  Students can log in, run the system check and accept the rules at any time — the exam itself only
                  goes Live at the start time below, and ends automatically when the duration runs out. All times are IST.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Start Date (IST)">
                    <TextInput type="date" value={editing.examStartDate} onChange={(v) => setEditing({ ...editing, examStartDate: v })} />
                  </Field>
                  <Field label="Start Time (IST)">
                    <TextInput type="time" value={editing.examStartTime} onChange={(v) => setEditing({ ...editing, examStartTime: v })} />
                  </Field>
                </div>
                <Field label="Duration (minutes)" hint="Total time students get once the exam goes Live">
                  <TextInput type="number" value={editing.durationMinutes} onChange={(v) => setEditing({ ...editing, durationMinutes: v })} placeholder="e.g. 60" />
                </Field>
              </div>
            ) : (
              <p className="text-xs text-ink-400">Exam Timing can be set once this exam has been saved.</p>
            )}
            <p className="text-xs text-ink-400">Classes can be added and removed directly on the exam card after saving.</p>
          </div>
        )}
      </Modal>

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete Exam"
        size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="danger" onClick={handleDeleteExam}>Delete</Button></>}
      >
        <p className="text-sm text-ink-600">
          Are you sure you want to delete <span className="font-semibold text-ink-900">{confirmDelete?.name}</span>?
          This will also remove all associated classes, subjects and questions. This action cannot be undone.
          {confirmDelete?.status === 'ACTIVE' && <span className="block mt-2 text-warning-600">This exam is currently ACTIVE — deactivate it first.</span>}
        </p>
      </Modal>

      <Modal
        open={!!confirmDeleteClass}
        onClose={() => setConfirmDeleteClass(null)}
        title="Delete Class"
        size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDeleteClass(null)}>Cancel</Button><Button variant="danger" onClick={handleDeleteClass}>Delete</Button></>}
      >
        <p className="text-sm text-ink-600">Delete this class and all its subjects and questions? This action cannot be undone.</p>
        {confirmDeleteClass && <p className="text-sm font-medium text-ink-900 mt-2">{confirmDeleteClass.className}</p>}
      </Modal>
    </PageContainer>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50 px-2.5 py-2">
      <div className="flex items-center gap-1 text-ink-400">{icon}<span className="text-[10px] uppercase tracking-wide font-semibold">{label}</span></div>
      <p className="text-sm font-bold text-ink-900 mt-0.5 tabular-nums">{value}</p>
    </div>
  );
}
