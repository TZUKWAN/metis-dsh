/**
 * ToastHost — 全局轻量通知（L4）。
 *
 * 任意模块派发 `metis:toast` 事件即弹出：{ kind: 'info'|'success'|'error',
 * text, durationMs }。用于后台作业完成/失败、议程推进等无需打断的通知。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import './ToastHost.css';

interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

let toastCounter = 0;

export default function ToastHost() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; text?: string; durationMs?: number }>).detail ?? {};
      const kind = detail.kind === 'success' || detail.kind === 'error' ? detail.kind : 'info';
      const text = typeof detail.text === 'string' && detail.text.trim() ? detail.text.trim().slice(0, 300) : '';
      if (!text) return;
      const durationMs = Math.min(20_000, Math.max(1500, Number(detail.durationMs) || 5000));
      toastCounter += 1;
      const item: ToastItem = { id: toastCounter, kind, text };
      setItems((current) => [...current.slice(-4), item]);
      setTimeout(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
      }, durationMs);
    };
    window.addEventListener('metis:toast', handler);
    return () => { window.removeEventListener('metis:toast', handler); };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite" data-testid="toast-host">
      {items.map((item) => (
        <div key={item.id} className={`toast-host__item toast-host__item--${item.kind}`} data-testid="toast-item">
          <span className="toast-host__text">{item.text}</span>
          <button
            type="button"
            className="toast-host__close"
            aria-label={t('common.close')}
            onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
