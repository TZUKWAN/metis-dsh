import { createFundingTools } from '../src/tools.ts';
const tools = createFundingTools('.x.json');
console.log('names:', tools.map((t) => t.name));
console.log('exec types:', tools.map((t) => typeof t.execute));
const byName = new Map(tools.map((t) => [t.name, t]));
console.log('parse type:', typeof byName.get('funding_template_parse')!.execute);
