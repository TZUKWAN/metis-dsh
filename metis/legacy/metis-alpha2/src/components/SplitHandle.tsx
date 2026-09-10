/**
 * SplitHandle — 通用的左右分栏拖拽分隔条。
 *
 * 用户可拖动调节两侧面板宽度；支持键盘（←/→ 以 16px 步进调节）。
 * 分隔条本身只是一个 7px 命中区 + 1px 视觉细线，宽度逻辑由父组件持有。
 */
import { useCallback, useRef } from 'react';

export interface SplitHandleProps {
  /** 拖动开始时调用（例如临时隐藏原生嵌入视图）。 */
  onDragStart?: () => void;
  /** 拖动中持续回调，参数为指针的 clientX。 */
  onDrag: (clientX: number) => void;
  /** 拖动结束时调用（在此持久化）。 */
  onDragEnd?: () => void;
  /** 键盘调节（←/→），参数为像素步进。 */
  onKeyDelta?: (delta: number) => void;
  /** 可访问名称（分隔条作用说明）。 */
  label: string;
  testId?: string;
}

export default function SplitHandle({ onDragStart, onDrag, onDragEnd, onKeyDelta, label, testId }: SplitHandleProps) {
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    onDragStart?.();
    const move = (ev: PointerEvent) => {
      if (draggingRef.current) onDrag(ev.clientX);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', move);
      onDragEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }, [onDragStart, onDrag, onDragEnd]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onKeyDelta?.(-16);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onKeyDelta?.(16);
    }
  }, [onKeyDelta]);

  return (
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      data-testid={testId}
    />
  );
}
