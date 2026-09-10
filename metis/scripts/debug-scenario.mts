// 一次性调试：脱离 vitest 复现 scenario 插件的 ctx.plugin 报错。
import plugin from '../plugins/scenario/src/index.ts';

const registered = [];
const sections = [];
const ctx = {
  reflect: { provide: () => {} },
  systemPrompt: { section: (section) => { sections.push(section.name); return () => {}; } },
  tools: { register: (tool) => { registered.push(tool.name); return () => {}; } },
  plugin: (ctor) => { new ctor(ctx); },
};

try {
  plugin.apply(ctx);
  console.log('OK tools:', registered, 'sections:', sections);
} catch (error) {
  console.log('FAILED:', error instanceof Error ? error.message : error);
  console.log('ctx keys at failure:', Object.keys(ctx));
}
