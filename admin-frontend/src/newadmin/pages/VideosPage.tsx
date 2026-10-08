import { useEffect, useRef, useState } from 'react';
import { Video, Play, Trash2, CheckCircle2, Upload, Film, Calendar, HardDrive, Pencil } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Field, TextInput, TextArea } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { formatDate, formatFileSize } from '../lib/format';
import { toVideo } from '../lib/adapters';
import type { SafetyVideo } from '../lib/types';
import { getMockVideo, uploadMockVideo, updateMockVideoDetails, deleteMockVideo } from '../../services/adminApi';

export function VideosPage() {
  const [video, setVideo] = useState<SafetyVideo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await getMockVideo();
      setVideo(res.video ? toVideo(res.video) : null);
    } catch (err) {
      console.error('[VideosPage] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      await uploadMockVideo(file, { title: title || undefined, description: description || undefined });
      setShowUpload(false);
      setFile(null);
      setTitle('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload video.');
    } finally {
      setUploading(false);
    }
  };

  const saveDetails = async () => {
    setUploading(true);
    setError('');
    try {
      await updateMockVideoDetails({ title, description });
      setShowEdit(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update video details.');
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    try {
      await deleteMockVideo();
      setConfirmDelete(false);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to delete video.');
    }
  };

  if (loading) {
    return <PageContainer><LoadingState label="Loading video…" /></PageContainer>;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink-900 tracking-tight">Video Management</h1>
          <p className="text-sm text-ink-500 mt-1">
            Upload → stored securely → automatically served to students on the proctoring/rules page. One active video at a time; uploading a new one replaces it.
          </p>
        </div>
        <Button icon={<Upload size={16} />} onClick={() => setShowUpload(true)}>{video ? 'Replace Video' : 'Upload Video'}</Button>
      </div>

      {!video ? (
        <Card><EmptyState icon={<Video size={22} />} title="No video uploaded" description="Upload an exam safety / instruction video." action={<Button icon={<Upload size={16} />} onClick={() => setShowUpload(true)}>Upload Video</Button>} /></Card>
      ) : (
        <Card className="max-w-xl">
          <div className="relative aspect-video rounded-t-xl bg-black overflow-hidden flex items-center justify-center group cursor-pointer" onClick={() => setShowPreview(true)}>
            <video src={video.url} className="w-full h-full object-contain" preload="metadata" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15">
                <Play size={24} className="text-white ml-0.5" />
              </div>
            </div>
            <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
              <CheckCircle2 size={12} /> Active
            </span>
          </div>
          <CardBody>
            <p className="text-sm font-semibold text-ink-900 truncate">{video.title}</p>
            {video.description && <p className="text-xs text-ink-500 mt-1">{video.description}</p>}
            <div className="flex items-center gap-3 mt-2 text-xs text-ink-400">
              <span className="flex items-center gap-1"><Calendar size={12} /> {formatDate(video.createdAt)}</span>
              <span className="flex items-center gap-1"><HardDrive size={12} /> {formatFileSize(video.fileSizeBytes)}</span>
            </div>
            <div className="mt-3 flex items-center gap-2 pt-3 border-t border-ink-100">
              <Badge tone="brand" dot>Active</Badge>
              <Button size="sm" variant="secondary" icon={<Play size={14} />} onClick={() => setShowPreview(true)}>Preview</Button>
              <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => { setTitle(video.title); setDescription(video.description || ''); setError(''); setShowEdit(true); }}>Edit Details</Button>
              <button onClick={() => setConfirmDelete(true)} className="ml-auto rounded-lg p-2 text-ink-400 hover:bg-danger-50 hover:text-danger-600 transition-colors"><Trash2 size={16} /></button>
            </div>
          </CardBody>
        </Card>
      )}

      <Modal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        title={video ? 'Replace Safety Video' : 'Upload Safety Video'}
        subtitle="Video is stored securely in Supabase Storage. Storage credentials are never exposed to the browser."
        footer={<><Button variant="secondary" onClick={() => setShowUpload(false)}>Cancel</Button><Button onClick={upload} disabled={!file || uploading}>{uploading ? 'Uploading…' : 'Upload'}</Button></>}
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{error}</div>}
          <div
            onClick={() => fileRef.current?.click()}
            className="flex flex-col items-center justify-center border-2 border-dashed border-ink-200 rounded-xl py-10 px-4 cursor-pointer hover:border-brand-400 hover:bg-brand-500/10 transition-colors"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 text-ink-400 mb-3">
              <Film size={22} />
            </div>
            {file ? (
              <p className="text-sm font-medium text-ink-900">{file.name}</p>
            ) : (
              <>
                <p className="text-sm font-medium text-ink-700">Click to select a video file</p>
                <p className="text-xs text-ink-400 mt-1">MP4, WebM, MOV, AVI or OGV</p>
              </>
            )}
            <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
          </div>
          <Field label="Title (optional)"><TextInput value={title} onChange={setTitle} placeholder="Mock Examination Demo" /></Field>
          <Field label="Description (optional)"><TextArea value={description} onChange={setDescription} rows={2} /></Field>
          {video && <p className="text-xs text-ink-400">Uploading will replace the current active video ("{video.title}") immediately.</p>}
        </div>
      </Modal>

      <Modal
        open={showEdit}
        onClose={() => setShowEdit(false)}
        title="Edit Video Details"
        footer={<><Button variant="secondary" onClick={() => setShowEdit(false)}>Cancel</Button><Button onClick={saveDetails} disabled={uploading}>{uploading ? 'Saving…' : 'Save'}</Button></>}
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{error}</div>}
          <Field label="Title"><TextInput value={title} onChange={setTitle} /></Field>
          <Field label="Description"><TextArea value={description} onChange={setDescription} rows={2} /></Field>
        </div>
      </Modal>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Video" size="sm" footer={<><Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" onClick={remove}>Delete</Button></>}>
        <p className="text-sm text-ink-600">
          Permanently delete this video? Students will fall back to the bundled default safety video until a new one is uploaded. This cannot be undone.
        </p>
      </Modal>

      <Modal open={showPreview} onClose={() => setShowPreview(false)} title={video?.title || ''} subtitle={video ? `${formatFileSize(video.fileSizeBytes)}` : ''} size="lg">
        {video && (
          <div className="aspect-video rounded-xl bg-black overflow-hidden">
            <video src={video.url} controls className="w-full h-full" />
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}
