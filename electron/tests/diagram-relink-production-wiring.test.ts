import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

let source = '';
let file: ts.SourceFile;

function descendants<T extends ts.Node>(node: ts.Node, predicate: (candidate: ts.Node) => candidate is T): T[] {
	const matches: T[] = [];
	function visit(candidate: ts.Node): void {
		if (predicate(candidate)) matches.push(candidate);
		candidate.forEachChild(visit);
	}
	visit(node);
	return matches;
}

function ancestor<T extends ts.Node>(node: ts.Node, predicate: (candidate: ts.Node) => candidate is T): T | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (predicate(current)) return current;
		current = current.parent;
	}
	return undefined;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
	const found = object.properties.find(
		(candidate): candidate is ts.PropertyAssignment =>
			ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name
	);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

function isWhenReadyThen(call: ts.CallExpression): boolean {
	if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'then') return false;
	const ready = call.expression.expression;
	return (
		ts.isCallExpression(ready) &&
		ts.isPropertyAccessExpression(ready.expression) &&
		ready.expression.name.text === 'whenReady' &&
		ts.isIdentifier(ready.expression.expression) &&
		ready.expression.expression.text === 'app'
	);
}

beforeAll(async () => {
	source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
	file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
});

describe('diagram relink production registration', () => {
	it('imports and registers exactly once inside app.whenReady before any initial window', () => {
		const imports = file.statements.filter(
			(statement): statement is ts.ImportDeclaration =>
				ts.isImportDeclaration(statement) && statement.moduleSpecifier.getText(file) === "'./diagram-ipc'"
		);
		expect(imports).toHaveLength(1);
		expect(imports[0]!.importClause?.namedBindings?.getText(file)).toContain('registerDiagramRelinkIpc');

		const registrations = descendants(
			file,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerDiagramRelinkIpc'
		);
		expect(registrations).toHaveLength(1);
		const registration = registrations[0]!;
		const readyCallback = ancestor(
			registration,
			(node): node is ts.ArrowFunction =>
				ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node && isWhenReadyThen(node.parent)
		);
		expect(readyCallback).toBeDefined();
		expect(ts.isBlock(readyCallback!.body)).toBe(true);
		const readyBody = readyCallback!.body as ts.Block;
		const createWindowCalls = descendants(
			readyBody,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createWindow'
		);
		expect(createWindowCalls.length).toBeGreaterThan(0);
		expect(registration.getStart(file)).toBeLessThan(Math.min(...createWindowCalls.map((call) => call.getStart(file))));
	});

	it('uses ipcMain directly and derives workspace and parent only from the live sender window', () => {
		const registration = descendants(
			file,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerDiagramRelinkIpc'
		)[0]!;
		expect(registration.arguments).toHaveLength(1);
		const dependencies = registration.arguments[0]!;
		expect(ts.isObjectLiteralExpression(dependencies)).toBe(true);
		const object = dependencies as ts.ObjectLiteralExpression;

		expect(property(object, 'registrar').initializer.getText(file)).toBe('ipcMain');
		const workspace = property(object, 'workspaceForSender').initializer;
		expect(ts.isArrowFunction(workspace)).toBe(true);
		const workspaceText = workspace.getText(file);
		expect(workspaceText).toContain('const win = windowFor(senderId)');
		expect(workspaceText).toContain('if (!win) return null');
		expect(workspaceText).toContain('windowRoots.get(senderId)?.raw ?? null');
		expect(workspaceText.indexOf('windowFor(senderId)')).toBeLessThan(workspaceText.indexOf('windowRoots.get(senderId)'));
		expect(workspaceText).not.toMatch(/request|\.root\b|root\s*:/);

		const parent = property(object, 'parentForSender').initializer.getText(file);
		expect(parent).toContain('windowFor(sender.id)');
		expect(source).not.toMatch(/handleFsE?\(['"]diagram:relink['"]/);
	});

	it('adapts the native picker with the parent overload and returns only canceled plus filePaths', () => {
		const registration = descendants(
			file,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerDiagramRelinkIpc'
		)[0]!;
		const object = registration.arguments[0] as ts.ObjectLiteralExpression;
		const picker = property(object, 'pickFile').initializer;
		expect(ts.isArrowFunction(picker)).toBe(true);
		const pickerText = picker.getText(file);
		expect(pickerText).toContain('{ parent, defaultPath, extensions }');
		expect(pickerText).toContain("properties: ['openFile']");
		expect(pickerText).toContain('defaultPath');

		const dialogCalls = descendants(
			picker,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === 'dialog' &&
				node.expression.name.text === 'showOpenDialog'
		);
		expect(dialogCalls).toHaveLength(2);
		expect(dialogCalls.some((call) => call.arguments.length === 2 && call.arguments[0]!.getText(file) === 'parent')).toBe(true);
		expect(dialogCalls.some((call) => call.arguments.length === 1)).toBe(true);

		const optionObjects = descendants(picker, (node): node is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(node));
		const pickerOptions = optionObjects.find((candidate) =>
			candidate.properties.some((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === 'filters')
		);
		expect(pickerOptions).toBeDefined();
		const filterText = property(pickerOptions!, 'filters').initializer.getText(file);
		expect(filterText).toMatch(/^\[\{[\s\S]*extensions:\s*\[\.\.\.extensions\][\s\S]*\}\]$/);

		const returns = descendants(picker, (node): node is ts.ReturnStatement => ts.isReturnStatement(node));
		const result = returns.find((statement) => statement.expression && ts.isObjectLiteralExpression(statement.expression));
		expect(result?.expression && ts.isObjectLiteralExpression(result.expression)).toBe(true);
		const returnedKeys = (result!.expression as ts.ObjectLiteralExpression).properties.map((item) => item.name?.getText(file)).sort();
		expect(returnedKeys).toEqual(['canceled', 'filePaths']);
	});

	it('does not place registration in createWindow or the activate lifecycle', () => {
		const createWindow = file.statements.find(
			(statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createWindow'
		);
		expect(createWindow?.getText(file)).not.toContain('registerDiagramRelinkIpc');

		const activateCalls = descendants(
			file,
			(node): node is ts.CallExpression =>
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === 'app' &&
				node.expression.name.text === 'on' &&
				node.arguments[0]?.getText(file) === "'activate'"
		);
		expect(activateCalls).toHaveLength(1);
		expect(activateCalls[0]!.getText(file)).not.toContain('registerDiagramRelinkIpc');
	});
});
