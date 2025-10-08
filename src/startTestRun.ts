import * as vscode from 'vscode';
import { spawn } from 'child_process';

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
    const testTargets: { suite: string; func: string; item: vscode.TestItem }[] = [];

    while (queue.length > 0 && !token.isCancellationRequested) {
        const test = queue.pop()!;

        // If this is a test function (starts with test_), track it
        if (test.label?.startsWith('test_')) {
            run.started(test);

            const fileName = test.uri?.path.split('/').pop() ?? '';
            const suite = fileName.replace(/\.4dm$/, '');
            const func = test.label;

            testTargets.push({ suite, func, item: test });
        }

        // Recursively process children
        test.children.forEach(child => {
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
                        // Extract JSON from output - find first { and last }
                        const firstBrace = output.indexOf('{');
                        const lastBrace = output.lastIndexOf('}');

                        if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
                            run.appendOutput(`Could not find valid JSON in output\n`);
                            resolve();
                            return;
                        }

                        const jsonStr = output.substring(firstBrace, lastBrace + 1);
                        const results = JSON.parse(jsonStr);

                        // Pretty JSON, fixed header
                        const pretty = JSON.stringify(results, null, 2);
                        const prettyOutput = `\n=== Test Results (JSON) ===\n${pretty}\n`;
                        const normalized = prettyOutput.replace(/^/gm, '\r');

                        run.appendOutput("\n" + normalized + "\n");

                        handleResults(results, run, testTargets);
                    }
                } catch (err: any) {
                    run.appendOutput(`Error parsing JSON: ${err.message}\n`);
                    run.appendOutput(`Output was:\n${output}\n`);
                }
                resolve();
            });
        });
    }

    run.end();
}

function handleResults(
    results: any,
    run: vscode.TestRun,
    testTargets: { suite: string; func: string; item: vscode.TestItem }[]
) {
    if (!results.testResults) return;

    for (const testResult of results.testResults) {
        // Find the TestItem for this test function
        const target = testTargets.find(
            t => t.suite === testResult.suite && t.func === testResult.name
        );

        if (!target) {
            run.appendOutput(
                `Warning: Could not find TestItem for ${testResult.suite}.${testResult.name}\n`
            );
            continue;
        }

        const funcItem = target.item;

        // Check if test passed or failed
        if (testResult.passed) {
            run.passed(funcItem, testResult.duration ?? 0);
        } else {
            // Build failure message with all relevant details
            const failureLines: string[] = [];

            // Add failure reason from results.failures (includes subtest name for table-driven tests)
            if (results.failures) {
                const failure = results.failures.find(
                    (f: any) => f.suite === testResult.suite && f.test === testResult.name
                );
                if (failure && failure.reason) {
                    failureLines.push(`Failed: ${failure.reason}\n`);
                }
            }

            // Add details of failed assertions
            const failedAssertions = testResult.assertions.filter((a: any) => !a.passed);
            if (failedAssertions.length > 0) {
                failureLines.push(`\nFailed assertions (${failedAssertions.length}):\n`);
                failedAssertions.forEach((assertion: any, index: number) => {
                    failureLines.push(`\n[${index + 1}] ${assertion.message || '(no message)'}`);
                    failureLines.push(`  Expected: ${JSON.stringify(assertion.expected)}`);
                    failureLines.push(`  Actual: ${JSON.stringify(assertion.actual)}`);
                    if (assertion.line) {
                        failureLines.push(`  Line: ${assertion.line}`);
                    }
                });
            }

            // Add summary of all assertions
            failureLines.push(
                `\n\nSummary: ${testResult.assertionCount} assertions ` +
                `(${testResult.assertions.filter((a: any) => a.passed).length} passed, ` +
                `${failedAssertions.length} failed)`
            );

            run.failed(funcItem, new vscode.TestMessage(failureLines.join('\n')), testResult.duration ?? 0);
        }
    }
}
