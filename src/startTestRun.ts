import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { mapFunctionLineToSourceLine } from './parser';

export async function startTestRun(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    const run = controller.createTestRun(request);

    const queue: vscode.TestItem[] = [];
    const isRunningAllTests = !request.include;

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
        } else if (!isRunningAllTests) {
            // Only specify tests if not running all tests
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

            makeProcess.on('close', async () => {
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

                        await handleResults(results, run, testTargets, controller);
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

async function handleResults(
    results: any,
    run: vscode.TestRun,
    testTargets: { suite: string; func: string; item: vscode.TestItem }[],
    controller: vscode.TestController
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

        // Clear any existing assertion children from previous runs
        const assertionItems: vscode.TestItem[] = [];

        // Create a TestItem for each assertion
        if (testResult.assertions && testResult.assertions.length > 0) {
            for (let index = 0; index < testResult.assertions.length; index++) {
                const assertion = testResult.assertions[index];

                // Use the assertion message as the label for the test tree
                let label = assertion.message || `Assertion ${index + 1}`;

                // Truncate if too long
                if (label.length > 80) {
                    label = label.substring(0, 77) + '...';
                }

                // Create the assertion test item
                const assertionId = `${funcItem.id}/assertion-${index}`;
                const assertionItem = controller.createTestItem(assertionId, label, funcItem.uri);

                // Map the line number to get the exact location
                if (assertion.line && assertion.functionName && funcItem.uri) {
                    const sourceLine = await mapFunctionLineToSourceLine(
                        funcItem.uri,
                        assertion.functionName,
                        assertion.line
                    );

                    if (sourceLine !== null) {
                        const position = new vscode.Position(sourceLine, 0);
                        const range = new vscode.Range(position, position);
                        assertionItem.range = range;
                    }
                }

                // Add to the function's children
                assertionItems.push(assertionItem);

                // Mark the assertion as started
                run.started(assertionItem);

                // Mark as passed or failed
                if (assertion.passed) {
                    run.passed(assertionItem);
                } else {
                    // Build detailed failure message for this assertion
                    // Show both expected and actual on first line for inline flag
                    const expectedStr = JSON.stringify(assertion.expected);
                    const actualStr = JSON.stringify(assertion.actual);
                    const failureLines: string[] = [
                        `Expected: ${expectedStr}, Actual: ${actualStr}`
                    ];

                    // Add the original assertion message if available
                    if (assertion.message) {
                        failureLines.push(`\nAssertion: ${assertion.message}`);
                    }

                    const message = new vscode.TestMessage(failureLines.join('\n'));

                    // Set location if we have it
                    if (assertionItem.range && funcItem.uri) {
                        message.location = new vscode.Location(funcItem.uri, assertionItem.range);
                    }

                    run.failed(assertionItem, message);
                }
            }
        }

        // Replace the function's children with the new assertion items
        funcItem.children.replace(assertionItems);

        // Mark the parent function based on overall result
        if (testResult.passed) {
            run.passed(funcItem, testResult.duration ?? 0);
        } else {
            // Build a summary message for the parent function
            const failedCount = testResult.assertions.filter((a: any) => !a.passed).length;
            const summaryMessage = `${failedCount} of ${testResult.assertionCount} assertions failed`;

            run.failed(funcItem, new vscode.TestMessage(summaryMessage), testResult.duration ?? 0);
        }
    }
}
