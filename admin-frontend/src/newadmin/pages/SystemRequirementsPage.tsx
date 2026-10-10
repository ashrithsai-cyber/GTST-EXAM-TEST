import { useEffect, useState, type ReactNode } from 'react';
import { Camera, CameraOff, Mic, Maximize, ScanFace, Check, AlertTriangle, ShieldAlert, AppWindow } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Toggle } from '../components/ui/Toggle';
import { PageContainer, PageHeader } from '../components/ui/PageHeader';
import { LoadingState } from '../components/ui/States';
import type { ExamSettings } from '../lib/types';
import { getExamSettings, updateExamSettings } from '../../services/adminApi';

type RequirementKey = 'proctoringEnabled' | 'tabSwitchMonitoringEnabled' | 'cameraRequired' | 'photoCaptureEnabled' | 'microphoneRequired' | 'fullscreenRequired' | 'faceDetectionEnabled';

const REQUIREMENTS: { key: RequirementKey; label: string; description: string; icon: ReactNode }[] = [
  {
    key: 'proctoringEnabled',
    label: 'Proctoring & Violation Recording',
    description: 'Master switch. When ON, violations during the exam (camera, face, microphone, tab switch, fullscreen exit, right-click) are recorded, shown to the student in a popup, and listed on the Violations page. Violations are only recorded — the exam is never blocked. When OFF, nothing is recorded.',
    icon: <ShieldAlert size={18} />,
  },
  {
    key: 'tabSwitchMonitoringEnabled',
    label: 'Tab Switch Monitoring',
    description: 'Record switching tabs or leaving the exam window as a violation (requires Proctoring to be ON).',
    icon: <AppWindow size={18} />,
  },
  {
    key: 'photoCaptureEnabled',
    label: 'Check-in Photo Capture',
    description: 'Take and save a student photo during System Check before the exam can start.',
    icon: <CameraOff size={18} />,
  },
  {
    key: 'cameraRequired',
    label: 'Camera',
    description: 'Students must enable their camera and pass the camera check before System Check can be completed.',
    icon: <Camera size={18} />,
  },
  {
    key: 'microphoneRequired',
    label: 'Microphone',
    description: 'Students must enable and unmute their microphone before System Check can be completed.',
    icon: <Mic size={18} />,
  },
  {
    key: 'fullscreenRequired',
    label: 'Full Screen',
    description: 'Students must enter fullscreen mode before System Check can be completed.',
    icon: <Maximize size={18} />,
  },
  {
    key: 'faceDetectionEnabled',
    label: 'Face Recognition',
    description: 'Exactly one face must be visible in the camera at all times during System Check.',
    icon: <ScanFace size={18} />,
  },
];

export function SystemRequirementsPage() {
  const [settings, setSettings] = useState<ExamSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [savingKey, setSavingKey] = useState<RequirementKey | null>(null);
  const [rowError, setRowError] = useState<{ key: RequirementKey; message: string } | null>(null);
  const [savedToast, setSavedToast] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res: any = await getExamSettings();
        setSettings(res.settings);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Unable to load system requirements.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggle = async (key: RequirementKey, value: boolean) => {
    if (!settings) return;
    const previous = settings;
    setRowError(null);
    setSavingKey(key);
    // Optimistic — reverted below if the save fails.
    setSettings({ ...settings, [key]: value });
    try {
      const res: any = await updateExamSettings({ [key]: value });
      setSettings(res.settings);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2200);
    } catch (err) {
      setSettings(previous);
      setRowError({ key, message: err instanceof Error ? err.message : 'Unable to save this change.' });
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return <PageContainer><LoadingState label="Loading system requirements…" /></PageContainer>;
  }

  return (
    <PageContainer>
      <PageHeader
        title="System Requirements"
        description="Choose which system checks students must pass before they can start the exam. Turning a requirement off applies immediately — students will no longer be blocked by that check."
      />

      {loadError && (
        <div className="mb-4 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{loadError}</div>
      )}

      <Card>
        <div className="divide-y divide-ink-200">
          {REQUIREMENTS.map((req) => {
            const checked = Boolean(settings?.[req.key]);
            const isSaving = savingKey === req.key;
            return (
              <CardBody key={req.key} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="shrink-0 mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                      {req.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-ink-900">{req.label}</p>
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${checked ? 'bg-success-50 text-success-700' : 'bg-ink-100 text-ink-500'}`}>
                          {checked ? 'ON' : 'OFF'}
                        </span>
                      </div>
                      <p className="text-xs text-ink-500 mt-1 max-w-xl">{req.description}</p>
                      {rowError?.key === req.key && (
                        <p className="text-xs text-danger-600 mt-1.5 flex items-center gap-1">
                          <AlertTriangle size={12} /> {rowError.message}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2 pt-1">
                    {isSaving && <span className="text-xs text-ink-400">Saving…</span>}
                    <Toggle checked={checked} onChange={(v) => handleToggle(req.key, v)} disabled={isSaving} />
                  </div>
                </div>
              </CardBody>
            );
          })}
        </div>
      </Card>

      {savedToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-surface-raised text-ink-900 ring-1 ring-ink-300 px-4 py-3 shadow-pop animate-slide-in-right">
          <Check size={16} className="text-success-600" />
          <span className="text-sm font-medium">Saved — reflected in the Student Exam Portal immediately</span>
        </div>
      )}
    </PageContainer>
  );
}
