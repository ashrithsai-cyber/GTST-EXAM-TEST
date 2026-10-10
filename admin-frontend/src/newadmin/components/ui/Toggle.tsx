export function Toggle({ checked, onChange, disabled = false, size = 'md' }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const dims = size === 'sm' ? { w: 'w-9', h: 'h-5', knob: 'h-4 w-4', translate: 'translate-x-4' } : { w: 'w-11', h: 'h-6', knob: 'h-5 w-5', translate: 'translate-x-5' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex shrink-0 ${dims.w} ${dims.h} cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? '!bg-brand-600' : '!bg-ink-300'}`}
    >
      <span className={`pointer-events-none inline-block ${dims.knob} transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? dims.translate : 'translate-x-0'}`} />
    </button>
  );
}
