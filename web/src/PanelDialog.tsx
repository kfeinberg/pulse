import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function PanelDialog({ children, titleId, close, className = '' }: {
  children: ReactNode;
  titleId: string;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { dialog.close(); };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`panel-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }}
    >
      {children}
    </dialog>
  );
}
