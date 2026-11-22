import { useAppName } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** The product's mark and name: its first letter on the primary color, then the name. */
export function BrandMark({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const name = useAppName();
  return (
    <div className={cn('flex min-w-0 items-center gap-2 font-semibold', className)}>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        {children}
      </span>
    </div>
  );
}
