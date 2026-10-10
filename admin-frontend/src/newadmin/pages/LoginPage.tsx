import { useState, type FormEvent } from 'react';
import { GraduationCap, Lock, Mail } from 'lucide-react';
// authService.js is the existing, unmodified backend JWT auth layer —
// reused verbatim, not reimplemented.
import { login } from '../../services/authService';
import type { CurrentAdmin } from '../lib/types';

export function LoginPage({ onLoggedIn }: { onLoggedIn: (admin: CurrentAdmin) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }

    setSubmitting(true);
    try {
      const admin = await login(email.trim(), password);
      onLoggedIn(admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="newadmin-root min-h-screen flex items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-900/20 mb-3">
            <GraduationCap size={24} />
          </div>
          <p className="text-xs font-bold uppercase tracking-widest text-ink-500">GTST+ Examination Administration</p>
        </div>

        <div className="bg-surface ring-1 ring-ink-200 rounded-2xl shadow-pop p-7">
          <h1 className="text-xl font-bold text-ink-900 tracking-tight">Admin Sign In</h1>
          <p className="text-sm text-ink-500 mt-1 mb-6">Sign in with your administrator account to continue.</p>

          {error && (
            <div className="mb-4 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink-600 mb-1.5">Email</label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
                <input
                  type="email"
                  autoFocus
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="w-full rounded-lg border border-ink-200 bg-ink-50 pl-9 pr-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink-600 mb-1.5">Password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  className="w-full rounded-lg border border-ink-200 bg-ink-50 pl-9 pr-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center rounded-lg bg-brand-600 text-white font-medium text-sm px-4 py-2.5 hover:bg-brand-700 active:bg-brand-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
