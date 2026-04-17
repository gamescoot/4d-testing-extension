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

    if (results.hasGlobalErrors && results.globalErrors?.length > 0) {
        run.appendOutput('\r\n⚠ Global Runtime Errors (outside test processes):\r\n');
        for (const err of results.globalErrors) {
            const code = err.code ?? '?';
            const process = err.processNumber ?? '?';
            const method = err.text || 'Unknown location';
            const msg = err.message || err.method || '';
            const line = err.line != null ? ` line ${err.line}` : '';
            run.appendOutput(`  [${code}] Process ${process}: ${method}${line}\r\n`);
            if (msg) {
                run.appendOutput(`    ${msg}\r\n`);
            }
        }
        run.appendOutput('\r\n');
    }

    for (const testResult of results.testResults) {
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

        // Pass 1: create assertion items and set their ranges
        const assertionItems: vscode.TestItem[] = [];

        if (testResult.assertions && testResult.assertions.length > 0) {
            for (let index = 0; index < testResult.assertions.length; index++) {
                const assertion = testResult.assertions[index];

                let label: string;
                if (assertion.isRuntimeError) {
                    label = `⚠ ${assertion.message || 'Runtime error'}`;
                } else {
                    label = assertion.message || `Assertion ${index + 1}`;
                }

                if (label.length > 80) {
                    label = label.substring(0, 77) + '...';
                }

                const assertionId = `${funcItem.id}/assertion-${index}`;
                const assertionItem = controller.createTestItem(assertionId, label, funcItem.uri);

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

                if (!assertionItem.range && funcItem.range) {
                    assertionItem.range = funcItem.range;
                }

                assertionItems.push(assertionItem);
            }
        }

        // Attach items to the tree before setting run states
        funcItem.children.replace(assertionItems);

        // Pass 2: set run states now that items are in the tree
        if (testResult.assertions && testResult.assertions.length > 0) {
            for (let index = 0; index < testResult.assertions.length; index++) {
                const assertion = testResult.assertions[index];
                const assertionItem = assertionItems[index];

                run.started(assertionItem);

                if (assertion.passed) {
                    run.passed(assertionItem);
                } else {
                    const failureLines: string[] = [];

                    if (assertion.isRuntimeError) {
                        failureLines.push(assertion.actual || 'Runtime error occurred');
                        if (assertion.message) {
                            failureLines.push(`\n${assertion.message}`);
                        }
                    } else {
                        const expectedStr = JSON.stringify(assertion.expected);
                        const actualStr = JSON.stringify(assertion.actual);
                        failureLines.push(`Expected: ${expectedStr}, Actual: ${actualStr}`);
                        if (assertion.message) {
                            failureLines.push(`\nAssertion: ${assertion.message}`);
                        }
                    }

                    const message = new vscode.TestMessage(failureLines.join('\n'));

                    if (assertionItem.range && funcItem.uri) {
                        message.location = new vscode.Location(funcItem.uri, assertionItem.range);
                    }

                    run.failed(assertionItem, message);
                }
            }
        }

        if (testResult.skipped) {
            run.skipped(funcItem);
        } else if (testResult.passed) {
            run.passed(funcItem, testResult.duration ?? 0);
        } else {
            const summaryParts: string[] = [];

            if (testResult.runtimeErrors?.length > 0) {
                const err = testResult.runtimeErrors[0];
                const errMsg = err.message || err.method || `Error ${err.code}`;
                summaryParts.push(`Runtime error: [${err.code}] ${errMsg}`);
                if (err.text) {
                    summaryParts.push(`Location: ${err.text}`);
                }
                if (err.line != null) {
                    summaryParts.push(`Line: ${err.line}`);
                }
            } else {
                const failedCount = testResult.assertions?.filter((a: any) => !a.passed).length ?? 0;
                summaryParts.push(`${failedCount} of ${testResult.assertionCount} assertions failed`);
            }

            if (testResult.callChain?.length > 0) {
                summaryParts.push('');
                summaryParts.push('Call Stack:');
                for (let i = 0; i < testResult.callChain.length; i++) {
                    const frame = testResult.callChain[i];
                    let frameLine = `  ${i + 1}. ${frame.name || '<unnamed>'}`;
                    if (frame.type) { frameLine += ` (${frame.type})`; }
                    if (frame.line != null) { frameLine += ` at line ${frame.line}`; }
                    if (frame.database) { frameLine += ` in ${frame.database}`; }
                    summaryParts.push(frameLine);
                }
            }

            const summaryMsg = new vscode.TestMessage(summaryParts.join('\n'));
            if (testResult.runtimeErrors?.length > 0) {
                run.errored(funcItem, summaryMsg, testResult.duration ?? 0);
            } else {
                run.failed(funcItem, summaryMsg, testResult.duration ?? 0);
            }
        }
    }
}
