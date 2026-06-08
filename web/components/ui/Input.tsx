import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type InputSize = 'sm' | 'md';

const SIZE: Record<InputSize, string> = {
  sm: 'h-[30px] text-[12px]',
  md: 'h-[36px] text-[14px]',
};

/**
 * Input — white, ink-100 border, radius-md, optional left icon.
 * Focus = claude-500 border + claude focus ring. Sizes sm/md (30/36px).
 */
export default function Input({
  icon,
  inputSize = 'md',
  className,
  ...rest
}: {
  icon?: ReactNode;
  inputSize?: InputSize;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  return (
    <div className="relative inline-flex items-center w-full">
      {icon && (
        <span className="pointer-events-none absolute left-2.5 inline-flex items-center text-ink-400">
          {icon}
        </span>
      )}
      <input
        className={cn(
          'w-full bg-white border border-ink-100 rounded-md text-ink-800 placeholder:text-ink-400',
          'transition-colors duration-[120ms] outline-none',
          'focus:border-claude-500 focus:shadow-focus',
          icon ? 'pl-8 pr-3' : 'px-3',
          SIZE[inputSize],
          className,
        )}
        {...rest}
      />
    </div>
  );
}
