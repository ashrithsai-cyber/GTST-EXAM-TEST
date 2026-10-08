import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Upload, Check, Save } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Field, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { LoadingState } from '../components/ui/States';
import { formatDateTime } from '../lib/format';
import { toBranding } from '../lib/adapters';
import type { Branding } from '../lib/types';
import { getBranding, updateBrandingName, uploadBrandingLogo } from '../../services/adminApi';

export function ExamBrandingPage() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [loading, setLoading] = useState(true);
  const [examName, setExamName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [savedNameToast, setSavedNameToast] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res: any = await getBranding();
      const b = res.branding ? toBranding(res.branding) : null;
      setBranding(b);
      setExamName(b?.examName || '');
    } catch (err) {
      console.error('[ExamBrandingPage] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const nameChanged = branding !== null && examName.trim() !== '' && examName.trim() !== branding.examName;

  const saveName = async () => {
    if (!examName.trim()) return;
    setSavingName(true);
    setNameError('');
    try {
      const res: any = await updateBrandingName(examName.trim());
      setBranding(toBranding(res.branding));
      setSavedNameToast(true);
      setTimeout(() => setSavedNameToast(false), 2500);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Unable to save exam name.');
    } finally {
      setSavingName(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const openUpload = () => {
    setLogoError('');
    setFile(null);
    setPreviewUrl(null);
    setShowUpload(true);
  };

  const closeUpload = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setShowUpload(false);
    setFile(null);
    setPreviewUrl(null);
  };

  const doUpload = async () => {
    if (!file) return;
    setUploading(true);
    setLogoError('');
    try {
      const res: any = await uploadBrandingLogo(file);
      setBranding(toBranding(res.branding));
      closeUpload();
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Unable to upload logo.');
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return <PageContainer><LoadingState label="Loading exam branding…" /></PageContainer>;
  }

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Exam Branding</h1>
        <p className="text-sm text-ink-500 mt-1">
          The exam name and logo shown across the entire Student Exam Portal — header, footer, login page, and the
          exam-taking screen. Changes here take effect immediately for every student.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Exam Name" subtitle="Displayed wherever the exam name appears in the student portal" icon={<Save size={18} />} />
          <CardBody>
            {nameError && <div className="mb-3 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{nameError}</div>}
            <Field label="Exam Name" required>
              <TextInput value={examName} onChange={setExamName} placeholder="e.g. Global Talent Scholarship Test Plus · South India Level" />
            </Field>
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={saveName} disabled={!nameChanged || savingName}>{savingName ? 'Saving…' : 'Save Exam Name'}</Button>
              {branding && <span className="text-xs text-ink-400">Last updated {formatDateTime(branding.updatedAt)}</span>}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Exam Logo" subtitle="Shown in the header, login page, and exam-taking screen" icon={<ImageIcon size={18} />} />
          <CardBody>
            <div className="flex items-center gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-ink-50 border border-ink-200 overflow-hidden">
                {branding?.logoUrl ? (
                  <img src={branding.logoUrl} alt="Current exam logo" className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImageIcon size={24} className="text-ink-300" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-900">{branding?.logoUrl ? 'Current logo' : 'No logo uploaded yet'}</p>
                <p className="text-xs text-ink-500 mt-0.5">PNG, JPEG, WebP or SVG.</p>
                <Button size="sm" variant="secondary" icon={<Upload size={14} />} className="mt-2" onClick={openUpload}>
                  {branding?.logoUrl ? 'Change Logo' : 'Upload Logo'}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <Modal
        open={showUpload}
        onClose={closeUpload}
        title="Upload Exam Logo"
        subtitle="Replaces the current logo everywhere it's shown in the student portal."
        footer={<><Button variant="secondary" onClick={closeUpload}>Cancel</Button><Button onClick={doUpload} disabled={!file || uploading}>{uploading ? 'Uploading…' : 'Upload'}</Button></>}
      >
        <div className="space-y-4">
          {logoError && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{logoError}</div>}
          <div
            onClick={() => fileRef.current?.click()}
            className="flex flex-col items-center justify-center border-2 border-dashed border-ink-200 rounded-xl py-8 px-4 cursor-pointer hover:border-brand-400 hover:bg-brand-50/60 transition-colors"
          >
            {previewUrl ? (
              <img src={previewUrl} alt="Selected logo preview" className="max-h-28 max-w-full object-contain mb-2" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 text-ink-400 mb-3">
                <ImageIcon size={22} />
              </div>
            )}
            {file ? (
              <p className="text-sm font-medium text-ink-900">{file.name}</p>
            ) : (
              <>
                <p className="text-sm font-medium text-ink-700">Click to select an image file</p>
                <p className="text-xs text-ink-400 mt-1">PNG, JPG, WebP or SVG</p>
              </>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleFile} />
          </div>
        </div>
      </Modal>

      {savedNameToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-surface-raised text-ink-900 ring-1 ring-ink-300 px-4 py-3 shadow-pop animate-slide-in-right">
          <Check size={16} className="text-success-600" />
          <span className="text-sm font-medium">Exam name saved — updated across the student portal</span>
        </div>
      )}
    </PageContainer>
  );
}
