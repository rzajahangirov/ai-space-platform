import { useEffect, useRef, type ReactNode } from 'react';
import {
  X,
  ArrowUpRight,
  Box,
  Database,
  Globe,
  Server,
  Shield,
  Network,
  Radio,
  HardDrive,
  BrainCircuit,
  Activity,
  Layers,
} from 'lucide-react';
export const categoryIcons: Record<string, typeof Box> = {
  CLIENT: Globe,
  FRONTEND: Globe,
  BACKEND: Server,
  DATABASE: Database,
  INFRASTRUCTURE: Network,
  MESSAGING: Radio,
  STORAGE: HardDrive,
  AUTH: Shield,
  AI: BrainCircuit,
  OBSERVABILITY: Activity,
  EXTERNAL: ArrowUpRight,
  CUSTOM: Box,
};
export function ComponentIcon({ category, size = 18 }: { category: string; size?: number }) {
  const Icon = categoryIcons[category] ?? Box;
  return <Icon size={size} />;
}
export function Logo() {
  return (
    <span className="brand-mark">
      <Layers size={21} strokeWidth={2.5} />
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Layers size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function relative(date: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : new Date(date).toLocaleDateString();
}
export function initials(name: string) {
  return name
    .split(' ')
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
