import { useEffect, useRef, useState } from 'react';
import { Camera, ImageOff, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput, Select } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { Modal } from '../components/ui/Modal';
import { formatDateTime } from '../lib/format';
// GET /api/admin/system-check-screenshots (admin.controller.js's sibling,
// screenshot.controller.js's listCheckInScreenshots) — every automatic
// System Check check-in snapshot, newest first, joined with the
// candidate's name/class and the exam's name. The bucket behind these is
// private, so each thumbnail/full image is fetched as an authenticated
// blob (fetchCheckInScreenshotBlob), never a plain <img src> URL.
import { listCheckInScreenshots, fetchCheckInScreenshotBlob, listExams } from '../../services/adminApi';

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 400;

export function CapturedImagesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [examFilter, setExamFilter] = useState('all');
  const [exams, setExams] = useState<any[]>([]);

  const [selected, setSelected] = useState<any | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());
  const urlsRef = useRef<Record<string, string>>({});

  // Debounce free-text search so every keystroke doesn't hit the server —
  // registration ID / hall ticket search must reach across the whole
  // dataset (not just the current page), unlike this dashboard's simpler
  // list pages, since "view the images for a student" has to work
  // regardless of which page they'd otherwise land on.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, examFilter]);

  useEffect(() => {
    listExams()
      .then((res: any) => setExams(res.exams || []))
      .catch((err: unknown) => console.error('[CapturedImagesPage] Unable to load exams:', err));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    const params: Record<string, string | number> = { page, limit: PAGE_SIZE };
    if (debouncedSearch) params.search = debouncedSearch;
    if (examFilter !== 'all') params.examId = examFilter;

    listCheckInScreenshots(params)
      .then((res: any) => {
        if (cancelled) return;
        setRows(res.screenshots || []);
        setTotal(res.total || 0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.error('[CapturedImagesPage] load failed:', err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Unable to load captured images.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, debouncedSearch, examFilter]);

  // Loads the actual image bytes for the current page's rows. The
  // previous page's object URLs are revoked first — the gallery replaces
  // its whole contents on every page/filter change, so nothing carries
  // over that would otherwise leak.
  useEffect(() => {
    let cancelled = false;
    Object.values(urlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = {};
    setImageUrls({});
    setImageErrors(new Set());

    rows.forEach((row) => {
      fetchCheckInScreenshotBlob(row.id)
        .then((blob: Blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urlsRef.current[row.id] = url;
          setImageUrls((prev) => ({ ...prev, [row.id]: url }));
        })
        .catch((err: unknown) => {
          console.error(`[CapturedImagesPage] Unable to load image ${row.id}:`, err);
          if (!cancelled) setImageErrors((prev) => new Set(prev).add(row.id));
        });
    });

    return () => {
      cancelled = true;
    };
  }, [rows]);

  // Final cleanup on unmount only.
  useEffect(() => {
    return () => {
      Object.values(urlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const linkedOnPage = rows.filter((r) => r.session_id).length;

  const examOptions = [
    { value: 'all', label: 'All Exams' },
    ...exams.map((e: any) => ({ value: e.id, label: e.exam_name })),
  ];

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Captured Images</h1>
        <p className="text-sm text-ink-500 mt-1">
          Automatic System Check check-in snapshots — one per student per exam attempt, captured the moment all required checks passed and linked by registration ID, exam and timestamp.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <CountTile label="Total Captured" value={total} tone="neutral" />
        <CountTile label="On This Page" value={rows.length} tone="brand" />
        <CountTile label="Linked to Session (page)" value={linkedOnPage} tone="success" />
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1 min-w-0">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by registration ID or hall ticket…" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={examFilter} onChange={setExamFilter} options={examOptions} />
          </div>
        </CardBody>
      </Card>

      {loadError && (
        <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700 mb-4">{loadError}</div>
      )}

      {loading ? (
        <LoadingState label="Loading captured images…" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Camera size={22} />}
            title="No captured images found"
            description="Adjust your filters, or no System Check screenshots have been captured yet."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => setSelected(row)}
                className="group text-left rounded-xl border border-ink-200 bg-surface overflow-hidden shadow-card hover:shadow-card-hover transition-shadow"
              >
                <div className="aspect-[4/3] bg-ink-100 flex items-center justify-center overflow-hidden">
                  {imageErrors.has(row.id) ? (
                    <ImageOff size={22} className="text-ink-300" />
                  ) : imageUrls[row.id] ? (
                    <img
                      src={imageUrls[row.id]}
                      alt={`Check-in snapshot for ${row.registration_id}`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="h-5 w-5 border-2 border-ink-200 border-t-brand-500 rounded-full animate-spin" />
                  )}
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-sm font-medium text-ink-900 truncate">{row.exam_candidates?.full_name || 'Unknown'}</p>
                  <p className="text-xs text-ink-400 truncate">{row.registration_id}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-2">
                    <span className="text-xs text-ink-500 truncate">{row.exams?.exam_name || '—'}</span>
                    <Badge tone={row.session_id ? 'success' : 'neutral'} dot>{row.session_id ? 'Linked' : 'Pending'}</Badge>
                  </div>
                  <p className="text-[11px] text-ink-400 mt-1">{formatDateTime(row.captured_at)}</p>
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-ink-500">Page {page} of {totalPages} · {total} total</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button size="sm" variant="secondary" icon={<ChevronRight size={14} />} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.exam_candidates?.full_name || 'Captured Image'}
        subtitle={selected ? `${selected.registration_id}${selected.hall_ticket_number ? ' · ' + selected.hall_ticket_number : ''}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-4">
            <div className="rounded-xl overflow-hidden bg-ink-100 flex items-center justify-center min-h-[240px]">
              {imageErrors.has(selected.id) ? (
                <div className="py-16 flex flex-col items-center gap-2 text-ink-400">
                  <ImageOff size={28} />
                  <span className="text-sm">Unable to load this image</span>
                </div>
              ) : imageUrls[selected.id] ? (
                <img
                  src={imageUrls[selected.id]}
                  alt={`Check-in snapshot for ${selected.registration_id}`}
                  className="w-full max-h-[60vh] object-contain"
                />
              ) : (
                <div className="h-6 w-6 border-2 border-ink-200 border-t-brand-500 rounded-full animate-spin" />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <InfoTile label="Class" value={selected.exam_candidates?.student_class || '—'} />
              <InfoTile label="Exam" value={selected.exams?.exam_name || '—'} />
              <InfoTile label="Captured At" value={formatDateTime(selected.captured_at)} />
              <InfoTile
                label="Exam Attempt"
                value={<Badge tone={selected.session_id ? 'success' : 'neutral'} dot>{selected.session_id ? 'Linked to session' : 'Not yet linked'}</Badge>}
              />
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = { brand: 'text-brand-600', success: 'text-success-600', danger: 'text-danger-600', warning: 'text-warning-600', neutral: 'text-ink-700', accent: 'text-accent-600' };
  return (
    <div className="rounded-lg border border-ink-200 bg-surface px-3 py-2.5">
      <p className={`text-xl font-bold tabular-nums ${tones[tone]}`}>{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50 px-3 py-2.5">
      <p className="text-[11px] text-ink-400 uppercase tracking-wide font-semibold">{label}</p>
      <div className="text-sm font-semibold text-ink-900 mt-1 truncate">{value}</div>
    </div>
  );
}
