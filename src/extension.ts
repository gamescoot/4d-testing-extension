import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTestRun } from './startTestRun';
import { updateFromDisk, testData } from './testTree';

const LOG_PATH = path.join(os.tmpdir(), '4d-testing-extension.log');
function dbg(msg: string) {
    const line = `[${new Date().toISOString()}] [discovery] ${msg}\n`;
    try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
}

function countItems(collection: vscode.TestItemCollection): number {
    let n = 0;
    collection.forEach(() => n++);
    return n;
}

let discoveryGeneration = Date.now();

export function activate(context: vscode.ExtensionContext) {
    dbg('activate() called');
    const controller = vscode.tests.createTestController(
        'fourDTestController',
        '4D Tests'
    );
    context.subscriptions.push(controller);

    // Map keywords to emojis
    const emojiMap: Record<string, string> = {
        fast: '⚡️',
        slow: '🐢',
        unit: '🧪',
        integration: '🧩',
        table: '🗄️'
    };

    const tagRegistry = new Map<string, vscode.TestTag>();

    function getEmojiForTag(tagName: string): string {
        const lower = tagName.toLowerCase();
        const emojis: string[] = [];

        for (const [key, emoji] of Object.entries(emojiMap)) {
            if (lower.includes(key)) {
                emojis.push(emoji);
            }
        }

        return emojis.join(' ') + (emojis.length > 0 ? ' ' : '🔹 ');
    }

    function getOrCreateTag(name: string): vscode.TestTag {
        let tag = tagRegistry.get(name);
        if (!tag) {
            tag = new vscode.TestTag(name);
            tagRegistry.set(name, tag);

            const emojiPrefix = getEmojiForTag(name);
            const profileName = `${emojiPrefix}Run ${name} tests`;

            // Create a run profile for this tag
            controller.createRunProfile(
                profileName,
                vscode.TestRunProfileKind.Run,
                (request, token) => {
                    runTestsByTag(controller, name, token, request.profile!);
                }
            );
        }
        return tag;
    }

    // --- Default Run All Tests (first alphabetically) ---
    controller.createRunProfile(
        '▶️ Run All Tests',
        vscode.TestRunProfileKind.Run,
        (request, token) => runTests(controller, request, token)
    );

    // --- Default Debug All Tests ---
    controller.createRunProfile(
        '🐞 Debug All Tests',
        vscode.TestRunProfileKind.Debug,
        (request, token) => runTests(controller, request, token)
    );

    // Discover tests when workspace opens, then clear stale results
    if (vscode.workspace.workspaceFolders) {
        dbg(`initial discovery for ${vscode.workspace.workspaceFolders.length} workspace folder(s)`);
        const folders = [...vscode.workspace.workspaceFolders];
        (async () => {
            for (const folder of folders) {
                dbg(`  folder: ${folder.uri.fsPath}`);
                await discoverTests(controller, folder.uri, getOrCreateTag);
            }
            dbg(`invalidateTestResults() — root items: ${countItems(controller.items)}`);
            controller.invalidateTestResults();
        })();
    } else {
        dbg('no workspace folders found');
    }

    vscode.workspace.onDidChangeWorkspaceFolders(event => {
        dbg(`onDidChangeWorkspaceFolders: added=${event.added.length} removed=${event.removed.length}`);
        event.added.forEach(folder =>
            discoverTests(controller, folder.uri, getOrCreateTag)
        );
    });

    vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.fsPath.endsWith('.4dm')) {
            dbg(`onDidChangeTextDocument: ${event.document.uri.fsPath} (root items: ${countItems(controller.items)})`);
            controller.invalidateTestResults();
            discoverTests(controller, event.document.uri, getOrCreateTag);
        }
    });

    vscode.workspace.onDidCreateFiles(event => {
        event.files.forEach(file => {
            if (file.fsPath.endsWith('.4dm')) {
                dbg(`onDidCreateFiles: ${file.fsPath}`);
                discoverTests(controller, file, getOrCreateTag);
            }
        });
    });
}

// Discover all 4D test files
async function discoverTests(
    controller: vscode.TestController,
    rootUri: vscode.Uri,
    getOrCreateTag: (name: string) => vscode.TestTag
) {
    discoveryGeneration++;
    const gen = discoveryGeneration;
    dbg(`discoverTests called (gen=${gen}): ${rootUri.fsPath}`);
    try {
        let files: vscode.Uri[];
        if (rootUri.toString().endsWith('.4dm')) {
            files = [rootUri];
            dbg(`  single file mode`);
        } else {
            const pattern = new vscode.RelativePattern(
                vscode.Uri.joinPath(rootUri, 'Project', 'Sources', 'Classes'),
                '*Test.4dm'
            );
            files = await vscode.workspace.findFiles(pattern);
            dbg(`  found ${files.length} *Test.4dm files`);
        }

        // Remove all existing root items so VS Code drops cached result state
        const staleIds: string[] = [];
        controller.items.forEach(item => staleIds.push(item.id));
        for (const id of staleIds) {
            controller.items.delete(id);
        }
        dbg(`  cleared ${staleIds.length} stale root items`);

        for (const file of files) {
            const id = `g${gen}:${file.fsPath}`;
            const testItem = controller.createTestItem(
                id,
                file.path.split('/').pop()!,
                file
            );
            controller.items.add(testItem);
            testData.set(testItem, { kind: 'file' });
            dbg(`  added file item: ${file.path.split('/').pop()!} (children before updateFromDisk: ${countItems(testItem.children)})`);

            await updateFromDisk(controller, testItem, getOrCreateTag, gen);
            dbg(`  after updateFromDisk: ${file.path.split('/').pop()!} has ${countItems(testItem.children)} children`);
        }
        dbg(`  root items after discovery: ${countItems(controller.items)}`);
    } catch (err: any) {
        dbg(`  ERROR in discoverTests: ${err?.message ?? err}`);
        console.error('Error discovering 4D tests:', err);
    }
}

// Run all tests or selected
async function runTests(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    const testItems: vscode.TestItem[] = [];

    if (request.include) {
        request.include.forEach(item => testItems.push(item));
    } else {
        controller.items.forEach(item => testItems.push(item));
    }

    if (testItems.length === 0) return;

    await startTestRun(controller, request, token);
}

// Run tests filtered by tag
async function runTestsByTag(
    controller: vscode.TestController,
    tagName: string,
    token: vscode.CancellationToken,
    profile: vscode.TestRunProfile
) {
    const testItems: vscode.TestItem[] = [];

    const walk = (item: vscode.TestItem) => {
        if (item.tags.some(tag => tag.id === tagName)) {
            testItems.push(item);
        }
        item.children.forEach(c => walk(c));
    };

    controller.items.forEach(c => walk(c));

    if (testItems.length === 0) return;

    const fakeRequest: vscode.TestRunRequest = {
        include: testItems,
        exclude: [],
        profile: profile,
        preserveFocus: false
    };

    await startTestRun(controller, fakeRequest, token);
}

export function deactivate() {}
