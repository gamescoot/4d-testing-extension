import * as vscode from 'vscode';
import { parseMarkdown } from './parser';

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
    getOrCreateTag: (name: string) => vscode.TestTag
) {
    try {
        const rawContent = await vscode.workspace.fs.readFile(fileItem.uri!);
        const content = new TextDecoder().decode(rawContent);

        const ancestors: { item: vscode.TestItem; children: vscode.TestItem[] }[] = [
            { item: fileItem, children: [] }
        ];

        const ascend = (depth: number) => {
            while (ancestors.length > depth) {
                const finished = ancestors.pop()!;
                finished.item.children.replace(finished.children);
            }
        };

        const thisGeneration = Date.now();
        let hasFunction = false;

        parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                if (name.startsWith('test_')) {
                    hasFunction = true;
                }

                ascend(depth);
                const parent = ancestors[ancestors.length - 1];
                const id = `${fileItem.uri}/${name}`;
                const thead = controller.createTestItem(id, name, fileItem.uri);
                thead.range = range;
                testData.set(thead, new TestHeading(thisGeneration));

                // Convert heading tags to TestTag objects
                const tags = headingTags.map(getOrCreateTag);
                thead.tags = tags; // assign tags

                parent.children.push(thead);
                ancestors.push({ item: thead, children: [] });
            },

            onTest: (range, actual, operator, expected, should) => {
                const parent = ancestors[ancestors.length - 1];
                if (!parent || !(parent.item.label?.startsWith('test_'))) return;

                const data = new TestCase(
                    fileItem.uri!.fsPath,
                    actual,
                    operator,
                    expected,
                    should,
                    thisGeneration
                );
                const id = `${fileItem.uri}/${data.getLabel()}`;
                const tcase = controller.createTestItem(id, data.getLabel(), fileItem.uri);
                tcase.range = range;
                testData.set(tcase, data);

                // Inherit tags from parent heading
                tcase.tags = parent.item.tags;

                parent.children.push(tcase);
            }
        });

        // Remove file if no valid functions
        if (!hasFunction) {
            controller.items.delete(fileItem.id);
        }

        ascend(0);
    } catch (err) {
        console.error(`Error reading/parsing file ${fileItem.uri?.fsPath}:`, err);
    }
}
