export const helpTopics = Object.freeze([
	{ id: 'getting-started', title: '開始使用' }, { id: 'editing', title: '編輯文件' },
	{ id: 'tables-math', title: '表格與公式' }, { id: 'compilation', title: 'PDF 編譯' },
	{ id: 'shortcuts', title: '快捷鍵' }, { id: 'installation', title: '0.1.0 安裝指南' },
	{ id: 'licenses', title: '授權範圍' }, { id: 'agpl', title: 'AGPL 全文' },
	{ id: 'apache', title: 'Apache 全文' }, { id: 'notices', title: '第三方聲明' }
] as const);
export type HelpTopic = typeof helpTopics[number]['id'];
export function helpTopic(hash: string): HelpTopic {
	const id = hash.slice('#/help/'.length);
	return helpTopics.find((topic) => topic.id === id)?.id ?? 'getting-started';
}
