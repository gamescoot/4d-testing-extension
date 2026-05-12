import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseMarkdown } from './parser';

const LOG_PATH = path.join(os.tmpdir(), '4d-testing-extension.log');
function dbg(msg: string) {
    const line = `[${new Date().toISOString()}] [testTree] ${msg}\n`;
    try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
}

export const testData = new WeakMap<vscode.TestItem, TestCase | TestHeading | FileData>();

export class TestCase {
    constructor(
        public readonly file: string,
        public readonly actual: string,
        public readonly operator: string,
        public readonly expected: string,
        public readonly should: string,
        public readonly generation: number
    ) {}

    getLabel(): string {
        return `${this.should}`;
    }
}

export class TestHeading {
    constructor(public readonly generation: number) {}
}

export type FileData = { kind: 'file' };

export async function updateFromDisk(
    controller: vscode.TestController,
    fileItem: vscode.TestItem,
    getOrCreateTag: (name: string) => vscode.TestTag,
    generation?: number
) {
    const fileName = fileItem.uri?.path.split('/').pop() ?? fileItem.id;
    dbg(`updateFromDisk: ${fileName}`);
    let oldChildCount = 0;
    fileItem.children.forEach(() => oldChildCount++);
    dbg(`  existing children before parse: ${oldChildCount}`);

    try {
        const rawContent = await vscode.workspace.fs.readFile(fileItem.uri!);
        const content = new TextDecoder().decode(rawContent);

        const ancestors: { item: vscode.TestItem; children: vscode.TestItem[] }[] = [
            { item: fileItem, children: [] }
        ];

        const ascend = (depth: number) => {
            while (ancestors.length > depth) {
                const finished = ancestors.pop()!;
                dbg(`  children.replace on "${finished.item.label}": ${finished.children.length} new children`);
                finished.item.children.replace(finished.children);
            }
        };

        const thisGeneration = Date.now();
        let hasFunction = false;
        let headingCount = 0;

        parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                headingCount++;
                if (name.startsWith('test_')) {
                    hasFunction = true;
                }

                ascend(depth);
                const parent = ancestors[ancestors.length - 1];
                const genPrefix = generation != null ? `g${generation}:` : '';
                const id = `${genPrefix}${fileItem.uri}/${name}`;
                const thead = controller.createTestItem(id, name, fileItem.uri);
                thead.range = range;
                testData.set(thead, new TestHeading(thisGeneration));

                // Convert heading tags to TestTag objects
                const tags = headingTags.map(getOrCreateTag);
                thead.tags = tags; // assign tags

                parent.children.push(thead);
                ancestors.push({ item: thead, children: [] });
            }
        });

        dbg(`  parsed ${headingCount} headings, hasFunction=${hasFunction}`);

        // Remove file if no valid functions
        if (!hasFunction) {
            dbg(`  removing file item (no test functions found)`);
            controller.items.delete(fileItem.id);
        }

        ascend(0);
        let newChildCount = 0;
        fileItem.children.forEach(() => newChildCount++);
        dbg(`  final children after ascend: ${newChildCount}`);
    } catch (err: any) {
        dbg(`  ERROR: ${err?.message ?? err}`);
        console.error(`Error reading/parsing file ${fileItem.uri?.fsPath}:`, err);
    }
}
