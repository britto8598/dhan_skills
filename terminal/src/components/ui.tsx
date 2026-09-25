"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

export function Btn({
  children,
  onClick,
  active,
  title,
  className,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  title?: string;
  className?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "no-drag inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[11px] leading-none whitespace-nowrap transition-colors",
        active ? "bg-accent/25 text-[#9ec5ff] ring-1 ring-accent/50" : "text-fg/85 hover:bg-panel3",
        danger && "hover:bg-down/20 hover:text-down",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("no-drag inline-flex overflow-hidden rounded-[3px] border border-line", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-[20px] px-1.5 text-[11px] leading-none",
            o.value === value ? "bg-accent/30 text-[#bfdbfe]" : "text-muted hover:bg-panel3 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sel<T extends string | number>({
  value,
  options,
  onChange,
  title,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
  className?: string;
}) {
  return (
    <select
      title={title}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      className={cx("no-drag h-[20px] rounded-[3px] border border-line bg-panel2 px-1 text-[11px] outline-none focus:border-accent", className)}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string }) {
  return (
    <label title={title} className="no-drag flex cursor-pointer items-center gap-1.5 py-0.5 text-[11px] whitespace-nowrap select-none hover:text-fg">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      <span>{label}</span>
    </label>
  );
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onOut();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [ref, onOut, active]);
}

/** Dropdown menu anchored to a trigger button. */
export function Menu({
  trigger,
  children,
  align = "left",
  width = 200,
  title,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  width?: number;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useClickOutside(ref, close, open);
  return (
    <div ref={ref} className={cx("no-drag relative", className)}>
      <Btn title={title} active={open} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </Btn>
      {open && (
        <div
          className={cx(
            "absolute top-[24px] z-[200] max-h-[70vh] overflow-auto rounded border border-line2 bg-panel2 p-1 shadow-2xl shadow-black/60",
            align === "right" ? "right-0" : "left-0",
          )}
          style={{ width }}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, disabled, danger, hint }: { children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; danger?: boolean; hint?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1 text-left text-[11px]",
        active ? "bg-accent/20 text-[#bfdbfe]" : "hover:bg-panel3",
        danger && "text-down hover:bg-down/15",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span className="truncate">{children}</span>
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-0.5 text-[10px] tracking-wide text-dim uppercase">{children}</div>;
}

export function Modal({ title, onClose, children, width = 420 }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full overflow-auto rounded-md border border-line2 bg-panel shadow-2xl" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="text-[12px] font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="text-muted hover:text-fg" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-dim">{hint}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("no-drag h-[24px] rounded-[3px] border border-line bg-panel2 px-2 text-[12px] outline-none focus:border-accent", props.className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-muted">{children}</div>;
}

/** Observe an element's size. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
