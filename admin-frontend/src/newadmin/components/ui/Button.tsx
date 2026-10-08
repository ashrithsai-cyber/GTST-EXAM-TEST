import { type ReactNode, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-sm',
  secondary: 'bg-ink-100 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-200 active:bg-ink-300',
  ghost: 'text-ink-600 hover:bg-ink-100 active:bg-ink-200',
  danger: 'bg-danger-600 text-white hover:bg-danger-500 active:bg-danger-700 shadow-sm',
  success: 'bg-success-600 text-white hover:bg-success-500 active:bg-success-700 shadow-sm',
};

const sizes: Record<Size, string> = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-3.5 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
};

// Disabled state is always neutral gray regardless of variant — a faded
// orange/red/green still reads as "still that color, just dim," while a
// flat gray unambiguously reads as "not available right now."
const DISABLED = 'disabled:bg-ink-100 disabled:text-ink-500 disabled:shadow-none disabled:ring-0 disabled:cursor-not-allowed disabled:hover:bg-ink-100';

export function Button({ variant = 'primary', size = 'md', icon, children, className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${variants[variant]} ${DISABLED} ${sizes[size]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
