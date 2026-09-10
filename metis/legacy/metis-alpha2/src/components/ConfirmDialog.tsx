/**
 * ConfirmDialog — reusable confirmation modal.
 *
 * 任务4 第六节：永久删除等破坏性操作必须走结构化确认；
 * 确认执行期间 busy 防双击（确认中的二次点击不会重复提交）。
 */

import { useTranslation } from '../i18n';
import { Dialog, Button } from './ui';
import { LoaderCircle } from 'lucide-react';

interface ConfirmDialogProps {
  title: string;
  /** 发生了什么 + 影响什么；破坏性操作需写明是否可恢复。 */
  message: string;
  /** 结构化的影响清单（可选）：每条一行，帮助用户理解删除范围。 */
  impacts?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 确认在途：按钮禁用 + spinner，防止双击重复提交。 */
  busy?: boolean;
  testId?: string;
}

export default function ConfirmDialog({
  title,
  message,
  impacts,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  testId,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }} title={title} size="sm" footer={(
      <>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button variant="danger" data-testid={testId ?? 'confirm-delete'} onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle size={13} className="async-spin" aria-hidden="true" />}
          {confirmLabel ?? t('common.delete')}
        </Button>
      </>
    )}>
      <p style={{ fontSize: 14, color: 'var(--text-body)', margin: 0 }}>{message}</p>
      {impacts && impacts.length > 0 && (
        <ul style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '10px 0 0', paddingLeft: 18 }}>
          {impacts.map((impact) => <li key={impact} style={{ marginBottom: 4 }}>{impact}</li>)}
        </ul>
      )}
    </Dialog>
  );
}
