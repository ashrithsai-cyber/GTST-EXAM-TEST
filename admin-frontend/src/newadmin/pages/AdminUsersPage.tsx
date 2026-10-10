import { useEffect, useState } from 'react';
import { Plus, UserCog, Pencil, Ban, CheckCircle2 } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Field, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { adminRoleMeta, formatDateTime } from '../lib/format';
import { toAdminUser } from '../lib/adapters';
import type { AdminUser, CurrentAdmin } from '../lib/types';
import { listAdminUsers, createAdminUser, updateAdminUser, updateAdminUserStatus } from '../../services/adminApi';

type EditState = { id?: string; name: string; email: string; password: string };
const emptyForm: EditState = { name: '', email: '', password: '' };

export function AdminUsersPage({ admin }: { admin: CurrentAdmin }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await listAdminUsers();
      setUsers((res.admins || []).map(toAdminUser));
    } catch (err) {
      console.error('[AdminUsersPage] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => { setError(''); setEditing({ ...emptyForm }); setShowForm(true); };
  const openEdit = (u: AdminUser) => { setError(''); setEditing({ id: u.id, name: u.name, email: u.email, password: '' }); setShowForm(true); };

  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.email.trim()) return;
    if (!editing.id && (!editing.password || editing.password.length < 10)) {
      setError('Password must be at least 10 characters.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editing.id) {
        const payload: any = { name: editing.name.trim() };
        if (editing.password) payload.password = editing.password;
        await updateAdminUser(editing.id, payload);
      } else {
        await createAdminUser({ name: editing.name.trim(), email: editing.email.trim(), password: editing.password });
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save admin user.');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (u: AdminUser) => {
    if (u.id === admin.id) return;
    try {
      await updateAdminUserStatus(u.id, !u.isActive);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unable to update admin status.');
    }
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink-900 tracking-tight">Admin Management</h1>
          <p className="text-sm text-ink-500 mt-1">Super-admin only. Manage administrator accounts, roles and access.</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={openNew}>New Admin</Button>
      </div>

      {loading ? (
        <LoadingState label="Loading admins…" />
      ) : users.length === 0 ? (
        <Card><EmptyState icon={<UserCog size={22} />} title="No admin users" description="Create the first admin account." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last Login</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-ink-50/70 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-ink-900">{u.name}{u.id === admin.id && <span className="text-xs text-ink-400 ml-1.5">(you)</span>}</td>
                    <td className="px-4 py-3 text-sm text-ink-600">{u.email}</td>
                    <td className="px-4 py-3"><Badge tone={adminRoleMeta[u.role].tone}>{adminRoleMeta[u.role].label}</Badge></td>
                    <td className="px-4 py-3"><Badge tone={u.isActive ? 'success' : 'danger'} dot>{u.isActive ? 'Active' : 'Suspended'}</Badge></td>
                    <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => openEdit(u)}>Edit</Button>
                        <Button
                          size="sm"
                          variant={u.isActive ? 'ghost' : 'success'}
                          icon={u.isActive ? <Ban size={14} /> : <CheckCircle2 size={14} />}
                          disabled={u.id === admin.id}
                          onClick={() => toggleStatus(u)}
                        >
                          {u.isActive ? 'Suspend' : 'Reactivate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing?.id ? 'Edit Admin' : 'New Admin'}
        footer={<><Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></>}
      >
        {editing && (
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{error}</div>}
            <Field label="Name" required><TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} /></Field>
            <Field label="Email" required hint={editing.id ? 'Email cannot be changed after creation.' : undefined}>
              <TextInput type="email" value={editing.email} onChange={(v) => setEditing({ ...editing, email: v })} disabled={!!editing.id} className={editing.id ? 'opacity-60 cursor-not-allowed' : ''} />
            </Field>
            <Field label={editing.id ? 'New Password (optional)' : 'Password'} required={!editing.id} hint="Minimum 10 characters.">
              <TextInput type="password" value={editing.password} onChange={(v) => setEditing({ ...editing, password: v })} placeholder={editing.id ? 'Leave blank to keep current password' : ''} />
            </Field>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-500 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}
