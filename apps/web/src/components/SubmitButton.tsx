'use client';

import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  pendingLabel,
  secondary,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  secondary?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={secondary ? 'secondary' : ''} disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </button>
  );
}
