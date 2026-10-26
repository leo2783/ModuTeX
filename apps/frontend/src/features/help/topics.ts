export { helpTopic, type HelpTopic } from './route.ts';
export const helpTopics = Object.freeze([
	{ id: 'getting-started', title: '開始使用' }, { id: 'editing', title: '編輯文件' },
	{ id: 'tables-math', title: '表格與公式' }, { id: 'compilation', title: 'PDF 編譯' },
	{ id: 'shortcuts', title: '快捷鍵' },
	{ id: 'licenses', title: '授權範圍' }, { id: 'apache', title: 'Apache 全文' },
	{ id: 'notices', title: '第三方聲明' }
] as const);
