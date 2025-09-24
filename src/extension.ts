import * as vscode from 'vscode';
import { startTestRun } from './startTestRun';
import { updateFromDisk, testData } from './testTree';

export function activate(context: vscode.ExtensionContext) {
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

    // Discover tests when workspace opens or folders change
    if (vscode.workspace.workspaceFolders) {
        vscode.workspace.workspaceFolders.forEach(folder =>
            discoverTests(controller, folder.uri, getOrCreateTag)
        );
    }

    vscode.workspace.onDidChangeWorkspaceFolders(event => {
        event.added.forEach(folder =>
            discoverTests(controller, folder.uri, getOrCreateTag)
        );
    });

    vscode.workspace.onDidChangeTextDocument(event => {
        discoverTests(controller, event.document.uri, getOrCreateTag);
    });
}

// Discover all 4D test files
async function discoverTests(
    controller: vscode.TestController,
    rootUri: vscode.Uri,
    getOrCreateTag: (name: string) => vscode.TestTag
) {
    try {
        let files: vscode.Uri[];
        if (rootUri.toString().endsWith('.4dm')) {
            files = [rootUri];
        } else {
            const pattern = new vscode.RelativePattern(
                vscode.Uri.joinPath(rootUri, 'Project', 'Sources', 'Classes'),
                '*Test.4dm'
            );
            files = await vscode.workspace.findFiles(pattern);
        }

        for (const file of files) {
            const id = file.fsPath;
            const testItem = controller.createTestItem(
                id,
                file.path.split('/').pop()!,
                file
            );
            controller.items.add(testItem);
            testData.set(testItem, { kind: 'file' });

            await updateFromDisk(controller, testItem, getOrCreateTag);
        }
    } catch (err) {
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
