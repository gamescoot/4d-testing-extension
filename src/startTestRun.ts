import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { testData, TestCase } from './testTree';

export async function startTestRun(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    const run = controller.createTestRun(request);

    const queue: vscode.TestItem[] = [];

    if (request.include) {
        for (const test of request.include) {
            // Climb up until the parent is a direct child of the root (file)
            let current: vscode.TestItem = test;
            while (current.parent && current.parent.parent) {
                current = current.parent;
            }
            queue.push(current);
        }
    } else {
        controller.items.forEach(test => queue.push(test));
    }

    const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Collect class + function combos to run
    const testTargets: { suite: string; func: string }[] = [];

    while (queue.length > 0 && !token.isCancellationRequested) {
        const test = queue.pop()!;
        const data = testData.get(test);

        if (data instanceof TestCase) {
            // Start test immediately
            run.started(test);

            const fileName = test.uri?.path.split('/').pop() ?? '';
            const suite = fileName.replace(/\.4dm$/, '');
            const parent = test.parent;
            const func = parent?.label ?? '';

            testTargets.push({ suite, func });
        }

        // Recursively start children immediately
        test.children.forEach(child => {
            const childData = testData.get(child);
            if (childData instanceof TestCase) {
                run.started(child);
            }
            queue.push(child);
        });
    }

    if (testTargets.length > 0) {
        // Deduplicate by suite+func
        const uniqueTargets = Array.from(
            new Set(testTargets.map(t => `${t.suite}.${t.func}`))
        );

        const cmdArgs = ['test', 'format=json'];

        // If profile has tag, include tag param
        const profileTag = (request.profile?.label?.match(/Run '(.+)' tests/) || [])[1];
        if (profileTag) {
            cmdArgs.push(`tag=${profileTag}`);
        } else {
            cmdArgs.push(`test=${uniqueTargets.join(',')}`);
        }

        run.appendOutput(`Spawning: make ${cmdArgs.join(' ')}\n`);

        await new Promise<void>(resolve => {
            const makeProcess = spawn('make', cmdArgs, { cwd: workspaceFolder });

            let output = '';

            makeProcess.stdout?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (
                        line.startsWith('/Applications/Xcode.app') ||
                        line.startsWith("tool4d.APPL Cooperative process doesn't yield enough")
                    ) {
                        return;
                    }
                    output += line + '\n';
                });
            });

            makeProcess.stderr?.on('data', (data: Buffer) => {
                run.appendOutput(data.toString());
            });

            makeProcess.on('close', () => {
                try {
                    if (output.trim().length > 0) {
                        const results = JSON.parse(output);

                        // Pretty JSON, fixed header
                        const pretty = JSON.stringify(results, null, 2);
                        const prettyOutput = `\n=== Test Results (JSON) ===\n${pretty}\n`;
                        const normalized = prettyOutput.replace(/^/gm, '\r');

                        run.appendOutput("\n" + normalized + "\n");

                        handleResults(results, run, controller);
                    }
                } catch (err: any) {
                    run.appendOutput(`Error parsing JSON: ${err.message}\n`);
                }
                resolve();
            });
        });
    }

    run.end();
}

function handleResults(results: any, run: vscode.TestRun, controller: vscode.TestController) {
    if (!results.testResults) return;

    for (const suiteResult of results.testResults) {
        const classItem = controller.items.get(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath +
            '/Project/Sources/Classes/' +
            suiteResult.suite +
            '.4dm'
        );
        if (!classItem) continue;

        // Find the function heading
        const funcItem = [...classItem.children].find(([_, t]) => t.label === suiteResult.name)?.[1];
        if (!funcItem) continue;

        for (const assertion of suiteResult.assertions) {
            const testCase = [...funcItem.children].find(([_, tc]) => {
                const data = testData.get(tc);
                return data instanceof TestCase && data.should === assertion.message;
            })?.[1];

            if (!testCase) continue;

            run.started(testCase);
            if (assertion.passed) {
                run.passed(testCase, assertion.duration ?? 0);
            } else {
                run.failed(
                    testCase,
                    new vscode.TestMessage(
                        `actual: ${assertion.actual} expected: ${assertion.expected}\n${assertion.message}`
                    ),
                    assertion.duration ?? 0
                );
            }
        }
    }
}
