/**
 * CodeBlock — 带 Prism 高亮与复制按钮的代码块（从 ChatPage 提取共享，
 * 供聊天消息流与生成物预览栏共用；语言包在这里统一注册）。
 */
import { useEffect, useRef, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-latex';
import { useTranslation } from '../i18n';

export function CodeBlock({ language, code, streaming = false }: { language: string; code: string; streaming?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    // While tokens are still streaming in, skip Prism entirely: per-line
    // highlight caching is fragile for multiline tokens (block comments,
    // template strings), so the growing block renders as plain text and gets
    // exactly one full highlight once the turn settles.
    if (streaming) return;
    if (ref.current) {
      Prism.highlightElement(ref.current);
    }
  }, [code, language, streaming]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{language || 'text'}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre className="code-pre">
        <code ref={ref} className={`language-${language || 'text'}`}>{code}</code>
      </pre>
    </div>
  );
}
